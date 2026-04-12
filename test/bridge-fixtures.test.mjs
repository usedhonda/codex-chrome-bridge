import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { __test__ } from '../src/bridge.js';

const fixturesRoot = path.join(process.cwd(), 'test', 'fixtures');

async function loadFixture(name) {
  return JSON.parse(
    await fs.readFile(path.join(fixturesRoot, name), 'utf8'),
  );
}

test('fixture: tabs-context content preserves structured JSON and primary text', async () => {
  const content = await loadFixture('tabs-context.content.json');
  assert.deepEqual(__test__.findStructuredJson(content), {
    availableTabs: [
      {
        tabId: 1256944467,
        title: 'New Tab',
        url: 'chrome://newtab/',
      },
    ],
    tabGroupId: 2049703724,
  });
  assert.equal(__test__.extractTabGroupIdFromContent(content), 2049703724);
  assert.equal(
    __test__.extractPrimaryText(content),
    '{"availableTabs":[{"tabId":1256944467,"title":"New Tab","url":"chrome://newtab/"}],"tabGroupId":2049703724}',
  );
});

test('fixture: screenshot success content keeps image and metadata aligned', async () => {
  const content = await loadFixture('screenshot-success.content.json');
  assert.deepEqual(__test__.extractScreenshotMetadata(content), {
    width: 1280,
    height: 720,
    format: 'image/png',
    imageId: 'ss_fixture123',
  });
  assert.equal(__test__.extractImageIdFromContent(content), 'ss_fixture123');
  assert.deepEqual(__test__.extractImageItem(content), {
    mediaType: 'image/png',
    base64: 'ZmFrZS1wbmctYnl0ZXM=',
  });
  assert.deepEqual(__test__.summarizeContent(content), [
    'Successfully captured screenshot (1280x720, image/png) - ID: ss_fixture123',
    '[image:image/png]',
  ]);
});

test('fixture: create-tab and navigate summaries keep tab extraction stable', async () => {
  const createContent = await loadFixture('create-tab.content.json');
  const navigateContent = await loadFixture('navigate-tab.content.json');
  assert.equal(__test__.extractTabIdFromContent(createContent), 1256944468);
  assert.equal(__test__.extractTabIdFromContent(navigateContent), null);
  assert.deepEqual(__test__.normalizeToolContent(navigateContent), [
    'Navigated to https://example.org/?validate-bridge=1776002788946',
    '\n\nTab Context:\n- Executed on tabId: 1256944472\n- Available tabs:\n  • tabId 1256944471: "新しいタブ" (chrome://newtab/)\n  • tabId 1256944472: "新しいタブ" (chrome://newtab/)',
  ]);
});

test('fixture: missing-tab-group variants stay fail-closed', async () => {
  const missingGroup = await loadFixture('missing-tab-group.content.json');
  const emptyGroup = await loadFixture('close-empty-group.content.json');
  assert.equal(__test__.contentSignalsMissingTabGroup(missingGroup), true);
  assert.equal(__test__.contentSignalsMissingTabGroup(emptyGroup), true);
  assert.equal(__test__.normalizeToolContent(emptyGroup), 'No tab group exists for this session. Use createIfEmpty: true to create one.');
});
