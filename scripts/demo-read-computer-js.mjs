#!/usr/bin/env node

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bridgeEntry = path.join(repoRoot, 'src', 'bridge.js');
const holdOpen = process.argv.includes('--hold');

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

function structuredOrText(response) {
  return response?.result?.structuredContent ?? extractText(response?.result);
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

class JsonRpcClient {
  constructor(child) {
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;

    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', (code, signal) => {
      this.closed = true;
      const error = new Error(
        `bridge session exited${code !== null ? ` with code ${code}` : ''}${signal ? ` signal ${signal}` : ''}`,
      );
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer);
        entry.reject(error);
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

      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params = {}, timeoutMs = 30000) {
    if (this.closed) {
      return Promise.reject(new Error('bridge session already closed'));
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

async function startDemoServer() {
  const html = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <title>CiC Demo Workflow</title>
    <style>
      body { font-family: sans-serif; margin: 32px; line-height: 1.5; }
      main { max-width: 720px; }
      label, button { display: block; margin-top: 16px; }
      output { display: block; margin-top: 8px; font-weight: 600; }
    </style>
  </head>
  <body>
    <main>
      <article>Codex Chrome Bridge demo page for read_page -> computer -> javascript_exec.</article>
      <label for="target-input">Validation Name</label>
      <input id="target-input" type="text" value="" />
      <button id="hover-target" type="button">Hover target</button>
      <output id="hover-status"></output>
      <button id="submit-button" type="button">Submit validation form</button>
      <output id="submit-status"></output>
    </main>
    <script>
      const input = document.querySelector('#target-input');
      const hoverTarget = document.querySelector('#hover-target');
      const hoverStatus = document.querySelector('#hover-status');
      const button = document.querySelector('#submit-button');
      const status = document.querySelector('#submit-status');
      if (hoverTarget && hoverStatus) {
        const markHovered = () => {
          hoverStatus.textContent = 'hovered';
        };
        ['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove'].forEach(
          (eventName) => hoverTarget.addEventListener(eventName, markHovered),
        );
      }
      if (button && input && status) {
        button.addEventListener('click', () => {
          status.textContent = input.value || 'empty';
        });
      }
    </script>
  </body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
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
    throw new Error('could not determine demo server address');
  }

  return {
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

const server = await startDemoServer();
const child = spawn(process.execPath, [bridgeEntry, 'mcp'], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const client = new JsonRpcClient(child);

const shutdown = async (exitCode = 0) => {
  child.kill('SIGTERM');
  await server.close().catch(() => {});
  process.exit(exitCode);
};

process.on('SIGINT', () => {
  void shutdown(130);
});
process.on('SIGTERM', () => {
  void shutdown(143);
});

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'demo-read-computer-js', version: '0.1.0' },
  });
  client.notify('notifications/initialized', {});

  const context = await client.request('tools/call', {
    name: 'browser_tabs_context',
    arguments: { createIfEmpty: true },
  });
  const contextData = structuredOrText(context);
  const bootstrapTabId = contextData?.browser_context?.availableTabs?.find(
    (tab) => tab?.url === 'chrome://newtab/',
  )?.tabId;

  const targetUrl = `${server.origin}/?demo=workflow`;
  let tabId = Number(bootstrapTabId);
  if (Number.isFinite(tabId)) {
    await client.request('tools/call', {
      name: 'browser_navigate_tab',
      arguments: { tabId, url: targetUrl },
    });
  } else {
    const open = await client.request('tools/call', {
      name: 'browser_open_or_focus',
      arguments: { url: targetUrl },
    });
    tabId = Number(structuredOrText(open)?.tabId);
  }

  await delay(1500);

  const readPage = await client.request('tools/call', {
    name: 'browser_read_page',
    arguments: { tabId, maxChars: 12000 },
  });
  const readPageData = structuredOrText(readPage);
  const inputFind = await client.request('tools/call', {
    name: 'browser_find',
    arguments: {
      tabId,
      query: 'Validation Name input field',
    },
  });
  const inputFindData = structuredOrText(inputFind);
  const inputRef =
    extractFirstRef(inputFindData?.result) ??
    extractRefByLabel(readPageData?.result, 'Validation Name') ??
    extractFirstRef(readPageData?.result);

  const hoverFind = await client.request('tools/call', {
    name: 'browser_find',
    arguments: {
      tabId,
      query: 'Hover target button',
    },
  });
  const hoverFindData = structuredOrText(hoverFind);

  const find = await client.request('tools/call', {
    name: 'browser_find',
    arguments: {
      tabId,
      query: 'Submit validation form button',
    },
  });
  const findData = structuredOrText(find);
  const submitRef = extractFirstRef(findData?.result);

  await client.request('tools/call', {
    name: 'browser_form_input',
    arguments: {
      tabId,
      ref: inputRef,
      value: 'CiC workflow demo',
    },
  });

  const inputCheck = await client.request('tools/call', {
    name: 'browser_javascript_exec',
    arguments: {
      tabId,
      script: 'document.querySelector("#target-input")?.value ?? null',
    },
  });
  const inputCheckData = structuredOrText(inputCheck);

  const hoverTarget = await client.request('tools/call', {
    name: 'browser_javascript_exec',
    arguments: {
      tabId,
      script:
        'JSON.stringify((() => { const el = document.querySelector("#hover-target"); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })())',
    },
  });
  const hoverTargetData = structuredOrText(hoverTarget);
  const hoverTargetResult =
    typeof hoverTargetData?.result === 'object' && hoverTargetData.result !== null
      ? hoverTargetData.result
      : parseMaybeJson(hoverTargetData?.result);

  await client.request('tools/call', {
    name: 'browser_computer',
    arguments: {
      tabId,
      action: 'hover',
      x: hoverTargetResult?.x,
      y: hoverTargetResult?.y,
    },
  });

  await delay(500);

  const javascriptExec = await client.request('tools/call', {
    name: 'browser_javascript_exec',
    arguments: {
      tabId,
      script:
        'JSON.stringify({ title: document.title, inputValue: document.querySelector("#target-input")?.value ?? null, hoverStatus: document.querySelector("#hover-status")?.textContent ?? null, submitStatus: document.querySelector("#submit-status")?.textContent ?? null })',
    },
  });
  const javascriptData = structuredOrText(javascriptExec);

  const summary = {
    targetUrl,
    tabId,
    inputRef,
    submitRef,
    readPage: {
      action: readPageData?.action_taken ?? null,
      raw: readPageData?.result ?? null,
    },
    inputFind: {
      action: inputFindData?.action_taken ?? null,
      raw: inputFindData?.result ?? null,
    },
    hoverFind: {
      action: hoverFindData?.action_taken ?? null,
      raw: hoverFindData?.result ?? null,
    },
    find: {
      action: findData?.action_taken ?? null,
      raw: findData?.result ?? null,
    },
    inputCheck: inputCheckData,
    hoverTarget: hoverTargetData,
    javascript: javascriptData,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (holdOpen) {
    process.stderr.write(
      '[demo-read-computer-js] workflow completed; session left alive for capture\n',
    );
    await new Promise(() => {});
  }

  await shutdown(0);
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  await shutdown(1);
}
