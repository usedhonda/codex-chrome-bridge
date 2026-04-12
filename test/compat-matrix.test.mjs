import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const matrixPath = path.join(process.cwd(), 'compat', 'version-matrix.json');

test('compatibility matrix has required top-level shape', async () => {
  const matrix = JSON.parse(await fs.readFile(matrixPath, 'utf8'));
  assert.equal(typeof matrix.policy?.mode, 'string');
  assert.equal(Array.isArray(matrix.requiredContractMarkers), true);
  assert.equal(Array.isArray(matrix.validatedBaselines), true);
  assert.equal(matrix.validatedBaselines.length > 0, true);
});

test('compatibility matrix records current validated local baseline', async () => {
  const matrix = JSON.parse(await fs.readFile(matrixPath, 'utf8'));
  const baseline = matrix.validatedBaselines.find(
    (entry) => entry.name === '2026-04-12-local-baseline',
  );
  assert.deepEqual(
    {
      extensionVersion: baseline?.extensionVersion,
      launcherVersion: baseline?.launcherVersion,
      liveHostVersion: baseline?.liveHostVersion,
      status: baseline?.status,
    },
    {
      extensionVersion: '1.0.66',
      launcherVersion: '2.1.104',
      liveHostVersion: '2.1.104',
      status: 'validated',
    },
  );
});
