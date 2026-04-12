#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bridgeEntry = path.join(repoRoot, 'src', 'bridge.js');
const userCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const isolatedHomePrefix = path.join(os.tmpdir(), 'codex-chrome-bridge-codex-home-');
const serverName = 'codex_chrome_bridge';
const codexBin = process.env.CODEX_BIN || 'codex';
const toolApprovalMode = 'approve';
const managedTools = [
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
const startupTimeoutSec = Number.parseInt(
  process.env.CODEX_BRIDGE_STARTUP_TIMEOUT_SEC || '20',
  10,
);
const preserveCodexHomeEntries = [
  'auth.json',
  'installation_id',
  'version.json',
  'AGENTS.local.md',
  'hooks.json',
  'skills',
  'rules',
  'prompts',
];
const bridgeEnvKeys = [
  'CLAUDE_BRIDGE_DISCOVERY_TIMEOUT_MS',
  'CLAUDE_BRIDGE_LAUNCHER_PATH',
  'CLAUDE_BRIDGE_MANIFEST_PATH',
  'CLAUDE_BRIDGE_MCP_TRACE_PATH',
  'CLAUDE_BRIDGE_SOCKET_ROOT',
  'CLAUDE_BRIDGE_TOOL_TIMEOUT_MS',
];

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(',')}]`;
}

function tomlInlineTable(entries) {
  return `{${entries
    .map(([key, value]) => `${key}=${tomlString(value)}`)
    .join(',')}}`;
}

const serverEnvEntries = bridgeEnvKeys
  .map((key) => [key, process.env[key]])
  .filter(([, value]) => typeof value === 'string' && value.length > 0);

const passthroughArgs = process.argv.slice(2);
const isExecCommand = passthroughArgs.includes('exec');

const injectedArgs = [
  '-c',
  `mcp_servers.${serverName}.command=${tomlString(process.execPath)}`,
  '-c',
  `mcp_servers.${serverName}.args=${tomlArray([bridgeEntry, 'mcp'])}`,
  '-c',
  `mcp_servers.${serverName}.cwd=${tomlString(repoRoot)}`,
  '-c',
  `mcp_servers.${serverName}.startup_timeout_sec=${Number.isFinite(startupTimeoutSec) ? startupTimeoutSec : 20}`,
];

if (isExecCommand) {
  for (const toolName of managedTools) {
    injectedArgs.push(
      '-c',
      `mcp_servers.${serverName}.tools.${toolName}.approval_mode=${tomlString(
        toolApprovalMode,
      )}`,
    );
  }
}

if (serverEnvEntries.length > 0) {
  injectedArgs.push(
    '-c',
    `mcp_servers.${serverName}.env=${tomlInlineTable(serverEnvEntries)}`,
  );
}

const hasCdArg = passthroughArgs.some((arg, index) => {
  if (arg === '-C' || arg === '--cd') {
    return true;
  }

  if (arg.startsWith('-C') && arg.length > 2) {
    return true;
  }

  return arg.startsWith('--cd=');
});

const finalArgs = hasCdArg ? [...injectedArgs, ...passthroughArgs] : ['-C', repoRoot, ...injectedArgs, ...passthroughArgs];

async function createIsolatedCodexHome() {
  const isolatedHome = await fs.mkdtemp(isolatedHomePrefix);
  await fs.chmod(isolatedHome, 0o700);

  for (const entry of preserveCodexHomeEntries) {
    const sourcePath = path.join(userCodexHome, entry);
    const targetPath = path.join(isolatedHome, entry);
    try {
      await fs.lstat(sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }

    await fs.symlink(sourcePath, targetPath);
  }

  await fs.writeFile(
    path.join(isolatedHome, 'config.toml'),
    [
      'personality = "none"',
      '',
      '# Repo-local isolated Codex home used by codex-chrome-bridge.',
      '# This intentionally avoids unrelated parse failures in the user-level ~/.codex/config.toml.',
      '',
    ].join('\n'),
    'utf8',
  );

  return isolatedHome;
}

let isolatedCodexHome = null;

function installCleanup(cleanup) {
  let cleaned = false;
  const run = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await cleanup();
  };

  process.on('exit', () => {
    if (isolatedCodexHome) {
      void cleanup();
    }
  });
  process.on('SIGINT', () => {
    void run().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void run().finally(() => process.exit(143));
  });
}

isolatedCodexHome = await createIsolatedCodexHome();
installCleanup(async () => {
  if (isolatedCodexHome) {
    await fs.rm(isolatedCodexHome, { recursive: true, force: true });
  }
});

const child = spawn(codexBin, finalArgs, {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEX_HOME: isolatedCodexHome,
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (isolatedCodexHome) {
    void fs.rm(isolatedCodexHome, { recursive: true, force: true });
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
