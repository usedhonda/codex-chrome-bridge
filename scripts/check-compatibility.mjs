#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeEntry = path.join(repoRoot, 'src', 'bridge.js');
const versionMatrixPath = path.join(repoRoot, 'compat', 'version-matrix.json');
const manifestPath =
  process.env.CLAUDE_BRIDGE_MANIFEST_PATH ??
  path.join(
    process.env.HOME,
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts',
    'com.anthropic.claude_code_browser_extension.json',
  );

const requiredContractMarkers = [
  { name: 'execute_tool', pattern: /execute_tool/ },
  { name: 'native_messaging_source', pattern: /source:\s*"native-messaging"/ },
  { name: 'tool_use_id', pattern: /toolUseId/ },
  { name: 'domain_transition', pattern: /domain_transition/ },
  { name: 'skip_all_permission_checks', pattern: /skip_all_permission_checks/ },
  { name: 'tabs_context_mcp', pattern: /tabs_context_mcp/ },
];

async function readVersionMatrix() {
  return JSON.parse(await fs.readFile(versionMatrixPath, 'utf8'));
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarizeHardFailure(checks) {
  return checks.filter((check) => check.severity === 'error' && !check.ok);
}

async function main() {
  const checks = [];
  let versionMatrix = null;

  try {
    versionMatrix = await readVersionMatrix();
    checks.push({
      name: 'version_matrix',
      ok: true,
      severity: 'error',
      detail: versionMatrixPath,
    });
  } catch (error) {
    checks.push({
      name: 'version_matrix',
      ok: false,
      severity: 'error',
      detail: error.message,
    });
  }

  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    checks.push({
      name: 'native_host_manifest',
      ok: true,
      severity: 'error',
      detail: manifestPath,
    });
  } catch (error) {
    checks.push({
      name: 'native_host_manifest',
      ok: false,
      severity: 'error',
      detail: error.message,
    });
  }

  const launcherPath = typeof manifest?.path === 'string' ? manifest.path : null;
  if (launcherPath) {
    checks.push({
      name: 'launcher_exists',
      ok: await fileExists(launcherPath),
      severity: 'error',
      detail: launcherPath,
    });
  } else {
    checks.push({
      name: 'launcher_exists',
      ok: false,
      severity: 'error',
      detail: 'manifest did not expose a launcher path',
    });
  }

  const extensionOrigin = Array.isArray(manifest?.allowed_origins)
    ? manifest.allowed_origins[0] ?? null
    : null;
  const extensionIdMatch = extensionOrigin?.match(/^chrome-extension:\/\/([a-z]{32})\/$/);
  const extensionId = extensionIdMatch ? extensionIdMatch[1] : null;
  const extensionRoot = extensionId
    ? path.join(
        process.env.HOME,
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'Default',
        'Extensions',
        extensionId,
      )
    : null;

  if (extensionRoot && (await fileExists(extensionRoot))) {
    const versions = (await fs.readdir(extensionRoot)).sort().reverse();
    const selectedVersion = versions[0] ?? null;
    const extensionDir = selectedVersion ? path.join(extensionRoot, selectedVersion) : null;
    const manifestFile = extensionDir ? path.join(extensionDir, 'manifest.json') : null;

    checks.push({
      name: 'extension_installation',
      ok: Boolean(extensionDir && manifestFile && (await fileExists(manifestFile))),
      severity: 'error',
      detail: extensionDir,
    });

    if (manifestFile && (await fileExists(manifestFile))) {
      const extensionManifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
      const extensionVersion = extensionManifest.version ?? 'unknown';
      checks.push({
        name: 'extension_version',
        ok: typeof extensionManifest.version === 'string',
        severity: 'error',
        detail: extensionVersion,
      });

      const assetDir = path.join(extensionDir, 'assets');
      const assetFiles = (await fs.readdir(assetDir)).filter((name) => name.endsWith('.js'));
      let concatenatedAssets = '';
      for (const assetFile of assetFiles) {
        concatenatedAssets += await fs.readFile(path.join(assetDir, assetFile), 'utf8');
      }

      for (const marker of requiredContractMarkers) {
        checks.push({
          name: `contract_marker:${marker.name}`,
          ok: marker.pattern.test(concatenatedAssets),
          severity: 'error',
          detail: marker.pattern.toString(),
        });
      }

      if (versionMatrix) {
        const matrixMarkerNames = Array.isArray(versionMatrix.requiredContractMarkers)
          ? versionMatrix.requiredContractMarkers
          : [];
        checks.push({
          name: 'matrix_required_markers_known',
          ok: matrixMarkerNames.every((name) =>
            requiredContractMarkers.some((marker) => marker.name === name),
          ),
          severity: 'error',
          detail: matrixMarkerNames,
        });

        const matchingBaselines = Array.isArray(versionMatrix.validatedBaselines)
          ? versionMatrix.validatedBaselines.filter(
              (baseline) => baseline.extensionVersion === extensionVersion,
            )
          : [];
        checks.push({
          name: 'extension_version_in_matrix',
          ok: matchingBaselines.length > 0,
          severity: 'warn',
          detail: {
            extensionVersion,
            matchingBaselines: matchingBaselines.map((baseline) => baseline.name),
          },
        });
      }
    }
  } else {
    checks.push({
      name: 'extension_installation',
      ok: false,
      severity: 'error',
      detail: extensionRoot ?? 'extension ID not discovered',
    });
  }

  const probe = await runNode([bridgeEntry, 'probe']);
  let probePayload = null;
  if (probe.code === 0) {
    try {
      probePayload = JSON.parse(probe.stdout);
    } catch (error) {
      checks.push({
        name: 'probe_json',
        ok: false,
        severity: 'error',
        detail: error.message,
      });
    }
  } else {
    checks.push({
      name: 'probe_command',
      ok: false,
      severity: 'error',
      detail: probe.stderr.trim() || `exit ${probe.code}`,
    });
  }

  if (probePayload) {
    checks.push({
      name: 'probe_connect',
      ok: probePayload.connect_ok === true,
      severity: 'error',
      detail: probePayload.failure_reason ?? probePayload.socket_path ?? null,
    });
    checks.push({
      name: 'probe_status',
      ok: probePayload.status_ok === true || Array.isArray(probePayload.status_summary),
      severity: 'error',
      detail: probePayload.status_summary ?? probePayload.failure_reason ?? null,
    });

    const launcherVersion = (() => {
      const match = probePayload.launcher_target?.match(/\/versions\/([^/]+)$/);
      return match ? match[1] : null;
    })();
    const liveVersion = probePayload.host_process?.binaryVersion ?? null;
    checks.push({
      name: 'launcher_live_version_match',
      ok: Boolean(launcherVersion && liveVersion && launcherVersion === liveVersion),
      severity: 'warn',
      detail: {
        launcherVersion,
        liveVersion,
      },
    });

    if (versionMatrix) {
      const matchingBaseline = Array.isArray(versionMatrix.validatedBaselines)
        ? versionMatrix.validatedBaselines.find(
            (baseline) =>
              baseline.launcherVersion === launcherVersion &&
              baseline.liveHostVersion === liveVersion,
          )
        : null;
      checks.push({
        name: 'runtime_versions_in_matrix',
        ok: Boolean(matchingBaseline),
        severity: 'warn',
        detail: matchingBaseline
          ? {
              baseline: matchingBaseline.name,
              launcherVersion,
              liveVersion,
            }
          : {
              launcherVersion,
              liveVersion,
            },
      });
    }
  }

  const failures = summarizeHardFailure(checks);
  const warnings = checks.filter((check) => check.severity === 'warn' && !check.ok);
  const result = {
    ok: failures.length === 0,
    summary: {
      failures: failures.length,
      warnings: warnings.length,
    },
    matrix: versionMatrix
      ? {
          path: versionMatrixPath,
          policy: versionMatrix.policy ?? null,
          validatedBaselines: versionMatrix.validatedBaselines ?? [],
        }
      : null,
    checks,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
