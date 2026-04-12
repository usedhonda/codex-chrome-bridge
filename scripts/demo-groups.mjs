#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bridgeEntry = path.join(repoRoot, 'src', 'bridge.js');

const GROUP_SPECS = [
  {
    label: 'A',
    urls: [
      'https://www.amazon.co.jp/s?k=%E5%B0%8F%E5%9E%8B+USB+%E9%9B%BB%E5%8B%95%E3%81%B2%E3%81%92%E5%89%83%E3%82%8A',
      'https://search.rakuten.co.jp/search/mall/USB+%E3%81%B2%E3%81%92%E5%89%83%E3%82%8A+%E5%B0%8F%E5%9E%8B/',
    ],
  },
  {
    label: 'B',
    urls: [
      'https://www.wikipedia.org/',
      'https://news.ycombinator.com/',
    ],
  },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

function extractText(result) {
  return (result?.content ?? [])
    .map((item) => (item?.type === 'text' ? item.text : null))
    .filter(Boolean)
    .join('\n');
}

class JsonRpcClient {
  constructor(child) {
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;

    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', () => {
      this.closed = true;
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`bridge session exited (${id})`));
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = this.stdoutBuffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error('missing Content-Length header');
      }

      const bodyLength = Number.parseInt(match[1], 10);
      const frameLength = headerEnd + 4 + bodyLength;
      if (this.stdoutBuffer.length < frameLength) {
        return;
      }

      const body = this.stdoutBuffer
        .subarray(headerEnd + 4, frameLength)
        .toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(frameLength);

      const message = JSON.parse(body);
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

  request(method, params = {}, timeoutMs = 30000) {
    if (this.closed) {
      return Promise.reject(new Error('session already closed'));
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

    this.child.stdin.write(encodeFrame({ jsonrpc: '2.0', method, params }));
  }
}

async function startGroup(spec) {
  const child = spawn(process.execPath, [bridgeEntry, 'mcp'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new JsonRpcClient(child);

  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: `demo-group-${spec.label}`, version: '0.1.0' },
  });
  client.notify('notifications/initialized', {});

  const tabsContext = await client.request('tools/call', {
    name: 'browser_tabs_context',
    arguments: { createIfEmpty: true },
  });

  const opened = [];
  for (const url of spec.urls) {
    const response = await client.request('tools/call', {
      name: 'browser_open_or_focus',
      arguments: { url },
    });
    opened.push(response.result?.structuredContent ?? extractText(response.result));
  }

  await delay(2500);

  const snapshot = await client.request('tools/call', {
    name: 'browser_snapshot',
    arguments: {},
  });

  return {
    child,
    client,
    info: {
      label: spec.label,
      pid: child.pid,
      tabsContext: tabsContext.result?.structuredContent ?? extractText(tabsContext.result),
      opened,
      snapshot: snapshot.result?.structuredContent ?? extractText(snapshot.result),
    },
  };
}

const sessions = [];

try {
  for (const spec of GROUP_SPECS) {
    const session = await startGroup(spec);
    sessions.push(session);
  }

  const summary = sessions.map((session) => ({
    label: session.info.label,
    pid: session.info.pid,
    tabGroupId:
      session.info.snapshot?.browser_context?.tabGroupId ??
      session.info.tabsContext?.browser_context?.tabGroupId ??
      null,
    tabs:
      session.info.snapshot?.browser_context?.availableTabs?.map((tab) => ({
        tabId: tab.tabId,
        title: tab.title,
        url: tab.url,
      })) ?? [],
  }));

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(
    '[demo-groups] 2 sessions alive. Keep this process running while you capture Chrome.\n',
  );

  const shutdown = () => {
    for (const session of sessions) {
      session.child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 200).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
} catch (error) {
  for (const session of sessions) {
    session.child.kill('SIGTERM');
  }
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
}
