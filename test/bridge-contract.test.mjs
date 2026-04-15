import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { __test__ } from '../src/bridge.js';

test('parseLauncherTarget extracts quoted launcher path', () => {
  const script = 'exec "/Users/test/.local/share/claude/versions/2.1.104" --chrome-native-host';
  assert.equal(
    __test__.parseLauncherTarget(script),
    '/Users/test/.local/share/claude/versions/2.1.104',
  );
});

test('parseVersionFromBinary extracts version suffix', () => {
  assert.equal(
    __test__.parseVersionFromBinary('/Users/test/.local/share/claude/versions/2.1.104'),
    '2.1.104',
  );
  assert.equal(__test__.parseVersionFromBinary('/tmp/not-a-version'), null);
});

test('findStructuredJson finds first JSON payload in content', () => {
  const content = [
    { type: 'text', text: 'not json' },
    { type: 'text', text: '{"tabGroupId": 42, "ok": true}' },
    { type: 'text', text: '{"ignored": true}' },
  ];
  assert.deepEqual(__test__.findStructuredJson(content), {
    tabGroupId: 42,
    ok: true,
  });
});

test('normalizeToolContent prefers structured JSON and otherwise text', () => {
  assert.deepEqual(
    __test__.normalizeToolContent([{ type: 'text', text: '{"ok":true}' }]),
    { ok: true },
  );
  assert.equal(
    __test__.normalizeToolContent([{ type: 'text', text: 'single text' }]),
    'single text',
  );
  assert.deepEqual(
    __test__.normalizeToolContent([
      { type: 'text', text: 'alpha' },
      { type: 'text', text: 'beta' },
    ]),
    ['alpha', 'beta'],
  );
});

test('extractImageIdFromContent and extractScreenshotMetadata parse screenshot summaries', () => {
  const content = [
    {
      type: 'text',
      text: 'Successfully captured screenshot (1280x720, image/png) - ID: ss_abc123',
    },
  ];
  assert.equal(__test__.extractImageIdFromContent(content), 'ss_abc123');
  assert.deepEqual(__test__.extractScreenshotMetadata(content), {
    width: 1280,
    height: 720,
    format: 'image/png',
    imageId: 'ss_abc123',
  });
});

test('missing tab-group detection catches both observed downstream messages', () => {
  assert.equal(
    __test__.contentSignalsMissingTabGroup([
      { type: 'text', text: 'No MCP tab groups found. Use createIfEmpty: true to create one.' },
    ]),
    true,
  );
  assert.equal(
    __test__.contentSignalsMissingTabGroup([
      { type: 'text', text: 'No tab group exists for this session. Use createIfEmpty: true to create one.' },
    ]),
    true,
  );
  assert.equal(
    __test__.contentSignalsMissingTabGroup([{ type: 'text', text: 'ordinary success' }]),
    false,
  );
});

test('tab selection is exact by tabId or exact URL', () => {
  const browserContext = {
    availableTabs: [
      { tabId: 1, url: 'https://example.org/' },
      { tabId: 2, url: 'https://example.net/' },
      { tabId: 3, url: 'https://example.org/' },
    ],
  };

  assert.deepEqual(__test__.selectTabsInContext(browserContext, { tabId: 2 }), [
    { tabId: 2, url: 'https://example.net/' },
  ]);
  assert.deepEqual(
    __test__.selectTabsInContext(browserContext, { url: 'https://example.org/' }),
    [
      { tabId: 1, url: 'https://example.org/' },
      { tabId: 3, url: 'https://example.org/' },
    ],
  );
});

test('bootstrap tab detection only matches a single blank new-tab anchor', () => {
  assert.deepEqual(
    __test__.findBootstrapTabInContext({
      availableTabs: [{ tabId: 7, title: 'New Tab', url: 'chrome://newtab/' }],
    }),
    { tabId: 7, title: 'New Tab', url: 'chrome://newtab/' },
  );
  assert.equal(
    __test__.findBootstrapTabInContext({
      availableTabs: [
        { tabId: 7, title: 'New Tab', url: 'chrome://newtab/' },
        { tabId: 8, title: 'Example Domain', url: 'https://example.org/' },
      ],
    }),
    null,
  );
  assert.equal(
    __test__.findBootstrapTabInContext({
      availableTabs: [{ tabId: 7, title: 'Example Domain', url: 'https://example.org/' }],
    }),
    null,
  );
});

test('coordinate and region normalizers accept supported aliases and fail closed', () => {
  assert.deepEqual(__test__.normalizeCoordinate({ x: 12, y: 34 }), [12, 34]);
  assert.deepEqual(__test__.normalizeCoordinate({ coordinate: [56, 78] }), [56, 78]);
  assert.deepEqual(__test__.normalizeOptionalCoordinate({}), null);
  assert.deepEqual(__test__.normalizeStartCoordinate({ startX: 11, startY: 22 }), [11, 22]);
  assert.deepEqual(
    __test__.normalizeStartCoordinate({ start_coordinate: [33, 44] }),
    [33, 44],
  );
  assert.deepEqual(__test__.normalizeRegion({ region: [1, 2, 3, 4] }), [1, 2, 3, 4]);
  assert.throws(
    () => __test__.normalizeCoordinate({}),
    (error) =>
      error instanceof __test__.BridgeError &&
      error.stage === 'tool_call' &&
      /coordinate or x\/y is required/.test(error.message),
  );
});

test('tool recovery support excludes tabs_context_mcp itself', () => {
  assert.equal(__test__.toolSupportsSessionContextRecovery('tabs_context_mcp'), false);
  assert.equal(__test__.toolSupportsSessionContextRecovery('browser_click'), true);
});

test('main-module detection follows symlinked npm bin paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-main-module-'));
  const realFile = path.join(tempDir, 'real-entry.js');
  const symlinkFile = path.join(tempDir, 'symlink-entry.js');
  fs.writeFileSync(realFile, '// test entry\n', 'utf8');
  fs.symlinkSync(realFile, symlinkFile);

  try {
    assert.equal(__test__.isMainModulePath(symlinkFile, new URL(`file://${realFile}`)), true);
    assert.equal(__test__.isMainModulePath(path.join(tempDir, 'missing.js'), new URL(`file://${realFile}`)), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
