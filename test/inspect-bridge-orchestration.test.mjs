import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../scripts/inspect-bridge-orchestration.mjs';

test('extension id is derived from allowed_origins', () => {
  const extensionId = __test__.extensionIdFromManifest({
    allowed_origins: ['chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/'],
  });

  assert.equal(extensionId, 'fcoeoabgfenejglbffodgkkbkcdhcgfn');
});

test('marker inspection separates native messaging from bridge-side groups', () => {
  const files = [
    {
      relativePath: 'assets/worker.js',
      content: `
        execute_tool
        source: "native-messaging"
        source: "bridge"
        permissionMode
        allowedDomains
        toolUseId
        wss://bridge.claudeusercontent.com/chrome/
        tool_call
        tool_result
        permission_request
        pairing_request
        EXECUTE_TASK
        POPULATE_INPUT_TEXT
        windowSessionId
        skipPermissions
      `,
    },
  ];

  const groups = __test__.inspectMarkerGroups(files);
  const summary = __test__.summarizeInspection(groups);

  assert.equal(summary.summary.nativeMessagingPathConfirmed, true);
  assert.equal(summary.summary.bridgeTransportConfirmed, true);
  assert.equal(summary.summary.bridgeOrchestrationConfirmed, true);
  assert.equal(summary.summary.sidepanelWorkflowConfirmed, true);
  assert.deepEqual(summary.summary.missingCriticalMarkers, []);
});

test('summary marks missing orchestration markers conservatively', () => {
  const files = [
    {
      relativePath: 'assets/worker.js',
      content: 'execute_tool source: "native-messaging"',
    },
  ];

  const groups = __test__.inspectMarkerGroups(files);
  const summary = __test__.summarizeInspection(groups);

  assert.equal(summary.summary.nativeMessagingPathConfirmed, true);
  assert.equal(summary.summary.bridgeTransportConfirmed, false);
  assert.equal(summary.summary.bridgeOrchestrationConfirmed, false);
  assert.equal(summary.summary.sidepanelWorkflowConfirmed, false);
  assert.match(summary.summary.missingCriticalMarkers[0], /^bridgeTransport:/);
});

test('text formatter includes interpretation and missing markers', () => {
  const report = {
    runtime: {
      nativeMessagingManifestPath: '/tmp/manifest.json',
      launcherPath: '/tmp/launcher',
      extensionId: 'abc',
      extensionVersion: '1.2.3',
      extensionDir: '/tmp/ext',
    },
    groups: [
      {
        label: 'Bridge transport',
        complete: false,
        foundCount: 1,
        totalCount: 2,
        markers: [
          { name: 'tool_call', found: true, matchedFiles: ['assets/sw.js'] },
          { name: 'pairing_request', found: false, matchedFiles: [] },
        ],
      },
    ],
    summary: {
      nativeMessagingPathConfirmed: true,
      bridgeTransportConfirmed: false,
      bridgeOrchestrationConfirmed: false,
      sidepanelWorkflowConfirmed: false,
      missingCriticalMarkers: ['bridgeTransport:pairing_request'],
    },
    interpretation: ['One or more critical orchestration markers are missing.'],
  };

  const text = __test__.formatTextReport(report);
  assert.match(text, /Bridge orchestration inspection/);
  assert.match(text, /missing critical markers: bridgeTransport:pairing_request/);
  assert.match(text, /Interpretation/);
});
