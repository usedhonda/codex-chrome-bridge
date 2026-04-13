import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../src/bridge.js';

test('SessionContextManager records identity, tab state, hints, and provenance', () => {
  const sessionScope = {
    sessionId: 'session-123',
    displayName: 'Codex (MCP)',
  };
  const manager = new __test__.SessionContextManager({
    clientId: 'codex-chrome-bridge',
    sessionScope,
  });

  manager.setBridgeDisplayName('Claude Bridge');
  manager.record({
    wrapperTool: 'browser_read_page',
    downstreamTool: 'read_page',
    stage: 'tool_call',
    ok: true,
    browserContext: { tabGroupId: 77 },
    tabId: 11,
    url: 'https://example.org/',
    warnings: ['candidate_probe_fallback_used', 'candidate_probe_fallback_used'],
    sessionHints: ['session_context_reseeded'],
    permissionHints: ['permission_or_auth_intervention_needed'],
    downstreamSummary: 'read_page returned refs',
  });

  const snapshot = manager.snapshot();
  assert.deepEqual(snapshot.identity, {
    clientId: 'codex-chrome-bridge',
    sessionId: 'session-123',
    displayName: 'Codex (MCP)',
    bridgeDisplayName: 'Claude Bridge',
  });
  assert.equal(snapshot.currentTabGroupId, 77);
  assert.equal(sessionScope.tabGroupId, 77);
  assert.equal(snapshot.lastActiveTabId, 11);
  assert.equal(snapshot.lastUrl, 'https://example.org/');
  assert.deepEqual(snapshot.downstreamWarnings, ['candidate_probe_fallback_used']);
  assert.deepEqual(snapshot.sessionHints, ['session_context_reseeded']);
  assert.deepEqual(snapshot.permissionHints, ['permission_or_auth_intervention_needed']);
  assert.equal(snapshot.lastDownstreamSummary, 'read_page returned refs');
  assert.deepEqual(snapshot.toolProvenance.wrapperTool, 'browser_read_page');
  assert.deepEqual(snapshot.toolProvenance.downstreamTool, 'read_page');
  assert.equal(snapshot.toolProvenance.stage, 'tool_call');
  assert.equal(snapshot.toolProvenance.ok, true);
});

test('buildResultEnvelope normalizes common top-level fields', () => {
  const envelope = __test__.buildResultEnvelope({
    ok: true,
    stage: 'tool_call',
    warnings: ['alpha', 'alpha', 'beta'],
    sessionSnapshot: {
      identity: { clientId: 'codex-chrome-bridge' },
      currentTabGroupId: 9,
    },
    tabGroup: 9,
    downstreamSummary: 'navigate ok',
    payload: { tabId: 42, action_taken: 'navigate' },
  });

  assert.deepEqual(envelope, {
    ok: true,
    stage: 'tool_call',
    source: 'claude-code-native-host',
    warnings: ['alpha', 'beta'],
    session: {
      identity: { clientId: 'codex-chrome-bridge' },
      currentTabGroupId: 9,
    },
    tabGroup: 9,
    downstream_summary: 'navigate ok',
    tabId: 42,
    action_taken: 'navigate',
  });
});
