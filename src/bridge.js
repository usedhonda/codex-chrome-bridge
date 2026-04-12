#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function envOrDefault(name, fallback) {
  return process.env[name] || fallback;
}

function envInt(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const HOME = os.homedir();
const USER = os.userInfo().username;
const CLIENT_ID = 'codex-chrome-bridge';
const SOCKET_ROOT = envOrDefault(
  'CLAUDE_BRIDGE_SOCKET_ROOT',
  path.join('/tmp', `claude-mcp-browser-bridge-${USER}`),
);
const MANIFEST_PATH = envOrDefault(
  'CLAUDE_BRIDGE_MANIFEST_PATH',
  path.join(
    HOME,
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts',
    'com.anthropic.claude_code_browser_extension.json',
  ),
);
const LAUNCHER_PATH = envOrDefault(
  'CLAUDE_BRIDGE_LAUNCHER_PATH',
  path.join(HOME, '.claude', 'chrome', 'chrome-native-host'),
);
const DISCOVERY_TIMEOUT_MS = envInt('CLAUDE_BRIDGE_DISCOVERY_TIMEOUT_MS', 5000);
const TOOL_TIMEOUT_MS = envInt('CLAUDE_BRIDGE_TOOL_TIMEOUT_MS', 15000);
const MCP_TOOL_CALL_TIMEOUT_MS = envInt(
  'CLAUDE_BRIDGE_MCP_TOOL_CALL_TIMEOUT_MS',
  Math.max(TOOL_TIMEOUT_MS + 5000, 20000),
);
const MCP_TRACE_PATH = process.env.CLAUDE_BRIDGE_MCP_TRACE_PATH || null;
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SESSION_SCOPE = {
  sessionId: `codex-bridge-${process.pid}-${Date.now().toString(36)}`,
  displayName: 'Codex (MCP)',
};
const SHARED_IMAGE_CACHE = new Map();
const MAX_SHARED_IMAGE_CACHE_ENTRIES = 24;

class BridgeError extends Error {
  constructor(stage, message, detail = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.stage = stage;
    this.detail = detail;
  }
}

function traceMcp(direction, payload) {
  if (!MCP_TRACE_PATH) {
    return;
  }

  try {
    fs.appendFileSync(
      MCP_TRACE_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        direction,
        payload,
      })}\n`,
      'utf8',
    );
  } catch {
    // Trace logging must never interfere with the MCP transport.
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MANIFEST_PATH = path.join(
  HOME,
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts',
  'com.anthropic.claude_code_browser_extension.json',
);
const DEFAULT_LAUNCHER_PATH = path.join(HOME, '.claude', 'chrome', 'chrome-native-host');

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  return text ? JSON.parse(text) : null;
}

async function execText(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });

  return stdout;
}

async function statSocket(filePath) {
  try {
    const stat = await fsp.lstat(filePath);
    return stat.isSocket() ? stat : null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function parseLauncherTarget(scriptText) {
  if (!scriptText) {
    return null;
  }

  const quoted = scriptText.match(/exec\s+"([^"]+)"\s+--chrome-native-host/);
  if (quoted) {
    return quoted[1];
  }

  const unquoted = scriptText.match(/exec\s+(\S+)\s+--chrome-native-host/);
  return unquoted ? unquoted[1] : null;
}

function parseVersionFromBinary(binaryPath) {
  const match = binaryPath?.match(/\/versions\/([^/]+)$/);
  return match ? match[1] : null;
}

function mimeTypeFromPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const known = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
  };
  return known[extension] ?? 'application/octet-stream';
}

async function discoverHostProcesses() {
  const stdout = await execText('ps', ['-axo', 'pid=,ppid=,command=']);
  const lines = stdout.split('\n').filter(Boolean);
  const hostLines = lines.filter((line) => line.includes('--chrome-native-host'));
  const processes = [];

  for (const line of hostLines) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const command = match[3];
    const binaryPath = command.replace(/\s+--chrome-native-host(?:\s+.*)?$/, '');
    const socketPath = path.join(SOCKET_ROOT, `${pid}.sock`);
    const socketStat = await statSocket(socketPath);

    processes.push({
      pid,
      ppid,
      command,
      binaryPath,
      binaryVersion: parseVersionFromBinary(binaryPath),
      socketPath,
      socketExists: Boolean(socketStat),
    });
  }

  return processes.sort((a, b) => b.pid - a.pid);
}

async function discoverEnvironment() {
  const [manifest, launcherScript, processes] = await Promise.all([
    readJsonIfExists(MANIFEST_PATH),
    readTextIfExists(LAUNCHER_PATH),
    discoverHostProcesses(),
  ]);

  const launcherTarget = parseLauncherTarget(launcherScript);
  const selectedProcess =
    processes.find((entry) => entry.socketExists) ?? processes[0] ?? null;
  const warnings = [];

  if (!manifest) {
    warnings.push('chrome_manifest_missing');
  }
  if (MANIFEST_PATH !== DEFAULT_MANIFEST_PATH) {
    warnings.push('manifest_path_overridden');
  }

  if (!launcherScript) {
    warnings.push('launcher_script_missing');
  }
  if (LAUNCHER_PATH !== DEFAULT_LAUNCHER_PATH) {
    warnings.push('launcher_path_overridden');
  }

  if (!selectedProcess) {
    warnings.push('native_host_process_missing');
  }

  if (selectedProcess && !selectedProcess.socketExists) {
    warnings.push('socket_missing_for_selected_process');
  }

  if (
    launcherTarget &&
    selectedProcess?.binaryPath &&
    launcherTarget !== selectedProcess.binaryPath
  ) {
    warnings.push('launcher_target_differs_from_live_host');
  }

  return {
    manifestPath: MANIFEST_PATH,
    launcherPath: LAUNCHER_PATH,
    launcherTarget,
    launcherVersion: parseVersionFromBinary(launcherTarget),
    manifest,
    processes,
    selectedProcess,
    warnings,
  };
}

function summarizeContent(content = []) {
  return content.map((item) => {
    if (item.type === 'text') {
      return item.text;
    }

    if (item.type === 'image') {
      const mediaType = item.source?.media_type ?? 'unknown';
      return `[image:${mediaType}]`;
    }

    return `[${item.type ?? 'unknown'}]`;
  });
}

function findStructuredJson(content = []) {
  for (const item of content) {
    if (item.type !== 'text') {
      continue;
    }

    const trimmed = item.text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      continue;
    }

    const parsed = safeJsonParse(trimmed);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function extractTextItems(content = []) {
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text);
}

function extractPrimaryText(content = []) {
  return extractTextItems(content)[0] ?? null;
}

function normalizeToolContent(content = []) {
  const structured = findStructuredJson(content);
  if (structured !== null) {
    return structured;
  }

  const texts = extractTextItems(content);
  if (texts.length === 0) {
    return null;
  }

  return texts.length === 1 ? texts[0] : texts;
}

function extractImageItem(content = []) {
  for (const item of content) {
    if (item?.type !== 'image' || !item.source?.data) {
      continue;
    }

    return {
      mediaType: item.source.media_type ?? 'image/png',
      base64: item.source.data,
    };
  }

  return null;
}

function extractImageIdFromContent(content = []) {
  for (const item of content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }

    const match = item.text.match(/\bID:\s*([A-Za-z0-9_-]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function extractTabGroupIdFromContent(content = []) {
  const structured = findStructuredJson(content);
  if (Number.isFinite(structured?.tabGroupId)) {
    return Number(structured.tabGroupId);
  }

  return null;
}

function contentSignalsMissingTabGroup(content = []) {
  const texts = extractTextItems(content);
  return texts.some(
    (text) =>
      text.includes('No tab group exists for this session') ||
      text.includes('No MCP tab groups found'),
  );
}

function responseSignalsTabsBusy(response) {
  const text = response?.error?.content;
  return (
    typeof text === 'string' &&
    text.includes('Tabs cannot be edited right now')
  );
}

function toolSupportsSessionContextRecovery(tool) {
  return tool !== 'tabs_context_mcp';
}

function extractScreenshotMetadata(content = []) {
  for (const item of content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }

    const match = item.text.match(
      /Successfully captured screenshot \((\d+)x(\d+),\s*([^)]+)\)\s*-\s*ID:\s*([A-Za-z0-9_-]+)/i,
    );
    if (!match) {
      continue;
    }

    return {
      width: Number.parseInt(match[1], 10),
      height: Number.parseInt(match[2], 10),
      format: match[3],
      imageId: match[4],
    };
  }

  return null;
}

function cacheImageEntry(imageId, entry, store = SHARED_IMAGE_CACHE) {
  if (!imageId || !entry?.base64) {
    return;
  }

  if (store.has(imageId)) {
    store.delete(imageId);
  }

  store.set(imageId, {
    ...entry,
    cachedAt: new Date().toISOString(),
  });

  while (store.size > MAX_SHARED_IMAGE_CACHE_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (!oldestKey) {
      break;
    }
    store.delete(oldestKey);
  }
}

function encodeFileArtifact(filePath) {
  const buffer = fs.readFileSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    mediaType: mimeTypeFromPath(filePath),
    base64: buffer.toString('base64'),
  };
}

function writeTempArtifact(fileEntry, preferredName = null) {
  const extension = path.extname(preferredName || fileEntry.name || fileEntry.path || '') || '';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-upload-'));
  const tempName = preferredName || fileEntry.name || `upload${extension || ''}`;
  const tempPath = path.join(tempDir, tempName);
  fs.writeFileSync(tempPath, Buffer.from(fileEntry.base64, 'base64'));
  return tempPath;
}

function buildUploadScript({
  files,
  ref = null,
  selector = null,
  coordinate = null,
  allowDrop = false,
}) {
  const payload = {
    files,
    ref,
    selector,
    coordinate,
    allowDrop,
  };

  return `(() => {
    const payload = ${JSON.stringify(payload)};
    const decodeFile = (entry) => {
      const binary = atob(entry.base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: entry.mediaType || 'application/octet-stream' });
      return new File([blob], entry.name, {
        type: entry.mediaType || 'application/octet-stream',
        lastModified: Date.now(),
      });
    };
    const files = payload.files.map(decodeFile);
    const transfer = new DataTransfer();
    for (const file of files) {
      transfer.items.add(file);
    }

    const resolveRefTarget = (ref) => {
      const map = window.__claudeElementMap;
      if (!map?.[ref]) {
        return { error: 'Element ref not found: "' + ref + '"' };
      }
      const node = map[ref].deref() || null;
      if (!node || !document.contains(node)) {
        delete map[ref];
        return { error: 'Element is no longer in the document: "' + ref + '"' };
      }
      return { node };
    };

    const resolveCoordinateTarget = (coordinate) => {
      let node = document.elementFromPoint(coordinate[0], coordinate[1]);
      if (!node) {
        return { error: 'No element found at coordinates (' + coordinate[0] + ', ' + coordinate[1] + ')' };
      }
      if (node.tagName === 'IFRAME') {
        try {
          const frameRect = node.getBoundingClientRect();
          const innerDoc = node.contentDocument || node.contentWindow?.document || null;
          if (innerDoc) {
            const innerNode = innerDoc.elementFromPoint(
              coordinate[0] - frameRect.left,
              coordinate[1] - frameRect.top,
            );
            if (innerNode) {
              node = innerNode;
            }
          }
        } catch {
          // Fall back to the iframe element when same-origin access is unavailable.
        }
      }
      return { node };
    };

    const resolveSelectorTarget = (selector) => {
      const node = document.querySelector(selector);
      if (!node) {
        return { error: 'No element matched selector: ' + selector };
      }
      return { node };
    };

    let resolved = null;
    if (payload.ref) {
      resolved = resolveRefTarget(payload.ref);
    } else if (payload.selector) {
      resolved = resolveSelectorTarget(payload.selector);
    } else if (payload.coordinate) {
      resolved = resolveCoordinateTarget(payload.coordinate);
    } else {
      return JSON.stringify({
        ok: false,
        error: 'Neither ref, selector, nor coordinate was provided',
      });
    }

    if (resolved.error) {
      return JSON.stringify({ ok: false, error: resolved.error });
    }

    const target = resolved.node;
    target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

    if (target.tagName === 'INPUT' && target.type === 'file') {
      target.files = transfer.files;
      target.focus();
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(
        new CustomEvent('filechange', { bubbles: true, detail: { files: transfer.files } }),
      );
      return JSON.stringify({
        ok: true,
        mode: 'file_input',
        fileNames: Array.from(transfer.files).map((file) => file.name),
      });
    }

    if (!payload.allowDrop) {
      return JSON.stringify({
        ok: false,
        error:
          'Target is not a file input. Use coordinate upload or a file-input ref.',
      });
    }

    const rect = target.getBoundingClientRect();
    const x = payload.coordinate ? payload.coordinate[0] : rect.left + rect.width / 2;
    const y = payload.coordinate ? payload.coordinate[1] : rect.top + rect.height / 2;
    const dragOptions = {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
    };
    target.focus();
    target.dispatchEvent(new DragEvent('dragenter', dragOptions));
    target.dispatchEvent(new DragEvent('dragover', dragOptions));
    target.dispatchEvent(new DragEvent('drop', dragOptions));
    return JSON.stringify({
      ok: true,
      mode: 'drop',
      coordinate: [Math.round(x), Math.round(y)],
      fileNames: Array.from(transfer.files).map((file) => file.name),
    });
  })()`;
}

function extractTabIdFromContent(content = []) {
  for (const item of content) {
    if (item.type !== 'text') {
      continue;
    }

    const match = item.text.match(/Tab ID:\s*(\d+)/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return null;
}

function findTabInContext(browserContext, tabId) {
  const availableTabs = Array.isArray(browserContext?.availableTabs)
    ? browserContext.availableTabs
    : [];

  return (
    availableTabs.find((tab) => Number(tab?.tabId) === Number(tabId)) ?? null
  );
}

function selectTabsInContext(browserContext, selector) {
  const availableTabs = Array.isArray(browserContext?.availableTabs)
    ? browserContext.availableTabs
    : [];

  if (Number.isFinite(selector?.tabId)) {
    return availableTabs.filter(
      (tab) => Number(tab?.tabId) === Number(selector.tabId),
    );
  }

  if (typeof selector?.url === 'string' && selector.url.length > 0) {
    return availableTabs.filter((tab) => String(tab?.url ?? '') === selector.url);
  }

  return [];
}

function normalizeCoordinate(input) {
  if (Array.isArray(input?.coordinate) && input.coordinate.length === 2) {
    return [
      Number.parseFloat(input.coordinate[0]),
      Number.parseFloat(input.coordinate[1]),
    ];
  }

  if (Number.isFinite(input?.x) && Number.isFinite(input?.y)) {
    return [Number(input.x), Number(input.y)];
  }

  throw new BridgeError(
    'tool_call',
    'coordinate or x/y is required for this tool',
  );
}

function normalizeOptionalCoordinate(input) {
  if (
    (Array.isArray(input?.coordinate) && input.coordinate.length === 2) ||
    (Number.isFinite(input?.x) && Number.isFinite(input?.y))
  ) {
    return normalizeCoordinate(input);
  }

  return null;
}

function normalizeStartCoordinate(input) {
  if (
    Array.isArray(input?.startCoordinate) &&
    input.startCoordinate.length === 2
  ) {
    return [
      Number.parseFloat(input.startCoordinate[0]),
      Number.parseFloat(input.startCoordinate[1]),
    ];
  }

  if (Number.isFinite(input?.startX) && Number.isFinite(input?.startY)) {
    return [Number(input.startX), Number(input.startY)];
  }

  if (
    Array.isArray(input?.start_coordinate) &&
    input.start_coordinate.length === 2
  ) {
    return [
      Number.parseFloat(input.start_coordinate[0]),
      Number.parseFloat(input.start_coordinate[1]),
    ];
  }

  return null;
}

function normalizeRegion(input) {
  if (!Array.isArray(input?.region) || input.region.length !== 4) {
    throw new BridgeError('tool_call', 'region is required for this tool');
  }

  return input.region.map((value) => Number.parseFloat(value));
}

class NativeBridgeClient {
  constructor(socketPath, clientId = CLIENT_ID, options = {}) {
    this.socketPath = socketPath;
    this.clientId = clientId;
    this.sessionScope = options.sessionScope ?? null;
  }

  executeTool(tool, args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let timer = null;
      let buffer = Buffer.alloc(0);
      let resolved = false;
      const requestArgs =
        this.sessionScope && Number.isFinite(this.sessionScope.tabGroupId)
          ? {
              ...(args ?? {}),
              ...(
                Number.isFinite(args?.tabGroupId)
                  ? {}
                  : { tabGroupId: Number(this.sessionScope.tabGroupId) }
              ),
            }
          : args;

      const finish = (callback) => {
        if (resolved) {
          return;
        }

        resolved = true;

        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        socket.removeAllListeners();
        socket.end();
        callback();
      };

      timer = setTimeout(() => {
        socket.destroy();
        reject(new BridgeError('connect', `timeout waiting for ${tool}`));
      }, timeoutMs);

      socket.on('connect', () => {
        const payload = Buffer.from(
          JSON.stringify({
            method: 'execute_tool',
            params: {
              client_id: this.clientId,
              tool,
              args: requestArgs,
              ...(this.sessionScope ? { session_scope: this.sessionScope } : {}),
            },
          }),
        );
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(payload.length, 0);
        socket.write(Buffer.concat([prefix, payload]));
      });

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (buffer.length < 4) {
          return;
        }

        const payloadLength = buffer.readUInt32LE(0);
        if (buffer.length < payloadLength + 4) {
          return;
        }

        const payload = buffer.subarray(4, payloadLength + 4).toString('utf8');
        const parsed = safeJsonParse(payload);

        if (!parsed) {
          finish(() => {
            reject(new BridgeError('response_parse', 'bridge returned invalid JSON'));
          });
          return;
        }

        finish(() => resolve(parsed));
      });

      socket.on('error', (error) => {
        finish(() => reject(new BridgeError('connect', error.message)));
      });
    });
  }
}

function uniqueWarnings(warnings = []) {
  return [...new Set(warnings)];
}

function isMissingTabGroupError(error) {
  if (!error || error.name !== 'BridgeError') {
    return false;
  }

  const message = String(error.message ?? '');
  return message.includes('No MCP tab group exists');
}

async function probeCandidateSocket(candidate, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const client = new NativeBridgeClient(candidate.socketPath, `${CLIENT_ID}-discovery`);

  try {
    const response = await client.executeTool(
      'tabs_context_mcp',
      { createIfEmpty: false },
      timeoutMs,
    );

    if (response.error) {
      return {
        ok: false,
        pid: candidate.pid,
        socketPath: candidate.socketPath,
        stage: 'tool_call',
        reason: response.error.content ?? 'candidate returned tool error',
      };
    }

    const result = response.result ?? response;
    return {
      ok: true,
      pid: candidate.pid,
      socketPath: candidate.socketPath,
      result,
      status_payload: findStructuredJson(result.content),
      status_summary: summarizeContent(result.content),
    };
  } catch (error) {
    return {
      ok: false,
      pid: candidate.pid,
      socketPath: candidate.socketPath,
      stage: error.stage ?? 'connect',
      reason: error.message,
    };
  }
}

async function resolveUsableSocket(discovery) {
  const candidates = discovery.processes.filter((entry) => entry.socketExists);
  const attempts = [];

  if (candidates.length === 0) {
    throw new BridgeError(
      'discover',
      'no live native-host process with socket was found',
      discovery,
    );
  }

  for (const candidate of candidates) {
    const probe = await probeCandidateSocket(candidate);
    attempts.push(probe);

    if (probe.ok) {
      const warnings = [...discovery.warnings];

      if (candidates.length > 1) {
        warnings.push('multiple_socket_candidates_detected');
      }

      if (attempts.length > 1) {
        warnings.push('candidate_probe_fallback_used');
      }

      const failedCandidates = attempts
        .filter((entry) => !entry.ok)
        .map((entry) => entry.pid);
      if (failedCandidates.length > 0) {
        warnings.push('bogus_socket_candidates_rejected');
      }

      return {
        discovery: {
          ...discovery,
          selectedProcess: candidate,
          warnings: uniqueWarnings(warnings),
        },
        attempts,
        probe,
      };
    }
  }

  throw new BridgeError('connect', 'no usable native-host socket responded', {
    attempts,
    discovery,
  });
}

class ClaudeChromeAdapter {
  constructor(discovery, options = {}) {
    this.discovery = discovery;
    this.candidateAttempts = options.candidateAttempts ?? [];
    this.initialProbe = options.initialProbe ?? null;
    this.imageCache = options.imageCache ?? SHARED_IMAGE_CACHE;
    this.sessionScope = options.sessionScope ?? SESSION_SCOPE;
    this.client =
      options.client ??
      new NativeBridgeClient(discovery.selectedProcess.socketPath, CLIENT_ID, {
        sessionScope: this.sessionScope,
      });
    this.updateSessionScopeFromBrowserContext(this.initialProbe?.status_payload ?? null);
  }

  updateSessionScopeFromBrowserContext(browserContext) {
    if (!this.sessionScope || typeof this.sessionScope !== 'object') {
      return;
    }

    if (Number.isFinite(browserContext?.tabGroupId)) {
      this.sessionScope.tabGroupId = Number(browserContext.tabGroupId);
      return;
    }

    delete this.sessionScope.tabGroupId;
  }

  async tool(tool, args, timeoutMs = TOOL_TIMEOUT_MS) {
    return this.executeToolWithRecovery(tool, args, timeoutMs, false);
  }

  async executeToolWithRecovery(
    tool,
    args,
    timeoutMs,
    attemptedRecovery,
    attemptedBusyRetry = false,
  ) {
    const response = await this.client.executeTool(tool, args, timeoutMs);

    if (response.error) {
      if (!attemptedBusyRetry && responseSignalsTabsBusy(response)) {
        await delay(350);
        return this.executeToolWithRecovery(
          tool,
          args,
          timeoutMs,
          attemptedRecovery,
          true,
        );
      }
      throw new BridgeError('tool_call', response.error.content ?? 'tool failed', {
        tool,
        args,
        response,
      });
    }

    const result = response.result ?? response;
    const tabGroupId = extractTabGroupIdFromContent(result.content ?? []);
    if (Number.isFinite(tabGroupId)) {
      this.updateSessionScopeFromBrowserContext({ tabGroupId });
    } else if (contentSignalsMissingTabGroup(result.content ?? [])) {
      this.updateSessionScopeFromBrowserContext(null);
      if (!attemptedRecovery && toolSupportsSessionContextRecovery(tool)) {
        await this.client.executeTool(
          'tabs_context_mcp',
          { createIfEmpty: true },
          timeoutMs,
        );
        const recoveryProbe = await this.client.executeTool(
          'tabs_context_mcp',
          { createIfEmpty: false },
          timeoutMs,
        );
        this.updateSessionScopeFromBrowserContext(
          findStructuredJson(recoveryProbe.result?.content ?? recoveryProbe.content ?? []),
        );
        return this.executeToolWithRecovery(
          tool,
          args,
          timeoutMs,
          true,
          attemptedBusyRetry,
        );
      }
    }

    return result;
  }

  async health() {
    const fallbackTabs = this.initialProbe
      ? null
      : await this.tool('tabs_context_mcp', { createIfEmpty: false });
    const statusPayload =
      this.initialProbe?.status_payload ??
      findStructuredJson(fallbackTabs?.content);
    const statusSummary =
      this.initialProbe?.status_summary ??
      summarizeContent(fallbackTabs?.content);

    return {
      source: 'claude-code-native-host',
      host_process: this.discovery.selectedProcess,
      launcher_target: this.discovery.launcherTarget,
      socket_path: this.discovery.selectedProcess.socketPath,
      connect_ok: true,
      status_ok: true,
      warnings: [...this.discovery.warnings],
      candidate_attempts: this.candidateAttempts,
      status_payload: statusPayload,
      status_summary: statusSummary,
    };
  }

  async snapshot() {
    const tabs = await this.tool('tabs_context_mcp', { createIfEmpty: false });
    return {
      source: 'claude-code-native-host',
      warnings: [...this.discovery.warnings],
      browser_context: findStructuredJson(tabs.content),
      raw_summary: summarizeContent(tabs.content),
    };
  }

  async tabsContext(input = {}) {
    const response = await this.tool('tabs_context_mcp', {
      createIfEmpty: Boolean(input.createIfEmpty),
    });

    return {
      source: 'claude-code-native-host',
      action_taken: 'tabs_context',
      createIfEmpty: Boolean(input.createIfEmpty),
      warnings: [...this.discovery.warnings],
      browser_context: findStructuredJson(response.content),
      raw_summary: summarizeContent(response.content),
    };
  }

  async createTab() {
    await this.ensureSessionContext(true);
    const created = await this.tool('tabs_create_mcp', {});

    const tabId = extractTabIdFromContent(created.content);
    if (!tabId) {
      throw new BridgeError(
        'response_parse',
        'could not extract tabId from tabs_create_mcp response',
        created,
      );
    }

    const snapshot = await this.snapshot();
    return {
      source: 'claude-code-native-host',
      action_taken: 'create_tab',
      tabId,
      warnings: [...this.discovery.warnings],
      browser_context: snapshot.browser_context,
      raw_summary: summarizeContent(created.content),
      snapshot_summary: snapshot.raw_summary,
    };
  }

  async navigateTab(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    if (!input?.url) {
      throw new BridgeError('tool_call', 'url is required');
    }

    const response = await this.tool('navigate', {
      tabId: Number(input.tabId),
      url: String(input.url),
      ...(input.force === undefined ? {} : { force: Boolean(input.force) }),
    });

    return {
      source: 'claude-code-native-host',
      action_taken: 'navigate',
      tabId: Number(input.tabId),
      target: String(input.url),
      force: Boolean(input.force),
      warnings: [...this.discovery.warnings],
      result: normalizeToolContent(response.content),
      raw_summary: summarizeContent(response.content),
    };
  }

  async openOrFocus(input) {
    if (input.url) {
      let snapshot = null;

      try {
        snapshot = await this.snapshot();
      } catch (error) {
        if (!isMissingTabGroupError(error)) {
          throw error;
        }
      }

      const matchedTabs = snapshot
        ? selectTabsInContext(snapshot.browser_context, { url: input.url })
        : [];

      if (matchedTabs.length > 1) {
        throw new BridgeError('tool_call', 'selector matched multiple visible tabs', {
          selector: { url: input.url },
          matched_tabs: matchedTabs,
        });
      }

      if (matchedTabs.length === 1) {
        const matchedTab = matchedTabs[0];

        return {
          source: 'claude-code-native-host',
          action_taken: 'reuse',
          tabId: Number(matchedTab.tabId),
          target: input.url,
          warnings: [...this.discovery.warnings],
          matched_tab: matchedTab,
          browser_context: snapshot.browser_context,
          raw_summary: snapshot.raw_summary,
        };
      }

      await this.ensureSessionContext(true);
      const created = await this.tool('tabs_create_mcp', {});

      const tabId = extractTabIdFromContent(created.content);

      if (!tabId) {
        throw new BridgeError(
          'response_parse',
          'could not extract tabId from tabs_create_mcp response',
          created,
        );
      }

      const navigated = await this.tool('navigate', {
        tabId,
        url: input.url,
      });

      return {
        source: 'claude-code-native-host',
        action_taken: 'open',
        tabId,
        target: input.url,
        warnings: [...this.discovery.warnings],
        downstream_summary: summarizeContent(navigated.content),
      };
    }

    if (input.tabId) {
      const snapshot = await this.reuseTab(input);
      return {
        source: 'claude-code-native-host',
        action_taken: 'focus_unsupported_snapshot_returned',
        tabId: Number(input.tabId),
        warnings: [
          ...snapshot.warnings,
          'downstream_focus_action_not_confirmed',
        ],
        matched_tab: snapshot.matched_tab,
        browser_context: snapshot.browser_context,
        raw_summary: snapshot.raw_summary,
      };
    }

      throw new BridgeError('tool_call', 'url or tabId is required');
    }

  async reuseTab(input) {
    const selectorCount = [
      Number.isFinite(input?.tabId),
      typeof input?.url === 'string' && input.url.length > 0,
    ].filter(Boolean).length;

    if (selectorCount !== 1) {
      throw new BridgeError(
        'tool_call',
        'exactly one selector is required: tabId or url',
      );
    }

    const snapshot = await this.snapshot();
    const matchedTabs = selectTabsInContext(snapshot.browser_context, input ?? {});

    if (matchedTabs.length === 0) {
      throw new BridgeError(
        'tool_call',
        'no visible tab matched the requested selector',
        {
          selector: input,
          browser_context: snapshot.browser_context,
        },
      );
    }

    if (matchedTabs.length > 1) {
      throw new BridgeError(
        'tool_call',
        'selector matched multiple visible tabs',
        {
          selector: input,
          matched_tabs: matchedTabs,
        },
      );
    }

    const matchedTab = matchedTabs[0];

    return {
      source: 'claude-code-native-host',
      action_taken: 'reuse_confirmed',
      tabId: Number(matchedTab.tabId),
      warnings: [...this.discovery.warnings],
      selector: input,
      matched_tab: matchedTab,
      browser_context: snapshot.browser_context,
      raw_summary: snapshot.raw_summary,
    };
  }

  async click(input) {
    const coordinate = normalizeCoordinate(input);
    const response = await this.tool('computer', {
      action: 'left_click',
      coordinate,
      tabId: Number(input.tabId),
    });

    return {
      source: 'claude-code-native-host',
      tabId: Number(input.tabId),
      coordinate,
      warnings: [...this.discovery.warnings],
      downstream_summary: summarizeContent(response.content),
    };
  }

  async computer(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }
    if (!input?.action) {
      throw new BridgeError('tool_call', 'action is required');
    }

    const action = String(input.action);

    if (action === 'screenshot') {
      return this.screenshot(input);
    }

    const args = {
      action,
      tabId: Number(input.tabId),
    };

    const hasRef = typeof input?.ref === 'string' && input.ref.length > 0;
    const coordinate = normalizeOptionalCoordinate(input);

    switch (action) {
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click':
      case 'hover':
        if (hasRef === Boolean(coordinate)) {
          throw new BridgeError(
            'tool_call',
            'provide exactly one target: ref or coordinate/x/y',
          );
        }
        if (hasRef) {
          args.ref = String(input.ref);
        } else {
          args.coordinate = coordinate;
        }
        if (typeof input?.modifiers === 'string' && input.modifiers.length > 0) {
          args.modifiers = String(input.modifiers);
        }
        break;
      case 'scroll': {
        const scrollDirection =
          typeof input?.scrollDirection === 'string'
            ? input.scrollDirection
            : input?.scroll_direction;
        if (!coordinate) {
          throw new BridgeError(
            'tool_call',
            'coordinate or x/y is required for scroll',
          );
        }
        if (
          !['up', 'down', 'left', 'right'].includes(String(scrollDirection ?? ''))
        ) {
          throw new BridgeError(
            'tool_call',
            'scrollDirection is required and must be one of up/down/left/right',
          );
        }
        args.coordinate = coordinate;
        args.scroll_direction = String(scrollDirection);
        if (
          Number.isFinite(input?.scrollAmount) ||
          Number.isFinite(input?.scroll_amount)
        ) {
          args.scroll_amount = Number(
            Number.isFinite(input?.scrollAmount)
              ? input.scrollAmount
              : input.scroll_amount,
          );
        }
        break;
      }
      case 'key':
      case 'type':
        if (!input?.text) {
          throw new BridgeError('tool_call', 'text is required');
        }
        args.text = String(input.text);
        if (action === 'key' && Number.isFinite(input?.repeat)) {
          args.repeat = Number(input.repeat);
        }
        break;
      case 'wait':
        if (!Number.isFinite(input?.duration)) {
          throw new BridgeError('tool_call', 'duration is required');
        }
        args.duration = Number(input.duration);
        break;
      case 'left_click_drag': {
        const startCoordinate = normalizeStartCoordinate(input);
        if (!coordinate) {
          throw new BridgeError(
            'tool_call',
            'coordinate or x/y is required for left_click_drag',
          );
        }
        if (!startCoordinate) {
          throw new BridgeError(
            'tool_call',
            'startCoordinate or startX/startY is required for left_click_drag',
          );
        }
        args.coordinate = coordinate;
        args.start_coordinate = startCoordinate;
        break;
      }
      case 'zoom':
        args.region = normalizeRegion(input);
        break;
      case 'scroll_to':
        if (!hasRef) {
          throw new BridgeError('tool_call', 'ref is required for scroll_to');
        }
        args.ref = String(input.ref);
        break;
      default:
        throw new BridgeError('tool_call', `unsupported computer action: ${action}`);
    }

    const response = await this.tool('computer', args);

    return {
      source: 'claude-code-native-host',
      action_taken: 'computer',
      computer_action: action,
      tabId: Number(input.tabId),
      ref: args.ref ?? null,
      coordinate: args.coordinate ?? null,
      startCoordinate: args.start_coordinate ?? null,
      region: args.region ?? null,
      text: args.text ?? null,
      duration: args.duration ?? null,
      scrollDirection: args.scroll_direction ?? null,
      scrollAmount: args.scroll_amount ?? null,
      repeat: args.repeat ?? null,
      modifiers: args.modifiers ?? null,
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async type(input) {
    if (!input.text) {
      throw new BridgeError('tool_call', 'text is required');
    }

    const steps = [];

    if (input.coordinate || (Number.isFinite(input.x) && Number.isFinite(input.y))) {
      steps.push(await this.click(input));
    }

    const response = await this.tool('computer', {
      action: 'type',
      text: String(input.text),
      tabId: Number(input.tabId),
    });

    return {
      source: 'claude-code-native-host',
      tabId: Number(input.tabId),
      text: String(input.text),
      warnings: [...this.discovery.warnings],
      pre_steps: steps,
      downstream_summary: summarizeContent(response.content),
    };
  }

  async closeTab(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    const response = await this.tool('tabs_close_mcp', {
      tabId: Number(input.tabId),
    });
    const snapshot = await this.snapshot();

    return {
      source: 'claude-code-native-host',
      action_taken: 'close',
      tabId: Number(input.tabId),
      warnings: [...this.discovery.warnings],
      close_summary: summarizeContent(response.content),
      browser_context: snapshot.browser_context,
      raw_summary: snapshot.raw_summary,
    };
  }

  async javascriptExec(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    if (!input?.script) {
      throw new BridgeError('tool_call', 'script is required');
    }

    const response = await this.tool('javascript_tool', {
      action: 'javascript_exec',
      text: String(input.script),
      tabId: Number(input.tabId),
    });

    return {
      source: 'claude-code-native-host',
      action_taken: 'javascript_exec',
      tabId: Number(input.tabId),
      script: String(input.script),
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async getPageText(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    const args = {
      tabId: Number(input.tabId),
    };

    if (Number.isFinite(input?.maxChars)) {
      args.max_chars = Number(input.maxChars);
    }

    const response = await this.tool('get_page_text', args);

    return {
      source: 'claude-code-native-host',
      action_taken: 'get_page_text',
      tabId: Number(input.tabId),
      text: extractPrimaryText(response.content),
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async readPage(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    const args = {
      tabId: Number(input.tabId),
    };

    if (typeof input?.filter === 'string' && input.filter.length > 0) {
      args.filter = String(input.filter);
    }

    if (Number.isFinite(input?.depth)) {
      args.depth = Number(input.depth);
    }

    if (typeof input?.refId === 'string' && input.refId.length > 0) {
      args.ref_id = String(input.refId);
    }

    if (Number.isFinite(input?.maxChars)) {
      args.max_chars = Number(input.maxChars);
    }

    const response = await this.tool('read_page', args);

    return {
      source: 'claude-code-native-host',
      action_taken: 'read_page',
      tabId: Number(input.tabId),
      filter: args.filter ?? 'all',
      depth: args.depth ?? 15,
      refId: args.ref_id ?? null,
      text: extractPrimaryText(response.content),
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async find(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    if (!input?.query) {
      throw new BridgeError('tool_call', 'query is required');
    }

    const response = await this.tool('find', {
      query: String(input.query),
      tabId: Number(input.tabId),
    });

    return {
      source: 'claude-code-native-host',
      action_taken: 'find',
      tabId: Number(input.tabId),
      query: String(input.query),
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async formInput(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    if (!input?.ref) {
      throw new BridgeError('tool_call', 'ref is required');
    }

    if (input.value === undefined) {
      throw new BridgeError('tool_call', 'value is required');
    }

    const response = await this.tool('form_input', {
      ref: String(input.ref),
      value: input.value,
      tabId: Number(input.tabId),
    });

    return {
      source: 'claude-code-native-host',
      action_taken: 'form_input',
      tabId: Number(input.tabId),
      ref: String(input.ref),
      value: input.value,
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async readConsoleMessages(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    const args = {
      tabId: Number(input.tabId),
    };

    if (input.onlyErrors !== undefined) {
      args.onlyErrors = Boolean(input.onlyErrors);
    }
    if (input.clear !== undefined) {
      args.clear = Boolean(input.clear);
    }
    if (typeof input?.pattern === 'string' && input.pattern.length > 0) {
      args.pattern = String(input.pattern);
    }
    if (Number.isFinite(input?.limit)) {
      args.limit = Number(input.limit);
    }

    const response = await this.tool('read_console_messages', args);
    return {
      source: 'claude-code-native-host',
      action_taken: 'read_console_messages',
      tabId: Number(input.tabId),
      onlyErrors: Boolean(input.onlyErrors),
      pattern: args.pattern ?? null,
      clear: Boolean(input.clear),
      limit: args.limit ?? 100,
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async readNetworkRequests(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    const args = {
      tabId: Number(input.tabId),
    };

    if (typeof input?.urlPattern === 'string' && input.urlPattern.length > 0) {
      args.urlPattern = String(input.urlPattern);
    }
    if (input.clear !== undefined) {
      args.clear = Boolean(input.clear);
    }
    if (Number.isFinite(input?.limit)) {
      args.limit = Number(input.limit);
    }

    const response = await this.tool('read_network_requests', args);
    return {
      source: 'claude-code-native-host',
      action_taken: 'read_network_requests',
      tabId: Number(input.tabId),
      urlPattern: args.urlPattern ?? null,
      clear: Boolean(input.clear),
      limit: args.limit ?? 100,
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async uploadFile(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }
    if (!Array.isArray(input?.paths) || input.paths.length === 0) {
      throw new BridgeError(
        'tool_call',
        'paths is required and must be a non-empty array',
      );
    }
    const hasRef = typeof input?.ref === 'string' && input.ref.length > 0;
    const hasSelector =
      typeof input?.selector === 'string' && input.selector.length > 0;
    if (!hasRef && !hasSelector) {
      throw new BridgeError('tool_call', 'ref or selector is required');
    }

    let result = null;
    let rawSummary = null;
    let warnings = [...this.discovery.warnings];

    if (hasSelector) {
      const files = input.paths.map((entry) => encodeFileArtifact(String(entry)));
      result = await this.runUploadScript({
        tabId: Number(input.tabId),
        selector: String(input.selector),
        files,
        allowDrop: false,
      });
      rawSummary = result;
      warnings = [...warnings, 'selector_upload_path_used'];
    } else {
      const response = await this.tool('file_upload', {
        tabId: Number(input.tabId),
        ref: String(input.ref),
        paths: input.paths.map((entry) => String(entry)),
      });
      result = normalizeToolContent(response.content);
      rawSummary = summarizeContent(response.content);
    }

    return {
      source: 'claude-code-native-host',
      action_taken: 'file_upload',
      tabId: Number(input.tabId),
      ref: hasRef ? String(input.ref) : null,
      selector: hasSelector ? String(input.selector) : null,
      paths: input.paths.map((entry) => String(entry)),
      result,
      warnings,
      raw_summary: rawSummary,
    };
  }

  async uploadImage(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }
    if (!input?.imageId && !input?.path) {
      throw new BridgeError('tool_call', 'imageId or path is required');
    }
    const hasRef = typeof input?.ref === 'string' && input.ref.length > 0;
    const hasSelector =
      typeof input?.selector === 'string' && input.selector.length > 0;
    const hasCoordinate =
      Array.isArray(input?.coordinate) ||
      (Number.isFinite(input?.x) && Number.isFinite(input?.y));
    const targetCount = [hasRef, hasSelector, hasCoordinate].filter(Boolean).length;
    if (targetCount === 0) {
      throw new BridgeError(
        'tool_call',
        'one target is required: ref, selector, or coordinate/x/y',
      );
    }
    if (targetCount > 1) {
      throw new BridgeError(
        'tool_call',
        'provide exactly one target: ref, selector, or coordinate/x/y',
      );
    }

    let fileEntry = null;
    if (input?.imageId) {
      fileEntry = this.imageCache.get(String(input.imageId)) ?? null;
    }
    if (!fileEntry && input?.path) {
      fileEntry = encodeFileArtifact(String(input.path));
    }
    if (!fileEntry) {
      const response = await this.tool('upload_image', {
        tabId: Number(input.tabId),
        imageId: String(input.imageId),
        ...(hasRef
          ? { ref: String(input.ref) }
          : { coordinate: normalizeCoordinate(input) }),
        ...(typeof input?.filename === 'string' && input.filename.length > 0
          ? { filename: String(input.filename) }
          : {}),
      });
      return {
        source: 'claude-code-native-host',
        action_taken: 'upload_image',
        tabId: Number(input.tabId),
        imageId: input?.imageId ? String(input.imageId) : null,
        ref: hasRef ? String(input.ref) : null,
        coordinate: hasCoordinate ? normalizeCoordinate(input) : null,
        filename: input?.filename ? String(input.filename) : null,
        result: normalizeToolContent(response.content),
        warnings: [...this.discovery.warnings, 'image_cache_miss_fallback_to_downstream'],
        raw_summary: summarizeContent(response.content),
      };
    }

    const fileName =
      typeof input?.filename === 'string' && input.filename.length > 0
        ? String(input.filename)
        : fileEntry.name;
    const coordinate = hasCoordinate ? normalizeCoordinate(input) : null;
    let uploadResult = null;
    let warnings = [...this.discovery.warnings];

    if (hasRef) {
      const tempPath = writeTempArtifact({ ...fileEntry, name: fileName }, fileName);
      const response = await this.tool('file_upload', {
        tabId: Number(input.tabId),
        ref: String(input.ref),
        paths: [tempPath],
      });
      uploadResult = normalizeToolContent(response.content);
    } else if (hasSelector) {
      uploadResult = await this.runUploadScript({
        tabId: Number(input.tabId),
        selector: String(input.selector),
        files: [{ ...fileEntry, name: fileName }],
        allowDrop: true,
      });
      warnings = [...warnings, 'selector_upload_path_used'];
    } else {
      uploadResult = await this.runUploadScript({
        tabId: Number(input.tabId),
        coordinate,
        files: [{ ...fileEntry, name: fileName }],
        allowDrop: true,
      });
    }

    return {
      source: 'claude-code-native-host',
      action_taken: 'upload_image',
      tabId: Number(input.tabId),
      imageId: input?.imageId ? String(input.imageId) : null,
      path: input?.path ? String(input.path) : null,
      ref: hasRef ? String(input.ref) : null,
      selector: hasSelector ? String(input.selector) : null,
      coordinate,
      filename: fileName,
      result: uploadResult,
      warnings,
      raw_summary: uploadResult,
    };
  }

  async screenshot(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }

    const response = await this.tool('computer', {
      action: 'screenshot',
      tabId: Number(input.tabId),
    });
    const metadata = extractScreenshotMetadata(response.content);
    const image = extractImageItem(response.content);
    const imageId =
      metadata?.imageId ??
      extractImageIdFromContent(response.content) ??
      `image_${Date.now().toString(36)}`;

    if (image) {
      cacheImageEntry(
        imageId,
        {
          ...image,
          name: `screenshot-${imageId}.${metadata?.format === 'jpeg' ? 'jpg' : 'png'}`,
        },
        this.imageCache,
      );
    }

    return {
      source: 'claude-code-native-host',
      action_taken: 'screenshot',
      tabId: Number(input.tabId),
      imageId,
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      format: metadata?.format ?? image?.mediaType ?? null,
      cached: Boolean(image),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async resizeWindow(input) {
    if (!Number.isFinite(input?.tabId)) {
      throw new BridgeError('tool_call', 'tabId is required');
    }
    if (!Number.isFinite(input?.width) || !Number.isFinite(input?.height)) {
      throw new BridgeError('tool_call', 'width and height are required');
    }

    const response = await this.tool('resize_window', {
      tabId: Number(input.tabId),
      width: Number(input.width),
      height: Number(input.height),
    });
    return {
      source: 'claude-code-native-host',
      action_taken: 'resize_window',
      tabId: Number(input.tabId),
      width: Number(input.width),
      height: Number(input.height),
      result: normalizeToolContent(response.content),
      warnings: [...this.discovery.warnings],
      raw_summary: summarizeContent(response.content),
    };
  }

  async ensureSessionContext(createIfEmpty = false) {
    return this.tool('tabs_context_mcp', {
      createIfEmpty: Boolean(createIfEmpty),
    });
  }

  async runUploadScript({
    tabId,
    ref = null,
    selector = null,
    coordinate = null,
    files,
    allowDrop,
  }) {
    const script = buildUploadScript({
      files,
      ref,
      selector,
      coordinate,
      allowDrop,
    });
    const result = await this.javascriptExec({
      tabId,
      script,
    });
    const parsed =
      typeof result.result === 'string' ? safeJsonParse(result.result) : result.result;

    if (!parsed?.ok) {
      throw new BridgeError(
        'tool_call',
        parsed?.error ?? 'upload script failed',
        parsed ?? result,
      );
    }

    return parsed;
  }
}

async function createAdapter() {
  const discovery = await discoverEnvironment();
  const resolved = await resolveUsableSocket(discovery);
  return new ClaudeChromeAdapter(resolved.discovery, {
    candidateAttempts: resolved.attempts,
    initialProbe: resolved.probe,
    sessionScope: SESSION_SCOPE,
    imageCache: SHARED_IMAGE_CACHE,
  });
}

async function runProbe() {
  const discovery = await discoverEnvironment();

  if (!discovery.processes.some((entry) => entry.socketExists)) {
    return {
      source: 'claude-code-native-host',
      host_process: discovery.selectedProcess,
      launcher_target: discovery.launcherTarget,
      socket_path: discovery.selectedProcess?.socketPath ?? null,
      connect_ok: false,
      status_ok: false,
      warnings: [...discovery.warnings],
      failure_stage: 'discover',
      failure_reason: 'no live native-host socket found',
    };
  }

  try {
    const resolved = await resolveUsableSocket(discovery);
    const adapter = new ClaudeChromeAdapter(resolved.discovery, {
      candidateAttempts: resolved.attempts,
      initialProbe: resolved.probe,
    });
    return await adapter.health();
  } catch (error) {
    return {
      source: 'claude-code-native-host',
      host_process: discovery.selectedProcess,
      launcher_target: discovery.launcherTarget,
      socket_path: discovery.selectedProcess?.socketPath ?? null,
      connect_ok: error.stage !== 'discover',
      status_ok: false,
      warnings: [...discovery.warnings],
      failure_stage: error.stage ?? 'unknown',
      failure_reason: error.message,
    };
  }
}

function toolDefinitions() {
  return [
    {
      name: 'browser_health',
      description:
        'Discover the live Claude Code Chrome native-host socket and report bridge health.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'browser_snapshot',
      description:
        'Return the current browser/tab context exposed by the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'browser_tabs_context',
      description:
        'Return the current MCP tab-group context, optionally creating it if no session tab group exists.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          createIfEmpty: { type: 'boolean' },
        },
      },
    },
    {
      name: 'browser_create_tab',
      description:
        'Create a new empty tab in the MCP tab group, creating the group first when needed.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'browser_navigate_tab',
      description:
        'Navigate a specific tab to a URL through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'url'],
        properties: {
          tabId: { type: 'integer' },
          url: { type: 'string' },
          force: { type: 'boolean' },
        },
      },
    },
    {
      name: 'browser_open_or_focus',
      description:
        'Open a new tab for a URL via the local bridge, or return a snapshot for an existing tab when downstream focus is unavailable.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          tabId: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_reuse_tab',
      description:
        'Confirm that an existing visible tab can be reused by tabId or exact URL, and return the current browser context.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'integer' },
          url: { type: 'string' },
        },
      },
    },
    {
      name: 'browser_close_tab',
      description:
        'Close a specific tab by tabId through the local Claude in Chrome bridge and return the remaining browser context.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_javascript_exec',
      description:
        'Execute JavaScript in a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'script'],
        properties: {
          tabId: { type: 'integer' },
          script: { type: 'string' },
        },
      },
    },
    {
      name: 'browser_get_page_text',
      description:
        'Extract plain text from a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
          maxChars: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_read_page',
      description:
        'Read an accessibility-tree style view of a specific tab or subtree through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
          filter: { type: 'string', enum: ['interactive', 'all'] },
          depth: { type: 'integer' },
          refId: { type: 'string' },
          maxChars: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_find',
      description:
        'Find an element in a specific tab using natural language through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'query'],
        properties: {
          tabId: { type: 'integer' },
          query: { type: 'string' },
        },
      },
    },
    {
      name: 'browser_form_input',
      description:
        'Set a form control value by ref in a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'ref', 'value'],
        properties: {
          tabId: { type: 'integer' },
          ref: { type: 'string' },
          value: {},
        },
      },
    },
    {
      name: 'browser_console_messages',
      description:
        'Read tracked browser console messages from a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
          onlyErrors: { type: 'boolean' },
          clear: { type: 'boolean' },
          pattern: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_network_requests',
      description:
        'Read tracked network requests from a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
          urlPattern: { type: 'string' },
          clear: { type: 'boolean' },
          limit: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_computer',
      description:
        'Run the underlying CiC computer tool directly for browser-facing actions such as hover, key, scroll, drag, right-click, double-click, wait, zoom, and scroll_to.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'action'],
        properties: {
          tabId: { type: 'integer' },
          action: {
            type: 'string',
            enum: [
              'left_click',
              'right_click',
              'type',
              'screenshot',
              'wait',
              'scroll',
              'key',
              'left_click_drag',
              'double_click',
              'triple_click',
              'zoom',
              'scroll_to',
              'hover',
            ],
          },
          ref: { type: 'string' },
          coordinate: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
          },
          x: { type: 'number' },
          y: { type: 'number' },
          text: { type: 'string' },
          duration: { type: 'number' },
          scrollDirection: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
          },
          scroll_direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
          },
          scrollAmount: { type: 'number' },
          scroll_amount: { type: 'number' },
          startCoordinate: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
          },
          start_coordinate: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
          },
          startX: { type: 'number' },
          startY: { type: 'number' },
          region: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'number' },
          },
          repeat: { type: 'integer' },
          modifiers: { type: 'string' },
        },
      },
    },
    {
      name: 'browser_click',
      description:
        'Click at viewport coordinates in a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
          coordinate: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
          },
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
    {
      name: 'browser_type',
      description:
        'Type text into the current focused target in a specific tab. Optional coordinates will click first.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'text'],
        properties: {
          tabId: { type: 'integer' },
          text: { type: 'string' },
          coordinate: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
          },
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
    {
      name: 'browser_screenshot',
      description:
        'Capture a screenshot for a specific tab and cache the resulting image for later browser_upload_image calls.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
        },
      },
    },
    {
      name: 'browser_upload_file',
      description:
        'Upload one or more local files to a file input ref or CSS selector in a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'paths'],
        properties: {
          tabId: { type: 'integer' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          paths: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
          },
        },
      },
    },
    {
      name: 'browser_upload_image',
      description:
        'Upload an image from browser_screenshot(imageId) or a local image path to a file input ref, CSS selector, or viewport coordinate in a specific tab.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId'],
        properties: {
          tabId: { type: 'integer' },
          imageId: { type: 'string' },
          path: { type: 'string' },
          ref: { type: 'string' },
          selector: { type: 'string' },
          coordinate: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            items: { type: 'number' },
          },
          x: { type: 'number' },
          y: { type: 'number' },
          filename: { type: 'string' },
        },
      },
    },
    {
      name: 'browser_resize_window',
      description:
        'Resize the browser window that contains a specific tab through the local Claude in Chrome bridge.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['tabId', 'width', 'height'],
        properties: {
          tabId: { type: 'integer' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
      },
    },
  ];
}

async function handleToolCall(name, args) {
  const adapter = await createAdapter();

  switch (name) {
    case 'browser_health':
      return adapter.health();
    case 'browser_snapshot':
      return adapter.snapshot();
    case 'browser_tabs_context':
      return adapter.tabsContext(args ?? {});
    case 'browser_create_tab':
      return adapter.createTab(args ?? {});
    case 'browser_navigate_tab':
      return adapter.navigateTab(args ?? {});
    case 'browser_open_or_focus':
      return adapter.openOrFocus(args ?? {});
    case 'browser_reuse_tab':
      return adapter.reuseTab(args ?? {});
    case 'browser_close_tab':
      return adapter.closeTab(args ?? {});
    case 'browser_javascript_exec':
      return adapter.javascriptExec(args ?? {});
    case 'browser_get_page_text':
      return adapter.getPageText(args ?? {});
    case 'browser_read_page':
      return adapter.readPage(args ?? {});
    case 'browser_find':
      return adapter.find(args ?? {});
    case 'browser_form_input':
      return adapter.formInput(args ?? {});
    case 'browser_console_messages':
      return adapter.readConsoleMessages(args ?? {});
    case 'browser_network_requests':
      return adapter.readNetworkRequests(args ?? {});
    case 'browser_computer':
      return adapter.computer(args ?? {});
    case 'browser_click':
      return adapter.click(args ?? {});
    case 'browser_type':
      return adapter.type(args ?? {});
    case 'browser_screenshot':
      return adapter.screenshot(args ?? {});
    case 'browser_upload_file':
      return adapter.uploadFile(args ?? {});
    case 'browser_upload_image':
      return adapter.uploadImage(args ?? {});
    case 'browser_resize_window':
      return adapter.resizeWindow(args ?? {});
    default:
      throw new BridgeError('tool_call', `unknown tool: ${name}`);
  }
}

async function withMcpToolCallTimeout(name, args, action) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        new BridgeError(
          'tool_timeout',
          `MCP tool call timed out waiting for ${name}`,
          {
            tool: name,
            timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
            arguments: args,
          },
        ),
      );
    }, MCP_TOOL_CALL_TIMEOUT_MS);

    Promise.resolve()
      .then(action)
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function rpcSuccess(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function rpcError(id, code, message, data = undefined) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function negotiateProtocolVersion(requestedVersion) {
  if (
    typeof requestedVersion === 'string' &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
  ) {
    return requestedVersion;
  }

  return DEFAULT_PROTOCOL_VERSION;
}

function encodeRpc(message) {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function encodeRawRpc(message) {
  return `${JSON.stringify(message)}\n`;
}

function findHeaderBoundary(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf !== -1) {
    return { index: crlf, length: 4 };
  }

  const lf = buffer.indexOf('\n\n');
  if (lf !== -1) {
    return { index: lf, length: 2 };
  }

  return null;
}

function detectTransportMode(buffer) {
  const preview = buffer.subarray(0, 64).toString('utf8').trimStart();

  if (preview.startsWith('Content-Length:')) {
    return 'content-length';
  }

  if (preview.startsWith('{')) {
    return 'raw-json';
  }

  return null;
}

function tryConsumeRawJsonMessage(buffer) {
  const text = buffer.toString('utf8');
  const newlineIndex = text.indexOf('\n');

  if (newlineIndex !== -1) {
    const rawLine = text.slice(0, newlineIndex).trim();
    const consumedBytes = Buffer.byteLength(text.slice(0, newlineIndex + 1), 'utf8');

    if (!rawLine) {
      return {
        message: null,
        consumedBytes,
      };
    }

    const message = safeJsonParse(rawLine);
    if (!message) {
      throw new BridgeError('response_parse', 'invalid raw JSON-RPC body');
    }

    return {
      message,
      consumedBytes,
    };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const message = safeJsonParse(trimmed);
  if (!message) {
    return null;
  }

  return {
    message,
    consumedBytes: buffer.length,
  };
}

function writeRpc(message, transportMode = 'content-length') {
  traceMcp('outgoing', message);
  process.stdout.write(
    transportMode === 'raw-json' ? encodeRawRpc(message) : encodeRpc(message),
  );
}

function toolResultPayload(value, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
    isError,
  };
}

async function runMcpServer() {
  const stdin = process.stdin;
  let buffer = Buffer.alloc(0);
  let transportMode = null;
  const emitRpc = (message) => writeRpc(message, transportMode ?? 'content-length');

  traceMcp('startup', {
    argv: process.argv,
    cwd: process.cwd(),
    trace_path: MCP_TRACE_PATH,
  });

  stdin.on('data', async (chunk) => {
    traceMcp('stdin_chunk', {
      bytes: chunk.length,
      preview: chunk
        .subarray(0, 120)
        .toString('utf8')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n'),
    });
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (!transportMode) {
        transportMode = detectTransportMode(buffer);

        if (transportMode) {
          traceMcp('transport_mode', { transportMode });
        }
      }

      if (transportMode === 'raw-json') {
        const rawFrame = tryConsumeRawJsonMessage(buffer);
        if (!rawFrame) {
          return;
        }

        buffer = buffer.subarray(rawFrame.consumedBytes);

        if (!rawFrame.message) {
          continue;
        }

        const message = rawFrame.message;
        traceMcp('incoming', message);

        try {
          if (message.method === 'initialize') {
            const protocolVersion = negotiateProtocolVersion(
              message.params?.protocolVersion,
            );
            emitRpc(
              rpcSuccess(message.id, {
                protocolVersion,
                capabilities: {
                  tools: {
                    listChanged: false,
                  },
                },
                serverInfo: {
                  name: 'codex-chrome-bridge',
                  version: '0.1.0',
                },
                instructions:
                  'Repo-local MCP wrapper around the Claude Code Chrome native-host bridge.',
              }),
            );
            continue;
          }

          if (message.method === 'notifications/initialized') {
            continue;
          }

          if (message.method === 'notifications/cancelled') {
            continue;
          }

          if (message.method === 'ping') {
            emitRpc(rpcSuccess(message.id, {}));
            continue;
          }

          if (message.method === 'tools/list') {
            emitRpc(
              rpcSuccess(message.id, {
                tools: toolDefinitions(),
              }),
            );
            continue;
          }

          if (message.method === 'tools/call') {
            const toolName = message.params?.name;
            const args = message.params?.arguments ?? {};

            try {
              const result = await withMcpToolCallTimeout(toolName, args, () =>
                handleToolCall(toolName, args),
              );
              emitRpc(rpcSuccess(message.id, toolResultPayload(result, false)));
            } catch (error) {
              const payload = {
                ok: false,
                stage: error.stage ?? 'unknown',
                error: {
                  code: error.name ?? 'Error',
                  message: error.message,
                  detail: error.detail,
                },
              };
              emitRpc(rpcSuccess(message.id, toolResultPayload(payload, true)));
            }
            continue;
          }

          emitRpc(
            rpcError(message.id ?? null, -32601, `unknown method: ${message.method}`),
          );
        } catch (error) {
          emitRpc(
            rpcError(message.id ?? null, -32000, error.message, {
              stage: error.stage,
              detail: error.detail,
            }),
          );
        }
        continue;
      }

      const boundary = findHeaderBoundary(buffer);
      if (!boundary) {
        return;
      }

      const headerEnd = boundary.index;
      const headerText = buffer.subarray(0, headerEnd).toString('utf8');
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        buffer = Buffer.alloc(0);
        emitRpc(rpcError(null, -32600, 'missing Content-Length header'));
        return;
      }

      const bodyLength = Number.parseInt(contentLengthMatch[1], 10);
      const frameLength = headerEnd + boundary.length + bodyLength;
      if (buffer.length < frameLength) {
        return;
      }

      const body = buffer
        .subarray(headerEnd + boundary.length, frameLength)
        .toString('utf8');
      buffer = buffer.subarray(frameLength);
      const message = safeJsonParse(body);

      if (!message) {
        emitRpc(rpcError(null, -32700, 'invalid JSON-RPC body'));
        continue;
      }

      traceMcp('incoming', message);

      try {
        if (message.method === 'initialize') {
          const protocolVersion = negotiateProtocolVersion(
            message.params?.protocolVersion,
          );
          emitRpc(
            rpcSuccess(message.id, {
              protocolVersion,
              capabilities: {
                tools: {
                  listChanged: false,
                },
              },
              serverInfo: {
                name: 'codex-chrome-bridge',
                version: '0.1.0',
              },
              instructions:
                'Repo-local MCP wrapper around the Claude Code Chrome native-host bridge.',
            }),
          );
          continue;
        }

        if (message.method === 'notifications/initialized') {
          continue;
        }

        if (message.method === 'notifications/cancelled') {
          continue;
        }

        if (message.method === 'ping') {
          emitRpc(rpcSuccess(message.id, {}));
          continue;
        }

        if (message.method === 'tools/list') {
          emitRpc(
            rpcSuccess(message.id, {
              tools: toolDefinitions(),
            }),
          );
          continue;
        }

        if (message.method === 'tools/call') {
          const toolName = message.params?.name;
          const args = message.params?.arguments ?? {};

          try {
            const result = await withMcpToolCallTimeout(toolName, args, () =>
              handleToolCall(toolName, args),
            );
            emitRpc(rpcSuccess(message.id, toolResultPayload(result, false)));
          } catch (error) {
            const payload = {
              ok: false,
              stage: error.stage ?? 'unknown',
              error: {
                code: error.name ?? 'Error',
                message: error.message,
                detail: error.detail,
              },
            };
            emitRpc(rpcSuccess(message.id, toolResultPayload(payload, true)));
          }
          continue;
        }

        emitRpc(rpcError(message.id ?? null, -32601, `unknown method: ${message.method}`));
      } catch (error) {
        emitRpc(
          rpcError(message.id ?? null, -32000, error.message, {
            stage: error.stage,
            detail: error.detail,
          }),
        );
      }
    }
  });

  stdin.resume();
}

async function main() {
  const mode = process.argv[2];

  if (mode === 'probe') {
    const result = await runProbe();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (mode === 'mcp') {
    await runMcpServer();
    return;
  }

  process.stderr.write('Usage: node ./src/bridge.js <probe|mcp>\n');
  process.exitCode = 1;
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

export const __test__ = {
  parseLauncherTarget,
  parseVersionFromBinary,
  mimeTypeFromPath,
  summarizeContent,
  findStructuredJson,
  extractTextItems,
  extractPrimaryText,
  normalizeToolContent,
  extractImageItem,
  extractImageIdFromContent,
  extractTabGroupIdFromContent,
  contentSignalsMissingTabGroup,
  toolSupportsSessionContextRecovery,
  extractScreenshotMetadata,
  extractTabIdFromContent,
  findTabInContext,
  selectTabsInContext,
  normalizeCoordinate,
  normalizeOptionalCoordinate,
  normalizeStartCoordinate,
  normalizeRegion,
  BridgeError,
};
