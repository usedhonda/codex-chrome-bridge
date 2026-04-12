#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeEntry = path.join(repoRoot, 'src', 'bridge.js');
const launcherEntry = path.join(repoRoot, 'scripts', 'run-codex-with-bridge.mjs');
const expectedTools = [
  'browser_health',
  'browser_snapshot',
  'browser_tabs_context',
  'browser_create_tab',
  'browser_navigate_tab',
  'browser_open_or_focus',
  'browser_reuse_tab',
  'browser_close_tab',
  'browser_javascript_exec',
  'browser_get_page_text',
  'browser_read_page',
  'browser_find',
  'browser_form_input',
  'browser_console_messages',
  'browser_network_requests',
  'browser_computer',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_upload_file',
  'browser_upload_image',
  'browser_resize_window',
];
const futureOptionalTools = [
  'browser_tabs_context',
  'browser_create_tab',
  'browser_navigate_tab',
  'browser_console_messages',
  'browser_network_requests',
  'browser_computer',
  'browser_screenshot',
  'browser_upload_file',
  'browser_upload_image',
  'browser_resize_window',
];
const optionArgs = new Set(process.argv.slice(2));
const enableHostChurn = optionArgs.has('--host-churn');
const enableCodexExec = optionArgs.has('--codex-exec') || enableHostChurn;
const enableLiveBrowser =
  optionArgs.has('--live-browser') || enableCodexExec || enableHostChurn;

function encodeFrame(message) {
  const json = JSON.stringify(message);
  return Buffer.concat([
    Buffer.from(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`, 'utf8'),
    Buffer.from(json, 'utf8'),
  ]);
}

function extractText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return null;
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') {
    return value ?? null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stage: error?.stage ?? null,
    detail: error?.detail ?? null,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFirstRef(value) {
  const texts = [
    typeof value === 'string' ? value : null,
    ...(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []),
  ].filter(Boolean);

  for (const text of texts) {
    const match = text.match(/\bref_\d+\b/);
    if (match) {
      return match[0];
    }
  }

  return null;
}

function extractRefByLabel(value, label) {
  const texts = [
    typeof value === 'string' ? value : null,
    ...(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []),
  ].filter(Boolean);

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escapedLabel}[\\s\\S]*?\\[(ref_\\d+)\\]`, 'i');

  for (const text of texts) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function extractViewportSize(value) {
  const texts = [
    typeof value === 'string' ? value : null,
    ...(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []),
  ].filter(Boolean);

  for (const text of texts) {
    const match = text.match(/Viewport:\s*(\d+)x(\d+)/i);
    if (match) {
      return {
        width: Number.parseInt(match[1], 10),
        height: Number.parseInt(match[2], 10),
      };
    }
  }

  return null;
}

function extractPrimaryValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0) {
        return item;
      }
    }
  }

  return null;
}

function toolDefinitionsByName(tools) {
  const map = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (typeof tool?.name === 'string' && tool.name.length > 0) {
      map.set(tool.name, tool);
    }
  }
  return map;
}

function toolRequires(definition, key) {
  return Array.isArray(definition?.inputSchema?.required)
    ? definition.inputSchema.required.includes(key)
    : false;
}

function selectUniqueVisibleUrl(browserContext) {
  const availableTabs = Array.isArray(browserContext?.availableTabs)
    ? browserContext.availableTabs
    : [];
  const counts = new Map();
  for (const tab of availableTabs) {
    const url = typeof tab?.url === 'string' ? tab.url : '';
    if (!url) {
      continue;
    }
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }

  for (const tab of availableTabs) {
    const url = typeof tab?.url === 'string' ? tab.url : '';
    if (!url || counts.get(url) !== 1) {
      continue;
    }
    if (url.startsWith('chrome://')) {
      continue;
    }
    return {
      tabId: Number(tab.tabId),
      url,
      title: tab.title ?? '',
    };
  }

  return null;
}

async function startValidationHttpServer() {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bridge Validation Harness</title>
  </head>
  <body>
    <section id="bridge-validation-harness">
      <article>Bronze hound validation article text for bridge_get_page_text.</article>
      <label for="target-input">Validation Name</label>
      <input id="target-input" type="text" value="" />
      <output id="key-status"></output>
      <button id="hover-target" type="button">Hover target</button>
      <output id="hover-status"></output>
      <button id="context-target" type="button">Context target</button>
      <output id="context-status"></output>
      <button id="double-click-target" type="button">Double click target</button>
      <output id="double-click-status"></output>
      <button id="triple-click-target" type="button">Triple click target</button>
      <output id="triple-click-status"></output>
      <div id="drag-lane" style="display: flex; gap: 180px; align-items: center; margin: 24px 0;">
        <button id="drag-source" type="button">Drag source</button>
        <button id="drag-target" type="button">Drag target</button>
      </div>
      <output id="drag-status"></output>
      <label for="upload-file-input">Validation File</label>
      <input id="upload-file-input" type="file" />
      <label for="upload-image-input">Validation Image</label>
      <input id="upload-image-input" type="file" accept="image/*" />
      <output id="upload-status"></output>
      <button id="submit-button" type="button">Submit validation form</button>
      <ul>
        <li class="candidate">Candidate One</li>
        <li class="candidate">Candidate Two</li>
      </ul>
      <div id="scroll-spacer" style="height: 1800px;"></div>
      <button id="scroll-target-button" type="button">Scroll target button</button>
      <div id="scroll-target">Scroll target marker</div>
    </section>
    <script>
      const bindUploadStatus = (selector) => {
        const input = document.querySelector(selector);
        const status = document.querySelector('#upload-status');
        if (!input || !status) {
          return;
        }
        input.addEventListener('change', () => {
          status.textContent = Array.from(input.files || []).map((file) => file.name).join(',');
        });
      };
      const hoverTarget = document.querySelector('#hover-target');
      const hoverStatus = document.querySelector('#hover-status');
      const keyTarget = document.querySelector('#target-input');
      const keyStatus = document.querySelector('#key-status');
      if (keyTarget && keyStatus) {
        keyTarget.addEventListener('keydown', (event) => {
          keyStatus.textContent = event.key;
        });
      }
      if (hoverTarget && hoverStatus) {
        const markHovered = () => {
          hoverStatus.textContent = 'hovered';
        };
        ['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove'].forEach(
          (eventName) => {
            hoverTarget.addEventListener(eventName, markHovered);
          },
        );
      }
      const contextTarget = document.querySelector('#context-target');
      const contextStatus = document.querySelector('#context-status');
      if (contextTarget && contextStatus) {
        contextTarget.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          contextStatus.textContent = 'context-opened';
        });
      }
      const doubleClickTarget = document.querySelector('#double-click-target');
      const doubleClickStatus = document.querySelector('#double-click-status');
      if (doubleClickTarget && doubleClickStatus) {
        doubleClickTarget.addEventListener('dblclick', () => {
          doubleClickStatus.textContent = 'double-clicked';
        });
      }
      const tripleClickTarget = document.querySelector('#triple-click-target');
      const tripleClickStatus = document.querySelector('#triple-click-status');
      if (tripleClickTarget && tripleClickStatus) {
        tripleClickTarget.addEventListener('click', (event) => {
          tripleClickStatus.textContent = String(event.detail);
        });
      }
      const dragSource = document.querySelector('#drag-source');
      const dragTarget = document.querySelector('#drag-target');
      const dragStatus = document.querySelector('#drag-status');
      if (dragSource && dragTarget && dragStatus) {
        let dragActive = false;
        let dragMoved = false;
        let dragReachedTarget = false;
        dragSource.addEventListener('mousedown', () => {
          dragActive = true;
          dragMoved = false;
          dragReachedTarget = false;
          dragStatus.textContent = 'drag-start';
        });
        document.addEventListener('mousemove', (event) => {
          if (!dragActive) {
            return;
          }
          dragMoved = true;
          if (event.target === dragTarget || dragTarget.contains(event.target)) {
            dragReachedTarget = true;
          }
        });
        dragTarget.addEventListener('mouseenter', () => {
          if (dragActive) {
            dragReachedTarget = true;
          }
        });
        document.addEventListener('mouseup', () => {
          if (!dragActive) {
            return;
          }
          dragStatus.textContent =
            dragMoved && dragReachedTarget ? 'drag-complete' : 'drag-cancelled';
          dragActive = false;
          dragMoved = false;
          dragReachedTarget = false;
        });
      }
      bindUploadStatus('#upload-file-input');
      bindUploadStatus('#upload-image-input');
    </script>
  </body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/?validate-network=')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('could not determine validation HTTP server address');
  }

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

class JsonRpcClient {
  constructor(child) {
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;

    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk.toString('utf8');
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000);
      }
    });

    child.on('exit', (code, signal) => {
      this.closed = true;
      const err = new Error(
        `bridge process exited${code !== null ? ` with code ${code}` : ''}${signal ? ` signal ${signal}` : ''}`,
      );
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(err);
        this.pending.delete(id);
      }
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.stdoutBuffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.stdoutBuffer = Buffer.alloc(0);
        this.failAll(new Error('missing Content-Length header'));
        return;
      }

      const bodyLength = Number.parseInt(lengthMatch[1], 10);
      const frameLength = headerEnd + 4 + bodyLength;
      if (this.stdoutBuffer.length < frameLength) {
        return;
      }

      const body = this.stdoutBuffer.subarray(headerEnd + 4, frameLength).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameLength);

      let message = null;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.failAll(error);
        return;
      }

      if (message?.id === undefined || message?.id === null) {
        continue;
      }

      const entry = this.pending.get(message.id);
      if (!entry) {
        continue;
      }

      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      entry.resolve(message);
    }
  }

  failAll(error) {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  request(method, params = {}, timeoutMs = 20000) {
    if (this.closed) {
      return Promise.reject(new Error('bridge process is already closed'));
    }

    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeFrame(payload));
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }

    const payload = { jsonrpc: '2.0', method, params };
    this.child.stdin.write(encodeFrame(payload));
  }
}

async function runBridgeProbe(env = {}) {
  const child = spawn(process.execPath, [bridgeEntry, 'probe'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const code = await new Promise((resolve) => {
    child.on('exit', resolve);
  });

  return {
    code,
    stdout,
    stderr,
    json: parseMaybeJson(stdout.trim()),
  };
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    timeoutMs = 30000,
  } = options;
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let killTimer = null;

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  if (timeoutMs > 0) {
    killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
  }

  const { code, signal } = await new Promise((resolve) => {
    child.on('exit', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });

  if (killTimer) {
    clearTimeout(killTimer);
  }

  return { code, signal, timedOut, stdout, stderr };
}

async function waitForProbe(predicate, options = {}) {
  const {
    timeoutMs = 20000,
    intervalMs = 1000,
    label = 'probe condition',
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;

  while (Date.now() < deadline) {
    lastProbe = await runBridgeProbe();
    if (predicate(lastProbe.json, lastProbe)) {
      return lastProbe;
    }
    await delay(intervalMs);
  }

  const error = new Error(`timeout waiting for ${label}`);
  error.stage = label;
  error.detail = lastProbe;
  throw error;
}

function extractExecHealthSummary(output) {
  const pidMatch = output.match(/"pid"\s*:\s*(\d+)/);
  const socketMatch = output.match(/"socket_path"\s*:\s*"([^"]+)"/);
  return {
    pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
    socketPath: socketMatch ? socketMatch[1] : null,
    connectOk: /"connect_ok"\s*:\s*true/.test(output),
    statusOk: /"status_ok"\s*:\s*true/.test(output),
    outputTail: output.slice(-1600),
  };
}

async function runCodexExecHealth() {
  const result = await runCommand(
    process.execPath,
    [
      launcherEntry,
      '--full-auto',
      'exec',
      '--skip-git-repo-check',
      '--json',
      'Use the MCP tool named mcp__codex_chrome_bridge__browser_health exactly once. If unavailable, say so explicitly.',
    ],
    { timeoutMs: 90000 },
  );

  assert(
    result.timedOut === false && result.code === 0,
    'codex_exec(browser_health)',
    'repo-local codex exec health smoke failed',
    result,
  );

  const summary = extractExecHealthSummary(result.stdout);
  assert(
    summary.connectOk && summary.statusOk,
    'codex_exec(browser_health)',
    'codex exec output did not show a healthy browser bridge',
    summary,
  );

  return summary;
}

function spawnBogusCandidate() {
  const script = `
    const net = require('node:net');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const root = process.env.CLAUDE_BRIDGE_SOCKET_ROOT || path.join('/tmp', 'claude-mcp-browser-bridge-' + os.userInfo().username);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const socketPath = path.join(root, process.pid + '.sock');
    try { fs.unlinkSync(socketPath); } catch {}
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        const body = Buffer.from(JSON.stringify({ error: { content: 'bogus candidate host' } }));
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(body.length, 0);
        socket.end(Buffer.concat([prefix, body]));
      });
    });
    server.listen(socketPath);
    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    setInterval(() => {}, 1000);
  `;

  return spawn(process.execPath, ['-e', script, '--', '--chrome-native-host'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function assert(condition, stage, message, detail = null) {
  if (!condition) {
    const error = new Error(message);
    error.stage = stage;
    error.detail = detail;
    throw error;
  }
}

function summarizeToolResponse(response) {
  const structured = response?.result?.structuredContent ?? null;
  const text = extractText(response?.result);
  return {
    structured,
    text,
    isError: Boolean(response?.result?.isError),
  };
}

async function run() {
  const child = spawn(process.execPath, [bridgeEntry, 'mcp'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const validationServer = await startValidationHttpServer();

  const client = new JsonRpcClient(child);
  const summary = {
    ok: false,
    stage: 'init',
    steps: [],
  };

  const record = (name, result) => {
    summary.steps.push({ name, ok: true, result });
  };
  const noteStage = (stage) => {
    process.stderr.write(`[validate-stage] ${stage}\n`);
  };

  const cleanupTabIds = [];

  const fail = (stage, error) => {
    summary.ok = false;
    summary.stage = stage;
    summary.error = summarizeError(error);
    summary.bridge_stderr = client.stderrBuffer || null;
    return summary;
  };

  let churnBaseline = null;
  try {
    const validationUrl = `https://example.org/?validate-bridge=${Date.now()}`;
    const baselineProbe = await runBridgeProbe();
    const baselineProbeData = baselineProbe.json;
    const hadManagedTabGroupBeforeValidation = Boolean(
      baselineProbeData?.connect_ok === true &&
        baselineProbeData?.status_ok === true &&
        baselineProbeData?.status_payload &&
        Array.isArray(baselineProbeData.status_payload.availableTabs),
    );
    let bootstrapTabId = null;

    summary.stage = 'initialize';
    const initialize = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'validate-bridge', version: '0.1.0' },
    });
    assert(initialize.result, 'initialize', 'initialize returned no result', initialize);
    record('initialize', initialize.result);

    client.notify('notifications/initialized', {});

    summary.stage = 'tools/list';
    const toolsList = await client.request('tools/list', {});
    const toolDefinitions = toolDefinitionsByName(toolsList.result?.tools);
    const toolNames = Array.isArray(toolsList.result?.tools)
      ? toolsList.result.tools.map((tool) => tool?.name).filter(Boolean)
      : [];
    for (const toolName of expectedTools) {
      assert(
        toolNames.includes(toolName),
        'tools/list',
        `missing tool ${toolName}`,
        toolNames,
      );
    }
    record('tools/list', toolNames);

    const optionalSurface = futureOptionalTools.map((name) => ({
      name,
      present: toolNames.includes(name),
    }));
    record('future_optional_tools', optionalSurface);

    const optionalTabsContext = toolDefinitions.get('browser_tabs_context');
    if (optionalTabsContext) {
      summary.stage = 'browser_tabs_context';
      noteStage(summary.stage);
      const tabsContext = await client.request('tools/call', {
        name: 'browser_tabs_context',
        arguments: {
          createIfEmpty: true,
        },
      });
      const tabsContextPayload = summarizeToolResponse(tabsContext);
      const tabsContextData = parseMaybeJson(
        tabsContextPayload.structured ?? tabsContextPayload.text,
      );
      assert(
        tabsContextData &&
          typeof tabsContextData === 'object' &&
          !tabsContextPayload.isError &&
          (tabsContextData.browser_context ||
            tabsContextData.availableTabs ||
            tabsContextData.tabGroups),
        'browser_tabs_context',
        'browser_tabs_context did not return a browser context payload',
        tabsContextData,
      );
    record('browser_tabs_context', tabsContextData);
    if (
      !hadManagedTabGroupBeforeValidation &&
      Array.isArray(tabsContextData?.browser_context?.availableTabs) &&
      tabsContextData.browser_context.availableTabs.length === 1
    ) {
      const bootstrapTab = tabsContextData.browser_context.availableTabs[0];
      if (
        Number.isFinite(Number(bootstrapTab?.tabId)) &&
        String(bootstrapTab?.url ?? '') === 'chrome://newtab/'
      ) {
        bootstrapTabId = Number(bootstrapTab.tabId);
      }
    }
    }

    let stagedCreateTabId = null;
    const optionalCreateTab = toolDefinitions.get('browser_create_tab');
    if (optionalCreateTab) {
      summary.stage = 'browser_create_tab';
      noteStage(summary.stage);
      const createTabArguments = toolRequires(optionalCreateTab, 'url') ? { url: validationUrl } : {};
      const createTab = await client.request('tools/call', {
        name: 'browser_create_tab',
        arguments: createTabArguments,
      });
      const createTabPayload = summarizeToolResponse(createTab);
      const createTabData = parseMaybeJson(createTabPayload.structured ?? createTabPayload.text);
      assert(
        createTabData && !createTabPayload.isError,
        'browser_create_tab',
        'browser_create_tab did not return a usable response',
        createTabData,
      );
      if (Number.isFinite(Number(createTabData?.tabId))) {
        stagedCreateTabId = Number(createTabData.tabId);
        cleanupTabIds.push(stagedCreateTabId);
      }
      record('browser_create_tab', createTabData);
    }

    const optionalNavigateTab = toolDefinitions.get('browser_navigate_tab');
    if (optionalNavigateTab && Number.isFinite(stagedCreateTabId)) {
      try {
        summary.stage = 'browser_navigate_tab';
        noteStage(summary.stage);
        const navigateTab = await client.request('tools/call', {
          name: 'browser_navigate_tab',
          arguments: {
            tabId: stagedCreateTabId,
            url: validationUrl,
          },
        });
        const navigateTabPayload = summarizeToolResponse(navigateTab);
        const navigateTabData = parseMaybeJson(
          navigateTabPayload.structured ?? navigateTabPayload.text,
        );
        assert(
          navigateTabData && !navigateTabPayload.isError,
          'browser_navigate_tab',
          'browser_navigate_tab did not return a usable response',
          navigateTabData,
        );
        record('browser_navigate_tab', navigateTabData);
      } catch (error) {
        record('browser_navigate_tab(optional-warning)', {
          ok: false,
          error: summarizeError(error),
        });
      }
    }

    if (Number.isFinite(stagedCreateTabId)) {
      summary.stage = 'browser_close_tab(optional-create)';
      const closeOptionalCreate = await client.request('tools/call', {
        name: 'browser_close_tab',
        arguments: {
          tabId: stagedCreateTabId,
        },
      });
      const closeOptionalCreatePayload = summarizeToolResponse(closeOptionalCreate);
      const closeOptionalCreateData = parseMaybeJson(
        closeOptionalCreatePayload.structured ?? closeOptionalCreatePayload.text,
      );
      assert(
        closeOptionalCreateData && !closeOptionalCreatePayload.isError,
        'browser_close_tab(optional-create)',
        'browser_close_tab did not close the optional created tab',
        closeOptionalCreateData,
      );
      record('browser_close_tab(optional-create)', closeOptionalCreateData);
      const cleanupIndex = cleanupTabIds.indexOf(stagedCreateTabId);
      if (cleanupIndex !== -1) {
        cleanupTabIds.splice(cleanupIndex, 1);
      }
      stagedCreateTabId = null;
    }

    summary.stage = 'browser_health';
    const health = await client.request('tools/call', {
      name: 'browser_health',
      arguments: {},
    });
    const healthPayload = summarizeToolResponse(health);
    const healthData = parseMaybeJson(healthPayload.structured ?? healthPayload.text);
    assert(
      healthData && healthData.connect_ok === true && healthData.status_ok === true,
      'browser_health',
      'browser_health did not report a healthy bridge',
      healthData,
    );
    record('browser_health', healthData);

    summary.stage = 'probe(missing-host)';
    const missingHost = await runBridgeProbe({
      CLAUDE_BRIDGE_SOCKET_ROOT: path.join(os.tmpdir(), `codex-bridge-missing-${Date.now()}`),
    });
    const missingHostData = missingHost.json;
    assert(
      missingHostData &&
        missingHostData.connect_ok === false &&
        missingHostData.failure_stage === 'discover',
      'probe(missing-host)',
      'probe did not report discover failure for missing socket root',
      missingHost,
    );
    record('probe(missing-host)', missingHostData);

    summary.stage = 'probe(bogus-candidate)';
    const bogusCandidate = spawnBogusCandidate();
    try {
      await delay(250);
      const bogusProbe = await runBridgeProbe();
      const bogusData = bogusProbe.json;
      assert(
        bogusData &&
          bogusData.host_process &&
          bogusData.host_process.pid !== bogusCandidate.pid,
        'probe(bogus-candidate)',
        'probe selected the bogus candidate instead of the live host',
        { bogusPid: bogusCandidate.pid, bogusData },
      );
      const bogusRejected = Array.isArray(bogusData.candidate_attempts)
        ? bogusData.candidate_attempts.some(
            (entry) => entry.pid === bogusCandidate.pid && entry.ok === false,
          )
        : false;
      const multipleCandidatesDetected =
        Array.isArray(bogusData.warnings) &&
        bogusData.warnings.includes('multiple_socket_candidates_detected');
      assert(
        bogusRejected || multipleCandidatesDetected,
        'probe(bogus-candidate)',
        'probe neither rejected nor detected the extra bogus candidate',
        { bogusPid: bogusCandidate.pid, bogusData },
      );
      record('probe(bogus-candidate)', {
        bogusPid: bogusCandidate.pid,
        selectedPid: bogusData.host_process.pid,
        bogusRejected,
        warnings: bogusData.warnings,
        candidate_attempts: bogusData.candidate_attempts,
      });
    } finally {
      bogusCandidate.kill('SIGTERM');
      await delay(200);
    }

    summary.stage = 'browser_snapshot';
    const snapshot = await client.request('tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    });
    const snapshotPayload = summarizeToolResponse(snapshot);
    const snapshotData = parseMaybeJson(snapshotPayload.structured ?? snapshotPayload.text);
    assert(
      snapshotData && snapshotData.source === 'claude-code-native-host',
      'browser_snapshot',
      'browser_snapshot returned an unexpected payload',
      snapshotData,
    );
    record('browser_snapshot', snapshotData);

    if (!enableLiveBrowser) {
      record('live_browser_surface', {
        skipped: true,
        reason:
          'live browser sweep is disabled by default to avoid repeated CiC permission popups; rerun with --live-browser for approval-heavy validation',
      });
      if (Number.isFinite(bootstrapTabId)) {
        summary.stage = 'browser_close_tab(bootstrap)';
        const closeBootstrap = await client.request('tools/call', {
          name: 'browser_close_tab',
          arguments: {
            tabId: bootstrapTabId,
          },
        });
        const closeBootstrapPayload = summarizeToolResponse(closeBootstrap);
        const closeBootstrapData = parseMaybeJson(
          closeBootstrapPayload.structured ?? closeBootstrapPayload.text,
        );
        assert(
          closeBootstrapData && !closeBootstrapPayload.isError,
          'browser_close_tab(bootstrap)',
          'browser_close_tab did not close the bootstrap tab created by createIfEmpty',
          closeBootstrapData,
        );
        record('browser_close_tab(bootstrap)', closeBootstrapData);
      }
    } else {
      summary.stage = 'browser_open_or_focus';
      noteStage(summary.stage);
      const open = await client.request('tools/call', {
        name: 'browser_open_or_focus',
        arguments: { url: validationUrl },
      });
      const openPayload = summarizeToolResponse(open);
      const openData = parseMaybeJson(openPayload.structured ?? openPayload.text);
      assert(
        openData &&
          ['open', 'reuse'].includes(openData.action_taken) &&
          Number.isFinite(openData.tabId),
        'browser_open_or_focus',
        'browser_open_or_focus did not return a usable tab',
        openData,
      );
      record('browser_open_or_focus', openData);

      await new Promise((resolve) => setTimeout(resolve, 1000));

      summary.stage = 'browser_open_or_focus(reuse-first)';
      noteStage(summary.stage);
      const openReuse = await client.request('tools/call', {
        name: 'browser_open_or_focus',
        arguments: { url: validationUrl },
      });
      const openReusePayload = summarizeToolResponse(openReuse);
      const openReuseData = parseMaybeJson(openReusePayload.structured ?? openReusePayload.text);
      assert(
        openReuseData &&
          openReuseData.action_taken === 'reuse' &&
          Number(openReuseData.tabId) === Number(openData.tabId),
        'browser_open_or_focus(reuse-first)',
        'browser_open_or_focus did not reuse the exact visible URL',
        openReuseData,
      );
      record('browser_open_or_focus(reuse-first)', openReuseData);

      summary.stage = 'browser_reuse_tab';
      const reuse = await client.request('tools/call', {
        name: 'browser_reuse_tab',
        arguments: {
          tabId: openData.tabId,
        },
      });
      const reusePayload = summarizeToolResponse(reuse);
      const reuseData = parseMaybeJson(reusePayload.structured ?? reusePayload.text);
      assert(
        reuseData &&
          reuseData.action_taken === 'reuse_confirmed' &&
          Number(reuseData.matched_tab?.tabId) === Number(openData.tabId),
        'browser_reuse_tab',
        'browser_reuse_tab did not confirm the expected tab',
        reuseData,
      );
      record('browser_reuse_tab', reuseData);

      const uniqueVisibleUrl = selectUniqueVisibleUrl(reuseData?.browser_context);
      assert(
        uniqueVisibleUrl && Number.isFinite(uniqueVisibleUrl.tabId),
        'browser_reuse_tab(url)',
        'could not find a unique visible URL candidate for exact-URL reuse validation',
        reuseData?.browser_context,
      );

      summary.stage = 'browser_reuse_tab(url)';
      const reuseByUrl = await client.request('tools/call', {
        name: 'browser_reuse_tab',
        arguments: {
          url: uniqueVisibleUrl.url,
        },
      });
      const reuseByUrlPayload = summarizeToolResponse(reuseByUrl);
      const reuseByUrlData = parseMaybeJson(
        reuseByUrlPayload.structured ?? reuseByUrlPayload.text,
      );
      assert(
        reuseByUrlData &&
          reuseByUrlData.action_taken === 'reuse_confirmed' &&
          Number(reuseByUrlData.matched_tab?.tabId) === Number(uniqueVisibleUrl.tabId),
        'browser_reuse_tab(url)',
        'browser_reuse_tab(url) did not confirm the expected unique visible tab',
        reuseByUrlData,
      );
      record('browser_reuse_tab(url)', reuseByUrlData);

      summary.stage = 'browser_console_messages(enable)';
      noteStage(summary.stage);
      const consoleMessagesEnable = await client.request('tools/call', {
        name: 'browser_console_messages',
        arguments: {
          tabId: openData.tabId,
          pattern: 'bridge-console-smoke',
          clear: true,
          limit: 20,
        },
      });
      const consoleMessagesEnablePayload = summarizeToolResponse(consoleMessagesEnable);
      const consoleMessagesEnableData = parseMaybeJson(
        consoleMessagesEnablePayload.structured ?? consoleMessagesEnablePayload.text,
      );
      assert(
        consoleMessagesEnableData && !consoleMessagesEnablePayload.isError,
        'browser_console_messages(enable)',
        'browser_console_messages did not return a usable response',
        consoleMessagesEnableData,
      );
      record('browser_console_messages(enable)', consoleMessagesEnableData);

      summary.stage = 'browser_network_requests(enable)';
      noteStage(summary.stage);
      const networkRequestsEnable = await client.request('tools/call', {
        name: 'browser_network_requests',
        arguments: {
          tabId: openData.tabId,
          urlPattern: 'validate-network=',
          clear: true,
          limit: 20,
        },
      });
      const networkRequestsEnablePayload = summarizeToolResponse(networkRequestsEnable);
      const networkRequestsEnableData = parseMaybeJson(
        networkRequestsEnablePayload.structured ?? networkRequestsEnablePayload.text,
      );
      assert(
        networkRequestsEnableData && !networkRequestsEnablePayload.isError,
        'browser_network_requests(enable)',
        'browser_network_requests did not return a usable response',
        networkRequestsEnableData,
      );
      record('browser_network_requests(enable)', networkRequestsEnableData);

      summary.stage = 'browser_javascript_exec';
      noteStage(summary.stage);
      const javascriptExec = await client.request('tools/call', {
        name: 'browser_javascript_exec',
        arguments: {
          tabId: openData.tabId,
        script:
          `(() => {
            if (!document.querySelector('#target-input')) {
              document.title = 'Bridge Validation Harness';
              const container = document.createElement('section');
              container.id = 'bridge-validation-harness';
              container.innerHTML = '<article>Bronze hound validation article text for bridge_get_page_text.</article><label for="target-input">Validation Name</label><input id="target-input" type="text" value="" /><output id="key-status"></output><button id="hover-target" type="button">Hover target</button><output id="hover-status"></output><button id="context-target" type="button">Context target</button><output id="context-status"></output><button id="double-click-target" type="button">Double click target</button><output id="double-click-status"></output><button id="triple-click-target" type="button">Triple click target</button><output id="triple-click-status"></output><div id="drag-lane" style="display:flex;gap:180px;align-items:center;margin:24px 0;"><button id="drag-source" type="button">Drag source</button><button id="drag-target" type="button">Drag target</button></div><output id="drag-status"></output><label for="upload-file-input">Validation File</label><input id="upload-file-input" type="file" /><label for="upload-image-input">Validation Image</label><input id="upload-image-input" type="file" accept="image/*" /><output id="upload-status"></output><button id="submit-button" type="button">Submit validation form</button><ul><li class="candidate">Candidate One</li><li class="candidate">Candidate Two</li></ul><div id="scroll-spacer" style="height: 1800px;"></div><button id="scroll-target-button" type="button">Scroll target button</button><div id="scroll-target">Scroll target marker</div>';
              document.body.appendChild(container);
              const bindUploadStatus = (selector) => {
                const input = document.querySelector(selector);
                const status = document.querySelector('#upload-status');
                if (input && status) {
                  input.addEventListener('change', () => {
                    status.textContent = Array.from(input.files || []).map((file) => file.name).join(',');
                  });
                }
              };
              const hoverTarget = document.querySelector('#hover-target');
              const hoverStatus = document.querySelector('#hover-status');
              const keyTarget = document.querySelector('#target-input');
              const keyStatus = document.querySelector('#key-status');
              if (keyTarget && keyStatus) {
                keyTarget.addEventListener('keydown', (event) => {
                  keyStatus.textContent = event.key;
                });
              }
              if (hoverTarget && hoverStatus) {
                const markHovered = () => {
                  hoverStatus.textContent = 'hovered';
                };
                ['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove'].forEach((eventName) => {
                  hoverTarget.addEventListener(eventName, markHovered);
                });
              }
              const contextTarget = document.querySelector('#context-target');
              const contextStatus = document.querySelector('#context-status');
              if (contextTarget && contextStatus) {
                contextTarget.addEventListener('contextmenu', (event) => {
                  event.preventDefault();
                  contextStatus.textContent = 'context-opened';
                });
              }
              const doubleClickTarget = document.querySelector('#double-click-target');
              const doubleClickStatus = document.querySelector('#double-click-status');
              if (doubleClickTarget && doubleClickStatus) {
                doubleClickTarget.addEventListener('dblclick', () => {
                  doubleClickStatus.textContent = 'double-clicked';
                });
              }
              const tripleClickTarget = document.querySelector('#triple-click-target');
              const tripleClickStatus = document.querySelector('#triple-click-status');
              if (tripleClickTarget && tripleClickStatus) {
                tripleClickTarget.addEventListener('click', (event) => {
                  tripleClickStatus.textContent = String(event.detail);
                });
              }
              const dragSource = document.querySelector('#drag-source');
              const dragTarget = document.querySelector('#drag-target');
              const dragStatus = document.querySelector('#drag-status');
              if (dragSource && dragTarget && dragStatus) {
                let dragActive = false;
                let dragMoved = false;
                let dragReachedTarget = false;
                dragSource.addEventListener('mousedown', () => {
                  dragActive = true;
                  dragMoved = false;
                  dragReachedTarget = false;
                  dragStatus.textContent = 'drag-start';
                });
                document.addEventListener('mousemove', (event) => {
                  if (!dragActive) {
                    return;
                  }
                  dragMoved = true;
                  if (event.target === dragTarget || dragTarget.contains(event.target)) {
                    dragReachedTarget = true;
                  }
                });
                dragTarget.addEventListener('mouseenter', () => {
                  if (dragActive) {
                    dragReachedTarget = true;
                  }
                });
                document.addEventListener('mouseup', () => {
                  if (!dragActive) {
                    return;
                  }
                  dragStatus.textContent =
                    dragMoved && dragReachedTarget ? 'drag-complete' : 'drag-cancelled';
                  dragActive = false;
                  dragMoved = false;
                  dragReachedTarget = false;
                });
              }
              bindUploadStatus('#upload-file-input');
              bindUploadStatus('#upload-image-input');
            }
            console.log('bridge-console-smoke');
            fetch('${validationServer.origin}/?validate-network=' + Date.now(), { cache: 'no-store', mode: 'no-cors' }).catch(() => null);
            return JSON.stringify({
              title: document.title,
              candidateCount: document.querySelectorAll('.candidate').length,
              inputValue: document.querySelector('#target-input')?.value ?? null
            });
          })()`,
      },
      });
      const javascriptExecPayload = summarizeToolResponse(javascriptExec);
      const javascriptExecData = parseMaybeJson(
        javascriptExecPayload.structured ?? javascriptExecPayload.text,
      );
      const javascriptResult =
        typeof javascriptExecData?.result === 'object' && javascriptExecData.result !== null
          ? javascriptExecData.result
          : parseMaybeJson(javascriptExecData?.result);
      assert(
        javascriptExecData &&
          javascriptExecData.action_taken === 'javascript_exec' &&
          javascriptResult?.title === 'Bridge Validation Harness' &&
          javascriptResult?.candidateCount === 2,
        'browser_javascript_exec',
        'browser_javascript_exec did not return the expected DOM result',
        javascriptExecData,
      );
      record('browser_javascript_exec', javascriptExecData);

    await delay(1000);

    summary.stage = 'browser_get_page_text';
    noteStage(summary.stage);
    const getPageText = await client.request('tools/call', {
      name: 'browser_get_page_text',
      arguments: {
        tabId: openData.tabId,
        maxChars: 5000,
      },
    });
    const getPageTextPayload = summarizeToolResponse(getPageText);
    const getPageTextData = parseMaybeJson(
      getPageTextPayload.structured ?? getPageTextPayload.text,
    );
    assert(
      getPageTextData &&
        getPageTextData.action_taken === 'get_page_text' &&
        typeof getPageTextData.text === 'string' &&
        getPageTextData.text.includes('Bridge Validation Harness'),
      'browser_get_page_text',
      'browser_get_page_text did not return the expected validation text',
      getPageTextData,
    );
    record('browser_get_page_text', getPageTextData);

    summary.stage = 'browser_read_page';
    noteStage(summary.stage);
    const readPage = await client.request('tools/call', {
      name: 'browser_read_page',
      arguments: {
        tabId: openData.tabId,
        filter: 'interactive',
        depth: 6,
        maxChars: 5000,
      },
    });
    const readPagePayload = summarizeToolResponse(readPage);
    const readPageData = parseMaybeJson(readPagePayload.structured ?? readPagePayload.text);
    const readPageText =
      typeof readPageData?.text === 'string'
        ? readPageData.text
        : extractPrimaryValue(readPageData?.result);
    const readPageRef = extractFirstRef(readPageData?.result ?? readPageText);
    const readPageViewport = extractViewportSize(readPageText);
    assert(
      readPageData &&
        readPageData.action_taken === 'read_page' &&
        typeof readPageText === 'string' &&
        readPageText.includes('Validation Name') &&
        typeof readPageRef === 'string',
      'browser_read_page',
      'browser_read_page did not return the expected accessibility-tree content',
      readPageData,
    );
    record('browser_read_page', readPageData);

    const optionalResizeWindow = toolDefinitions.get('browser_resize_window');
    if (optionalResizeWindow && readPageViewport) {
      summary.stage = 'browser_resize_window';
      const resizeWindow = await client.request('tools/call', {
        name: 'browser_resize_window',
        arguments: {
          tabId: openData.tabId,
          width: readPageViewport.width,
          height: readPageViewport.height,
        },
      });
      const resizeWindowPayload = summarizeToolResponse(resizeWindow);
      const resizeWindowData = parseMaybeJson(
        resizeWindowPayload.structured ?? resizeWindowPayload.text,
      );
      assert(
        resizeWindowData && !resizeWindowPayload.isError,
        'browser_resize_window',
        'browser_resize_window did not return a usable response',
        resizeWindowData,
      );
      record('browser_resize_window', resizeWindowData);
    }

    summary.stage = 'browser_console_messages';
    noteStage(summary.stage);
    const consoleMessages = await client.request('tools/call', {
      name: 'browser_console_messages',
      arguments: {
        tabId: openData.tabId,
        pattern: 'bridge-console-smoke',
        clear: true,
        limit: 20,
      },
    });
    const consoleMessagesPayload = summarizeToolResponse(consoleMessages);
    const consoleMessagesData = parseMaybeJson(
      consoleMessagesPayload.structured ?? consoleMessagesPayload.text,
    );
    const consoleMessagesResult = extractPrimaryValue(consoleMessagesData?.result);
    assert(
      consoleMessagesData &&
        !consoleMessagesPayload.isError &&
        typeof consoleMessagesResult === 'string' &&
        consoleMessagesResult.includes('bridge-console-smoke'),
      'browser_console_messages',
      'browser_console_messages did not capture the emitted console message',
      consoleMessagesData,
    );
    record('browser_console_messages', consoleMessagesData);

    summary.stage = 'browser_network_requests';
    noteStage(summary.stage);
    const networkRequests = await client.request('tools/call', {
      name: 'browser_network_requests',
      arguments: {
        tabId: openData.tabId,
        urlPattern: 'validate-network=',
        clear: true,
        limit: 20,
      },
    });
    const networkRequestsPayload = summarizeToolResponse(networkRequests);
    const networkRequestsData = parseMaybeJson(
      networkRequestsPayload.structured ?? networkRequestsPayload.text,
    );
    const networkRequestsResult = extractPrimaryValue(networkRequestsData?.result);
    assert(
      networkRequestsData &&
        !networkRequestsPayload.isError &&
        typeof networkRequestsResult === 'string' &&
        networkRequestsResult.includes('validate-network='),
      'browser_network_requests',
      'browser_network_requests did not capture the emitted request',
      networkRequestsData,
    );
    record('browser_network_requests', networkRequestsData);

    const optionalScreenshot = toolDefinitions.get('browser_screenshot');
    const optionalUploadFile = toolDefinitions.get('browser_upload_file');
    const optionalUploadImage = toolDefinitions.get('browser_upload_image');
    let uploadFileRef = null;
    let uploadImageRef = null;
    if (optionalUploadFile || optionalUploadImage) {
      uploadFileRef = optionalUploadFile ? extractRefByLabel(readPageText, 'Validation File') : null;
      uploadImageRef = optionalUploadImage
        ? extractRefByLabel(readPageText, 'Validation Image')
        : null;
      if (optionalUploadFile) {
        assert(
          uploadFileRef,
          'browser_read_page(upload-file-ref)',
          'could not locate the file upload ref in read_page output',
          readPageData,
        );
        record('browser_read_page(upload-file-ref)', { ref: uploadFileRef });
      }
      if (optionalUploadImage) {
        assert(
          uploadImageRef,
          'browser_read_page(upload-image-ref)',
          'could not locate the image upload ref in read_page output',
          readPageData,
        );
        record('browser_read_page(upload-image-ref)', { ref: uploadImageRef });
      }
    }
    const uploadArtifacts = [];
    const uploadSmokeDir = path.join(os.tmpdir(), `codex-bridge-upload-smoke-${Date.now()}`);
    const sampleTextFile = path.join(uploadSmokeDir, 'bridge-upload-smoke.txt');
    const sampleImageFile = path.join(uploadSmokeDir, 'bridge-upload-smoke.png');
    const createUploadArtifacts = () => {
      if (uploadArtifacts.length > 0) {
        return;
      }
      fs.mkdirSync(uploadSmokeDir, { recursive: true });
      fs.writeFileSync(sampleTextFile, 'bridge upload smoke\n', 'utf8');
      fs.writeFileSync(
        sampleImageFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      uploadArtifacts.push(sampleTextFile, sampleImageFile);
    };

    if (optionalUploadFile) {
      createUploadArtifacts();
      summary.stage = 'browser_upload_file';
      const uploadFile = await client.request('tools/call', {
        name: 'browser_upload_file',
        arguments: {
          tabId: openData.tabId,
          selector: '#upload-file-input',
          paths: [sampleTextFile],
        },
      });
      const uploadFilePayload = summarizeToolResponse(uploadFile);
      const uploadFileData = parseMaybeJson(uploadFilePayload.structured ?? uploadFilePayload.text);
      assert(
        uploadFileData && !uploadFilePayload.isError && uploadFileData?.ok !== false,
        'browser_upload_file',
        'browser_upload_file did not return a usable response',
        uploadFileData,
      );
      record('browser_upload_file', uploadFileData);

      summary.stage = 'browser_javascript_exec(upload-file-check)';
      const uploadFileCheck = await client.request('tools/call', {
        name: 'browser_javascript_exec',
        arguments: {
          tabId: openData.tabId,
          script:
            'JSON.stringify({ fileName: document.querySelector("#upload-file-input")?.files?.[0]?.name ?? null, uploadStatus: document.querySelector("#upload-status")?.textContent ?? "" })',
        },
      });
      const uploadFileCheckPayload = summarizeToolResponse(uploadFileCheck);
      const uploadFileCheckData = parseMaybeJson(
        uploadFileCheckPayload.structured ?? uploadFileCheckPayload.text,
      );
      const uploadFileCheckResult =
        typeof uploadFileCheckData?.result === 'object' &&
        uploadFileCheckData.result !== null
          ? uploadFileCheckData.result
          : parseMaybeJson(uploadFileCheckData?.result);
      assert(
        uploadFileCheckData &&
          uploadFileCheckResult?.fileName === path.basename(sampleTextFile),
        'browser_javascript_exec(upload-file-check)',
        'browser_upload_file did not update the file input state',
        uploadFileCheckData,
      );
      record('browser_javascript_exec(upload-file-check)', uploadFileCheckData);
    }

    let screenshotImageId = null;
    if (optionalScreenshot && optionalUploadImage) {
      summary.stage = 'browser_screenshot';
      const screenshot = await client.request('tools/call', {
        name: 'browser_screenshot',
        arguments: {
          tabId: openData.tabId,
        },
      });
      const screenshotPayload = summarizeToolResponse(screenshot);
      const screenshotData = parseMaybeJson(
        screenshotPayload.structured ?? screenshotPayload.text,
      );
      assert(
        screenshotData &&
          !screenshotPayload.isError &&
          typeof screenshotData?.imageId === 'string' &&
          screenshotData.imageId.length > 0,
        'browser_screenshot',
        'browser_screenshot did not return a cacheable imageId',
        screenshotData,
      );
      screenshotImageId = screenshotData.imageId;
      record('browser_screenshot', screenshotData);

      summary.stage = 'browser_upload_image(imageId)';
      const uploadImage = await client.request('tools/call', {
        name: 'browser_upload_image',
        arguments: {
          tabId: openData.tabId,
          selector: '#upload-image-input',
          imageId: screenshotImageId,
          filename: 'bridge-screenshot-upload.png',
        },
      });
      const uploadImagePayload = summarizeToolResponse(uploadImage);
      const uploadImageData = parseMaybeJson(
        uploadImagePayload.structured ?? uploadImagePayload.text,
      );
      assert(
        uploadImageData && !uploadImagePayload.isError && uploadImageData?.ok !== false,
        'browser_upload_image(imageId)',
        'browser_upload_image did not succeed with a screenshot-backed imageId',
        uploadImageData,
      );
      record('browser_upload_image(imageId)', uploadImageData);

      summary.stage = 'browser_javascript_exec(upload-image-check)';
      const uploadImageCheck = await client.request('tools/call', {
        name: 'browser_javascript_exec',
        arguments: {
          tabId: openData.tabId,
          script:
            'JSON.stringify({ imageName: document.querySelector("#upload-image-input")?.files?.[0]?.name ?? null, imageCount: document.querySelector("#upload-image-input")?.files?.length ?? 0 })',
        },
      });
      const uploadImageCheckPayload = summarizeToolResponse(uploadImageCheck);
      const uploadImageCheckData = parseMaybeJson(
        uploadImageCheckPayload.structured ?? uploadImageCheckPayload.text,
      );
      const uploadImageCheckResult =
        typeof uploadImageCheckData?.result === 'object' &&
        uploadImageCheckData.result !== null
          ? uploadImageCheckData.result
          : parseMaybeJson(uploadImageCheckData?.result);
      assert(
        uploadImageCheckData &&
          uploadImageCheckResult?.imageName === 'bridge-screenshot-upload.png' &&
          uploadImageCheckResult?.imageCount === 1,
        'browser_javascript_exec(upload-image-check)',
        'browser_upload_image(imageId) did not update the image input state',
        uploadImageCheckData,
      );
      record('browser_javascript_exec(upload-image-check)', uploadImageCheckData);

      createUploadArtifacts();
      summary.stage = 'browser_upload_image(path)';
      const uploadImageFromPath = await client.request('tools/call', {
        name: 'browser_upload_image',
        arguments: {
          tabId: openData.tabId,
          selector: '#upload-image-input',
          path: sampleImageFile,
          filename: 'bridge-path-upload.png',
        },
      });
      const uploadImageFromPathPayload = summarizeToolResponse(uploadImageFromPath);
      const uploadImageFromPathData = parseMaybeJson(
        uploadImageFromPathPayload.structured ?? uploadImageFromPathPayload.text,
      );
      assert(
        uploadImageFromPathData &&
          !uploadImageFromPathPayload.isError &&
          uploadImageFromPathData?.ok !== false,
        'browser_upload_image(path)',
        'browser_upload_image did not succeed with a local image path',
        uploadImageFromPathData,
      );
      record('browser_upload_image(path)', uploadImageFromPathData);

      summary.stage = 'browser_javascript_exec(upload-image-path-check)';
      const uploadImagePathCheck = await client.request('tools/call', {
        name: 'browser_javascript_exec',
        arguments: {
          tabId: openData.tabId,
          script:
            'JSON.stringify({ imageName: document.querySelector("#upload-image-input")?.files?.[0]?.name ?? null, imageCount: document.querySelector("#upload-image-input")?.files?.length ?? 0 })',
        },
      });
      const uploadImagePathCheckPayload = summarizeToolResponse(uploadImagePathCheck);
      const uploadImagePathCheckData = parseMaybeJson(
        uploadImagePathCheckPayload.structured ?? uploadImagePathCheckPayload.text,
      );
      const uploadImagePathCheckResult =
        typeof uploadImagePathCheckData?.result === 'object' &&
        uploadImagePathCheckData.result !== null
          ? uploadImagePathCheckData.result
          : parseMaybeJson(uploadImagePathCheckData?.result);
      assert(
        uploadImagePathCheckData &&
          uploadImagePathCheckResult?.imageName === 'bridge-path-upload.png' &&
          uploadImagePathCheckResult?.imageCount === 1,
        'browser_javascript_exec(upload-image-path-check)',
        'browser_upload_image(path) did not update the image input state',
        uploadImagePathCheckData,
      );
      record('browser_javascript_exec(upload-image-path-check)', uploadImagePathCheckData);
    }

    summary.stage = 'browser_find';
    noteStage(summary.stage);
    const find = await client.request('tools/call', {
      name: 'browser_find',
      arguments: {
        tabId: openData.tabId,
        query: 'Validation Name input field',
      },
    });
    const findPayload = summarizeToolResponse(find);
    const findData = parseMaybeJson(findPayload.structured ?? findPayload.text);
    const foundRef = extractFirstRef(findData?.result);
    assert(
      findData &&
        findData.action_taken === 'find' &&
        typeof foundRef === 'string',
      'browser_find',
      'browser_find did not return an element ref',
      findData,
    );
    record('browser_find', findData);

    summary.stage = 'browser_form_input';
    const formInput = await client.request('tools/call', {
      name: 'browser_form_input',
      arguments: {
        tabId: openData.tabId,
        ref: foundRef,
        value: 'bridge form value',
      },
    });
    const formInputPayload = summarizeToolResponse(formInput);
    const formInputData = parseMaybeJson(formInputPayload.structured ?? formInputPayload.text);
    assert(
      formInputData && formInputData.action_taken === 'form_input',
      'browser_form_input',
      'browser_form_input did not acknowledge the form update',
      formInputData,
    );
    record('browser_form_input', formInputData);

    summary.stage = 'browser_javascript_exec(form-check)';
    const formCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#target-input")?.value ?? null',
      },
    });
    const formCheckPayload = summarizeToolResponse(formCheck);
    const formCheckData = parseMaybeJson(formCheckPayload.structured ?? formCheckPayload.text);
    const formCheckValue = extractPrimaryValue(formCheckData?.result);
    assert(
      formCheckData && formCheckValue === 'bridge form value',
      'browser_javascript_exec(form-check)',
      'form input value was not visible after browser_form_input',
      formCheckData,
    );
    record('browser_javascript_exec(form-check)', formCheckData);

    summary.stage = 'browser_computer(left_click:ref)';
    const leftClickRef = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'left_click',
        ref: foundRef,
      },
    });
    const leftClickRefPayload = summarizeToolResponse(leftClickRef);
    const leftClickRefData = parseMaybeJson(
      leftClickRefPayload.structured ?? leftClickRefPayload.text,
    );
    assert(
      leftClickRefData &&
        leftClickRefData.action_taken === 'computer' &&
        leftClickRefData.computer_action === 'left_click' &&
        leftClickRefData.ref === foundRef,
      'browser_computer(left_click:ref)',
      'browser_computer(left_click) did not acknowledge the ref-targeted action',
      leftClickRefData,
    );
    record('browser_computer(left_click:ref)', leftClickRefData);

    summary.stage = 'browser_computer(key)';
    const keyAction = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'key',
        text: 'Enter',
      },
    });
    const keyActionPayload = summarizeToolResponse(keyAction);
    const keyActionData = parseMaybeJson(
      keyActionPayload.structured ?? keyActionPayload.text,
    );
    assert(
      keyActionData &&
        keyActionData.action_taken === 'computer' &&
        keyActionData.computer_action === 'key' &&
        keyActionData.text === 'Enter',
      'browser_computer(key)',
      'browser_computer(key) did not acknowledge the key action',
      keyActionData,
    );
    record('browser_computer(key)', keyActionData);

    summary.stage = 'browser_javascript_exec(key-check)';
    const keyCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#key-status")?.textContent ?? ""',
      },
    });
    const keyCheckPayload = summarizeToolResponse(keyCheck);
    const keyCheckData = parseMaybeJson(keyCheckPayload.structured ?? keyCheckPayload.text);
    const keyCheckValue = extractPrimaryValue(keyCheckData?.result);
    assert(
      keyCheckData && keyCheckValue === 'Enter',
      'browser_javascript_exec(key-check)',
      'key action did not update the key status marker',
      keyCheckData,
    );
    record('browser_javascript_exec(key-check)', keyCheckData);

    summary.stage = 'browser_computer(wait)';
    const waitStart = Date.now();
    const waitAction = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'wait',
        duration: 0.2,
      },
    });
    const waitElapsed = Date.now() - waitStart;
    const waitPayload = summarizeToolResponse(waitAction);
    const waitData = parseMaybeJson(waitPayload.structured ?? waitPayload.text);
    assert(
      waitData &&
        waitData.action_taken === 'computer' &&
        waitData.computer_action === 'wait' &&
        waitElapsed >= 150,
      'browser_computer(wait)',
      'browser_computer(wait) did not acknowledge the wait action',
      { waitElapsed, waitData },
    );
    record('browser_computer(wait)', { waitElapsed, ...waitData });

    summary.stage = 'browser_javascript_exec(hover-center)';
    const hoverCenter = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'JSON.stringify((() => { const el = document.querySelector("#hover-target"); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })())',
      },
    });
    const hoverCenterPayload = summarizeToolResponse(hoverCenter);
    const hoverCenterData = parseMaybeJson(
      hoverCenterPayload.structured ?? hoverCenterPayload.text,
    );
    const hoverCoordinate =
      typeof hoverCenterData?.result === 'object' && hoverCenterData.result !== null
        ? hoverCenterData.result
        : parseMaybeJson(hoverCenterData?.result);
    assert(
      hoverCoordinate &&
        Number.isFinite(hoverCoordinate.x) &&
        Number.isFinite(hoverCoordinate.y),
      'browser_javascript_exec(hover-center)',
      'could not determine hover target coordinates',
      hoverCenterData,
    );
    record('browser_javascript_exec(hover-center)', hoverCenterData);

    summary.stage = 'browser_computer(hover)';
    const hover = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'hover',
        x: hoverCoordinate.x,
        y: hoverCoordinate.y,
      },
    });
    const hoverPayload = summarizeToolResponse(hover);
    const hoverData = parseMaybeJson(hoverPayload.structured ?? hoverPayload.text);
    assert(
      hoverData &&
        hoverData.action_taken === 'computer' &&
        hoverData.computer_action === 'hover',
      'browser_computer(hover)',
      'browser_computer(hover) did not acknowledge the hover action',
      hoverData,
    );
    record('browser_computer(hover)', hoverData);

    summary.stage = 'browser_javascript_exec(hover-check)';
    const hoverCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#hover-status")?.textContent ?? ""',
      },
    });
    const hoverCheckPayload = summarizeToolResponse(hoverCheck);
    const hoverCheckData = parseMaybeJson(
      hoverCheckPayload.structured ?? hoverCheckPayload.text,
    );
    const hoverCheckValue = extractPrimaryValue(hoverCheckData?.result);
    assert(
      hoverCheckData && hoverCheckValue === 'hovered',
      'browser_javascript_exec(hover-check)',
      'hover action did not update the hover target state',
      hoverCheckData,
    );
    record('browser_javascript_exec(hover-check)', hoverCheckData);

    summary.stage = 'browser_javascript_exec(context-center)';
    const contextCenter = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'JSON.stringify((() => { const el = document.querySelector("#context-target"); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })())',
      },
    });
    const contextCenterPayload = summarizeToolResponse(contextCenter);
    const contextCenterData = parseMaybeJson(
      contextCenterPayload.structured ?? contextCenterPayload.text,
    );
    const contextCoordinate =
      typeof contextCenterData?.result === 'object' && contextCenterData.result !== null
        ? contextCenterData.result
        : parseMaybeJson(contextCenterData?.result);
    assert(
      contextCoordinate &&
        Number.isFinite(contextCoordinate.x) &&
        Number.isFinite(contextCoordinate.y),
      'browser_javascript_exec(context-center)',
      'could not determine context target coordinates',
      contextCenterData,
    );
    record('browser_javascript_exec(context-center)', contextCenterData);

    summary.stage = 'browser_computer(right_click)';
    noteStage(summary.stage);
    const rightClick = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'right_click',
        x: contextCoordinate.x,
        y: contextCoordinate.y,
      },
    });
    const rightClickPayload = summarizeToolResponse(rightClick);
    const rightClickData = parseMaybeJson(
      rightClickPayload.structured ?? rightClickPayload.text,
    );
    assert(
      rightClickData &&
        rightClickData.action_taken === 'computer' &&
        rightClickData.computer_action === 'right_click',
      'browser_computer(right_click)',
      'browser_computer(right_click) did not acknowledge the context action',
      rightClickData,
    );
    record('browser_computer(right_click)', rightClickData);

    summary.stage = 'browser_javascript_exec(context-check)';
    const contextCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#context-status")?.textContent ?? ""',
      },
    });
    const contextCheckPayload = summarizeToolResponse(contextCheck);
    const contextCheckData = parseMaybeJson(
      contextCheckPayload.structured ?? contextCheckPayload.text,
    );
    const contextCheckValue = extractPrimaryValue(contextCheckData?.result);
    assert(
      contextCheckData && contextCheckValue === 'context-opened',
      'browser_javascript_exec(context-check)',
      'right_click action did not update the context target state',
      contextCheckData,
    );
    record('browser_javascript_exec(context-check)', contextCheckData);

    summary.stage = 'browser_javascript_exec(double-click-center)';
    const doubleClickCenter = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'JSON.stringify((() => { const el = document.querySelector("#double-click-target"); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })())',
      },
    });
    const doubleClickCenterPayload = summarizeToolResponse(doubleClickCenter);
    const doubleClickCenterData = parseMaybeJson(
      doubleClickCenterPayload.structured ?? doubleClickCenterPayload.text,
    );
    const doubleClickCoordinate =
      typeof doubleClickCenterData?.result === 'object' &&
      doubleClickCenterData.result !== null
        ? doubleClickCenterData.result
        : parseMaybeJson(doubleClickCenterData?.result);
    assert(
      doubleClickCoordinate &&
        Number.isFinite(doubleClickCoordinate.x) &&
        Number.isFinite(doubleClickCoordinate.y),
      'browser_javascript_exec(double-click-center)',
      'could not determine double-click target coordinates',
      doubleClickCenterData,
    );
    record('browser_javascript_exec(double-click-center)', doubleClickCenterData);

    summary.stage = 'browser_computer(double_click)';
    noteStage(summary.stage);
    const doubleClick = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'double_click',
        x: doubleClickCoordinate.x,
        y: doubleClickCoordinate.y,
      },
    });
    const doubleClickPayload = summarizeToolResponse(doubleClick);
    const doubleClickData = parseMaybeJson(
      doubleClickPayload.structured ?? doubleClickPayload.text,
    );
    assert(
      doubleClickData &&
        doubleClickData.action_taken === 'computer' &&
        doubleClickData.computer_action === 'double_click',
      'browser_computer(double_click)',
      'browser_computer(double_click) did not acknowledge the action',
      doubleClickData,
    );
    record('browser_computer(double_click)', doubleClickData);

    summary.stage = 'browser_javascript_exec(double-click-check)';
    const doubleClickCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#double-click-status")?.textContent ?? ""',
      },
    });
    const doubleClickCheckPayload = summarizeToolResponse(doubleClickCheck);
    const doubleClickCheckData = parseMaybeJson(
      doubleClickCheckPayload.structured ?? doubleClickCheckPayload.text,
    );
    const doubleClickCheckValue = extractPrimaryValue(doubleClickCheckData?.result);
    assert(
      doubleClickCheckData && doubleClickCheckValue === 'double-clicked',
      'browser_javascript_exec(double-click-check)',
      'double_click action did not update the double-click target state',
      doubleClickCheckData,
    );
    record('browser_javascript_exec(double-click-check)', doubleClickCheckData);

    summary.stage = 'browser_javascript_exec(triple-click-center)';
    const tripleClickCenter = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'JSON.stringify((() => { const el = document.querySelector("#triple-click-target"); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })())',
      },
    });
    const tripleClickCenterPayload = summarizeToolResponse(tripleClickCenter);
    const tripleClickCenterData = parseMaybeJson(
      tripleClickCenterPayload.structured ?? tripleClickCenterPayload.text,
    );
    const tripleClickCoordinate =
      typeof tripleClickCenterData?.result === 'object' &&
      tripleClickCenterData.result !== null
        ? tripleClickCenterData.result
        : parseMaybeJson(tripleClickCenterData?.result);
    assert(
      tripleClickCoordinate &&
        Number.isFinite(tripleClickCoordinate.x) &&
        Number.isFinite(tripleClickCoordinate.y),
      'browser_javascript_exec(triple-click-center)',
      'could not determine triple-click target coordinates',
      tripleClickCenterData,
    );
    record('browser_javascript_exec(triple-click-center)', tripleClickCenterData);

    summary.stage = 'browser_computer(triple_click)';
    const tripleClick = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'triple_click',
        x: tripleClickCoordinate.x,
        y: tripleClickCoordinate.y,
      },
    });
    const tripleClickPayload = summarizeToolResponse(tripleClick);
    const tripleClickData = parseMaybeJson(
      tripleClickPayload.structured ?? tripleClickPayload.text,
    );
    assert(
      tripleClickData &&
        tripleClickData.action_taken === 'computer' &&
        tripleClickData.computer_action === 'triple_click',
      'browser_computer(triple_click)',
      'browser_computer(triple_click) did not acknowledge the action',
      tripleClickData,
    );
    record('browser_computer(triple_click)', tripleClickData);

    summary.stage = 'browser_javascript_exec(triple-click-check)';
    const tripleClickCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#triple-click-status")?.textContent ?? ""',
      },
    });
    const tripleClickCheckPayload = summarizeToolResponse(tripleClickCheck);
    const tripleClickCheckData = parseMaybeJson(
      tripleClickCheckPayload.structured ?? tripleClickCheckPayload.text,
    );
    const tripleClickCheckValue = Number(
      extractPrimaryValue(tripleClickCheckData?.result),
    );
    assert(
      tripleClickCheckData &&
        Number.isFinite(tripleClickCheckValue) &&
        tripleClickCheckValue >= 3,
      'browser_javascript_exec(triple-click-check)',
      'triple_click action did not produce the expected click detail',
      tripleClickCheckData,
    );
    record('browser_javascript_exec(triple-click-check)', tripleClickCheckData);

    summary.stage = 'browser_javascript_exec(scroll-reset)';
    const scrollReset = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'window.scrollTo({ top: 0, left: 0, behavior: "instant" }); JSON.stringify({ scrollY: window.scrollY })',
      },
    });
    const scrollResetPayload = summarizeToolResponse(scrollReset);
    const scrollResetData = parseMaybeJson(
      scrollResetPayload.structured ?? scrollResetPayload.text,
    );
    record('browser_javascript_exec(scroll-reset)', scrollResetData);

    let scrollTargetRef = null;
    summary.stage = 'browser_find(scroll-target)';
    noteStage(summary.stage);
    const scrollTargetFind = await client.request('tools/call', {
      name: 'browser_find',
      arguments: {
        tabId: openData.tabId,
        query: 'Scroll target button',
      },
    });
    const scrollTargetFindPayload = summarizeToolResponse(scrollTargetFind);
    const scrollTargetFindData = parseMaybeJson(
      scrollTargetFindPayload.structured ?? scrollTargetFindPayload.text,
    );
    scrollTargetRef = extractFirstRef(scrollTargetFindData?.result);
    if (scrollTargetRef) {
      record('browser_find(scroll-target)', {
        ref: scrollTargetRef,
        result: scrollTargetFindData,
      });
    } else {
      summary.stage = 'browser_read_page(scroll-target-ref)';
      const scrollTargetReadPage = await client.request('tools/call', {
        name: 'browser_read_page',
        arguments: {
          tabId: openData.tabId,
          maxChars: 20000,
        },
      });
      const scrollTargetReadPagePayload = summarizeToolResponse(scrollTargetReadPage);
      const scrollTargetReadPageData = parseMaybeJson(
        scrollTargetReadPagePayload.structured ?? scrollTargetReadPagePayload.text,
      );
      scrollTargetRef = extractRefByLabel(
        scrollTargetReadPageData?.result,
        'Scroll target button',
      );
      assert(
        typeof scrollTargetRef === 'string',
        'browser_read_page(scroll-target-ref)',
        'could not locate the scroll target ref in find or read_page output',
        scrollTargetReadPageData,
      );
      record('browser_read_page(scroll-target-ref)', {
        ref: scrollTargetRef,
        result: scrollTargetReadPageData,
      });
    }

    summary.stage = 'browser_computer(scroll_to)';
    noteStage(summary.stage);
    const scrollTo = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'scroll_to',
        ref: scrollTargetRef,
      },
    });
    const scrollToPayload = summarizeToolResponse(scrollTo);
    const scrollToData = parseMaybeJson(scrollToPayload.structured ?? scrollToPayload.text);
    assert(
      scrollToData &&
        scrollToData.action_taken === 'computer' &&
        scrollToData.computer_action === 'scroll_to' &&
        scrollToData.ref === scrollTargetRef,
      'browser_computer(scroll_to)',
      'browser_computer(scroll_to) did not acknowledge the target ref',
      scrollToData,
    );
    record('browser_computer(scroll_to)', scrollToData);

    summary.stage = 'browser_javascript_exec(scroll-to-check)';
    const scrollToCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'JSON.stringify((() => { const el = document.querySelector("#scroll-target-button"); if (!el) return null; const rect = el.getBoundingClientRect(); return { inView: rect.top < window.innerHeight && rect.bottom > 0, top: Math.round(rect.top), bottom: Math.round(rect.bottom), scrollY: Math.round(window.scrollY) }; })())',
      },
    });
    const scrollToCheckPayload = summarizeToolResponse(scrollToCheck);
    const scrollToCheckData = parseMaybeJson(
      scrollToCheckPayload.structured ?? scrollToCheckPayload.text,
    );
    const scrollToCheckResult =
      typeof scrollToCheckData?.result === 'object' && scrollToCheckData.result !== null
        ? scrollToCheckData.result
        : parseMaybeJson(scrollToCheckData?.result);
    assert(
      scrollToCheckData &&
        scrollToCheckResult &&
        scrollToCheckResult.inView === true &&
        Number.isFinite(Number(scrollToCheckResult.scrollY)) &&
        Number(scrollToCheckResult.scrollY) > 0,
      'browser_javascript_exec(scroll-to-check)',
      'scroll_to did not bring the scroll target into view',
      scrollToCheckData,
    );
    record('browser_javascript_exec(scroll-to-check)', scrollToCheckData);

    summary.stage = 'browser_javascript_exec(scroll-reset-after-scroll-to)';
    const scrollResetAfterScrollTo = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'window.scrollTo({ top: 0, left: 0, behavior: "instant" }); JSON.stringify({ scrollY: window.scrollY })',
      },
    });
    const scrollResetAfterScrollToPayload = summarizeToolResponse(
      scrollResetAfterScrollTo,
    );
    const scrollResetAfterScrollToData = parseMaybeJson(
      scrollResetAfterScrollToPayload.structured ??
        scrollResetAfterScrollToPayload.text,
    );
    record(
      'browser_javascript_exec(scroll-reset-after-scroll-to)',
      scrollResetAfterScrollToData,
    );

    summary.stage = 'browser_javascript_exec(drag-coordinates)';
    const dragCoordinatesResponse = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script:
          'JSON.stringify((() => { const source = document.querySelector("#drag-source"); const target = document.querySelector("#drag-target"); if (!source || !target) return null; const sourceRect = source.getBoundingClientRect(); const targetRect = target.getBoundingClientRect(); return { startX: Math.round(sourceRect.left + sourceRect.width / 2), startY: Math.round(sourceRect.top + sourceRect.height / 2), endX: Math.round(targetRect.left + targetRect.width / 2), endY: Math.round(targetRect.top + targetRect.height / 2) }; })())',
      },
    });
    const dragCoordinatesPayload = summarizeToolResponse(dragCoordinatesResponse);
    const dragCoordinatesData = parseMaybeJson(
      dragCoordinatesPayload.structured ?? dragCoordinatesPayload.text,
    );
    const dragCoordinates =
      typeof dragCoordinatesData?.result === 'object' &&
      dragCoordinatesData.result !== null
        ? dragCoordinatesData.result
        : parseMaybeJson(dragCoordinatesData?.result);
    assert(
      dragCoordinates &&
        Number.isFinite(dragCoordinates.startX) &&
        Number.isFinite(dragCoordinates.startY) &&
        Number.isFinite(dragCoordinates.endX) &&
        Number.isFinite(dragCoordinates.endY),
      'browser_javascript_exec(drag-coordinates)',
      'could not determine drag source/target coordinates',
      dragCoordinatesData,
    );
    record('browser_javascript_exec(drag-coordinates)', dragCoordinatesData);

    summary.stage = 'browser_computer(left_click_drag)';
    noteStage(summary.stage);
    const dragAction = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'left_click_drag',
        startX: dragCoordinates.startX,
        startY: dragCoordinates.startY,
        x: dragCoordinates.endX,
        y: dragCoordinates.endY,
      },
    });
    const dragActionPayload = summarizeToolResponse(dragAction);
    const dragActionData = parseMaybeJson(
      dragActionPayload.structured ?? dragActionPayload.text,
    );
    assert(
      dragActionData &&
        dragActionData.action_taken === 'computer' &&
        dragActionData.computer_action === 'left_click_drag',
      'browser_computer(left_click_drag)',
      'browser_computer(left_click_drag) did not acknowledge the action',
      dragActionData,
    );
    record('browser_computer(left_click_drag)', dragActionData);

    summary.stage = 'browser_javascript_exec(drag-check)';
    const dragCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'document.querySelector("#drag-status")?.textContent ?? ""',
      },
    });
    const dragCheckPayload = summarizeToolResponse(dragCheck);
    const dragCheckData = parseMaybeJson(dragCheckPayload.structured ?? dragCheckPayload.text);
    const dragCheckValue = extractPrimaryValue(dragCheckData?.result);
    assert(
      dragCheckData && dragCheckValue === 'drag-complete',
      'browser_javascript_exec(drag-check)',
      'left_click_drag did not produce the expected drag status',
      dragCheckData,
    );
    record('browser_javascript_exec(drag-check)', dragCheckData);

    summary.stage = 'browser_computer(zoom)';
    noteStage(summary.stage);
    const zoomAction = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'zoom',
        region: [0, 0, 420, 320],
      },
    });
    const zoomActionPayload = summarizeToolResponse(zoomAction);
    const zoomActionData = parseMaybeJson(
      zoomActionPayload.structured ?? zoomActionPayload.text,
    );
    assert(
      zoomActionData &&
        zoomActionData.action_taken === 'computer' &&
        zoomActionData.computer_action === 'zoom' &&
        Array.isArray(zoomActionData.raw_summary) &&
        zoomActionData.raw_summary.some(
          (item) => typeof item === 'string' && item.startsWith('[image:'),
        ),
      'browser_computer(zoom)',
      'browser_computer(zoom) did not return a zoomed image payload',
      zoomActionData,
    );
    record('browser_computer(zoom)', zoomActionData);

    summary.stage = 'browser_computer(scroll)';
    const scroll = await client.request('tools/call', {
      name: 'browser_computer',
      arguments: {
        tabId: openData.tabId,
        action: 'scroll',
        x: 120,
        y: 80,
        scrollDirection: 'down',
        scrollAmount: 3,
      },
    });
    const scrollPayload = summarizeToolResponse(scroll);
    const scrollData = parseMaybeJson(scrollPayload.structured ?? scrollPayload.text);
    assert(
      scrollData &&
        scrollData.action_taken === 'computer' &&
        scrollData.computer_action === 'scroll',
      'browser_computer(scroll)',
      'browser_computer(scroll) did not acknowledge the scroll action',
      scrollData,
    );
    record('browser_computer(scroll)', scrollData);

    summary.stage = 'browser_javascript_exec(scroll-check)';
    const scrollCheck = await client.request('tools/call', {
      name: 'browser_javascript_exec',
      arguments: {
        tabId: openData.tabId,
        script: 'window.scrollY',
      },
    });
    const scrollCheckPayload = summarizeToolResponse(scrollCheck);
    const scrollCheckData = parseMaybeJson(
      scrollCheckPayload.structured ?? scrollCheckPayload.text,
    );
    const scrollCheckValue = Number(extractPrimaryValue(scrollCheckData?.result));
    assert(
      scrollCheckData && Number.isFinite(scrollCheckValue) && scrollCheckValue > 0,
      'browser_javascript_exec(scroll-check)',
      'scroll action did not visibly change the page scroll position',
      scrollCheckData,
    );
    record('browser_javascript_exec(scroll-check)', scrollCheckData);

    summary.stage = 'browser_click';
    const click = await client.request('tools/call', {
      name: 'browser_click',
      arguments: {
        tabId: openData.tabId,
        x: 120,
        y: 80,
      },
    });
    const clickPayload = summarizeToolResponse(click);
    const clickData = parseMaybeJson(clickPayload.structured ?? clickPayload.text);
    assert(
      clickData && Number.isFinite(clickData.tabId),
      'browser_click',
      'browser_click did not return a tab id',
      clickData,
    );
    record('browser_click', clickData);

    summary.stage = 'browser_type';
    const type = await client.request('tools/call', {
      name: 'browser_type',
      arguments: {
        tabId: openData.tabId,
        text: 'validate-bridge plain type',
      },
    });
    const typePayload = summarizeToolResponse(type);
    const typeData = parseMaybeJson(typePayload.structured ?? typePayload.text);
    assert(
      typeData && typeData.text === 'validate-bridge plain type',
      'browser_type',
      'browser_type did not echo the typed text',
      typeData,
    );
    record('browser_type', typeData);

    summary.stage = 'browser_type(click-first)';
    const clickFirst = await client.request('tools/call', {
      name: 'browser_type',
      arguments: {
        tabId: openData.tabId,
        text: 'validate-bridge click-first',
        x: 120,
        y: 80,
      },
    });
    const clickFirstPayload = summarizeToolResponse(clickFirst);
    const clickFirstData = parseMaybeJson(clickFirstPayload.structured ?? clickFirstPayload.text);
    assert(
      clickFirstData &&
        Array.isArray(clickFirstData.pre_steps) &&
        clickFirstData.pre_steps.length >= 1,
      'browser_type(click-first)',
      'browser_type(click-first) did not report a pre-step',
      clickFirstData,
    );
    record('browser_type(click-first)', clickFirstData);

    summary.stage = 'browser_close_tab';
    noteStage(summary.stage);
    const close = await client.request('tools/call', {
      name: 'browser_close_tab',
      arguments: {
        tabId: openData.tabId,
      },
    });
    const closePayload = summarizeToolResponse(close);
    const closeData = parseMaybeJson(closePayload.structured ?? closePayload.text);
    assert(
      closeData &&
        closeData.action_taken === 'close' &&
        Number(closeData.tabId) === Number(openData.tabId),
      'browser_close_tab',
      'browser_close_tab did not acknowledge the expected tab',
      closeData,
    );
    const closeTabs = Array.isArray(closeData?.browser_context?.availableTabs)
      ? closeData.browser_context.availableTabs
      : [];
    assert(
      closeTabs.every((tab) => Number(tab?.tabId) !== Number(openData.tabId)),
      'browser_close_tab',
      'browser_close_tab did not remove the target tab from browser context',
      closeData,
    );
    record('browser_close_tab', closeData);

    while (cleanupTabIds.length > 0) {
      const tabId = cleanupTabIds.pop();
      if (!Number.isFinite(tabId) || Number(tabId) === Number(openData.tabId)) {
        continue;
      }
      summary.stage = `browser_close_tab(cleanup:${tabId})`;
      const cleanupClose = await client.request('tools/call', {
        name: 'browser_close_tab',
        arguments: {
          tabId,
        },
      });
      const cleanupClosePayload = summarizeToolResponse(cleanupClose);
      const cleanupCloseData = parseMaybeJson(
        cleanupClosePayload.structured ?? cleanupClosePayload.text,
      );
      assert(
        cleanupCloseData && !cleanupClosePayload.isError,
        `browser_close_tab(cleanup:${tabId})`,
        'browser_close_tab did not close a cleanup tab',
        cleanupCloseData,
      );
      record(`browser_close_tab(cleanup:${tabId})`, cleanupCloseData);
    }
    }

    if (enableCodexExec && !enableHostChurn) {
      summary.stage = 'codex_exec(browser_health)';
      const execHealth = await runCodexExecHealth();
      record('codex_exec(browser_health)', execHealth);
    }

    if (enableHostChurn) {
      summary.stage = 'host_churn(baseline)';
      churnBaseline = await runBridgeProbe();
      const churnBaselineData = churnBaseline.json;
      assert(
        churnBaselineData &&
          churnBaselineData.connect_ok === true &&
          churnBaselineData.status_ok === true &&
          Number.isFinite(churnBaselineData.host_process?.pid) &&
          typeof churnBaselineData.socket_path === 'string',
        'host_churn(baseline)',
        'host churn baseline is not healthy enough to continue',
        churnBaseline,
      );
      record('host_churn(baseline)', {
        pid: churnBaselineData.host_process.pid,
        socketPath: churnBaselineData.socket_path,
      });

      summary.stage = 'host_churn(kill)';
      process.kill(churnBaselineData.host_process.pid, 'SIGTERM');
      const hostDown = await waitForProbe(
        (data) =>
          data &&
          data.connect_ok === false &&
          data.failure_stage === 'discover',
        {
          timeoutMs: 15000,
          label: 'host churn host-down state',
        },
      );
      record('host_churn(kill)', {
        oldPid: churnBaselineData.host_process.pid,
        oldSocketPath: churnBaselineData.socket_path,
        probe: hostDown.json,
      });

      summary.stage = 'host_churn(reconnect)';
      const reconnectTrigger = await runCommand(
        'open',
        ['-a', 'Google Chrome', 'https://clau.de/chrome/reconnect'],
        { timeoutMs: 5000 },
      );
      assert(
        reconnectTrigger.timedOut === false && reconnectTrigger.code === 0,
        'host_churn(reconnect)',
        'failed to trigger Chrome reconnect URL',
        reconnectTrigger,
      );

      const recovered = await waitForProbe(
        (data) =>
          data &&
          data.connect_ok === true &&
          data.status_ok === true &&
          Number.isFinite(data.host_process?.pid) &&
          data.host_process.pid !== churnBaselineData.host_process.pid &&
          typeof data.socket_path === 'string' &&
          data.socket_path !== churnBaselineData.socket_path,
        {
          timeoutMs: 20000,
          label: 'host churn recovery',
        },
      );
      record('host_churn(reconnect)', {
        oldPid: churnBaselineData.host_process.pid,
        newPid: recovered.json.host_process.pid,
        oldSocketPath: churnBaselineData.socket_path,
        newSocketPath: recovered.json.socket_path,
        oldSocketStillExists: fs.existsSync(churnBaselineData.socket_path),
      });

      summary.stage = 'codex_exec(browser_health)';
      const execHealth = await runCodexExecHealth();
      assert(
        execHealth.pid === recovered.json.host_process.pid &&
          execHealth.socketPath === recovered.json.socket_path,
        'codex_exec(browser_health)',
        'codex exec health smoke did not report the recovered host/socket',
        {
          recovered: recovered.json,
          execHealth,
        },
      );
      record('codex_exec(browser_health)', execHealth);
    }

    summary.ok = true;
    summary.stage = 'done';
    return summary;
  } catch (error) {
    return fail(summary.stage, error);
  } finally {
    try {
      await validationServer.close();
    } catch {
      // Preserve the original validation failure.
    }
    if (enableHostChurn) {
      try {
        const finalProbe = await runBridgeProbe();
        if (finalProbe.json?.connect_ok !== true || finalProbe.json?.status_ok !== true) {
          await runCommand(
            'open',
            ['-a', 'Google Chrome', 'https://clau.de/chrome/reconnect'],
            { timeoutMs: 5000 },
          );
          await waitForProbe(
            (data) => data && data.connect_ok === true && data.status_ok === true,
            {
              timeoutMs: 20000,
              label: 'final recovery',
            },
          );
        }
      } catch {
        // Leave the original validation error intact; this is best-effort cleanup only.
      }
    }
    client.failAll(new Error('validator finished'));
    child.kill('SIGTERM');
  }
}

const result = await run();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!result.ok) {
  process.stderr.write(
    `validate-bridge failed at ${result.stage}: ${result.error?.message ?? 'unknown error'}\n`,
  );
  process.exitCode = 1;
}
