#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const includeLive = process.argv.includes('--include-live');

const steps = [
  {
    name: 'syntax:bridge',
    cmd: process.execPath,
    args: ['--check', './src/bridge.js'],
  },
  {
    name: 'syntax:validate',
    cmd: process.execPath,
    args: ['--check', './scripts/validate-bridge.mjs'],
  },
  {
    name: 'syntax:launcher',
    cmd: process.execPath,
    args: ['--check', './scripts/run-codex-with-bridge.mjs'],
  },
  {
    name: 'compat',
    cmd: process.execPath,
    args: ['./scripts/check-compatibility.mjs'],
  },
  {
    name: 'test',
    cmd: process.execPath,
    args: ['--test', './test/*.test.mjs'],
  },
  {
    name: 'validate',
    cmd: process.execPath,
    args: ['./scripts/validate-bridge.mjs'],
  },
];

if (includeLive) {
  steps.push({
    name: 'validate:live',
    cmd: process.execPath,
    args: ['./scripts/validate-bridge.mjs', '--live-browser'],
  });
}

function runStep(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function main() {
  for (const step of steps) {
    process.stderr.write(`[release-gate] ${step.name}\n`);
    const code = await runStep(step);
    if (code !== 0) {
      process.exitCode = code;
      return;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
