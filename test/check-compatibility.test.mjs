import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../scripts/check-compatibility.mjs';

test('compatibility decision is none when no failures or warnings exist', () => {
  assert.deepEqual(__test__.determineDriftDecision([], {}), {
    action: 'none',
    rationale: 'The current environment matches a validated wrapper-only baseline.',
    triggeredBy: [],
  });
});

test('compatibility decision escalates foundational runtime failures to red re-evaluation', () => {
  const decision = __test__.determineDriftDecision([
    { name: 'probe_connect', ok: false, severity: 'error' },
    { name: 'probe_status', ok: false, severity: 'error' },
  ]);

  assert.equal(decision.action, 'reclassify-red');
  assert.deepEqual(decision.triggeredBy, ['probe_connect', 'probe_status']);
});

test('compatibility decision prefers wrapper-only fixes for contract marker drift', () => {
  const decision = __test__.determineDriftDecision([
    { name: 'contract_marker:execute_tool', ok: false, severity: 'error' },
  ]);

  assert.equal(decision.action, 'fix-wrapper');
  assert.deepEqual(decision.triggeredBy, ['contract_marker:execute_tool']);
});

test('compatibility decision downgrades warning-only drift to limitation work', () => {
  const decision = __test__.determineDriftDecision([
    { name: 'extension_version_in_matrix', ok: false, severity: 'warn' },
    { name: 'runtime_versions_in_matrix', ok: false, severity: 'warn' },
  ]);

  assert.equal(decision.action, 'document-limitation');
  assert.deepEqual(decision.triggeredBy, [
    'extension_version_in_matrix',
    'runtime_versions_in_matrix',
  ]);
});

test('compatibility decision honors policy action overrides', () => {
  const decision = __test__.determineDriftDecision(
    [{ name: 'contract_marker:execute_tool', ok: false, severity: 'error' }],
    {
      wrapperFix: 'repair-wrapper',
      limitationFallback: 'note-limitation',
      redReevaluation: 'downgrade-red',
    },
  );

  assert.equal(decision.action, 'repair-wrapper');
});
