#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const defaultManifestPath = path.join(
  process.env.HOME ?? '',
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'NativeMessagingHosts',
  'com.anthropic.claude_code_browser_extension.json',
);

const orchestrationGroups = [
  {
    name: 'nativeMessagingPath',
    label: 'Native-messaging entrypoint',
    markers: [
      { name: 'execute_tool', pattern: /execute_tool/ },
      { name: 'source_native_messaging', pattern: /source:\s*"native-messaging"/ },
    ],
  },
  {
    name: 'bridgeTransport',
    label: 'Bridge transport',
    markers: [
      {
        name: 'bridge_websocket_url',
        pattern: /wss:\/\/bridge\.claudeusercontent\.com\/chrome\//,
      },
      { name: 'tool_call', pattern: /\btool_call\b/ },
      { name: 'tool_result', pattern: /\btool_result\b/ },
      { name: 'permission_request', pattern: /\bpermission_request\b/ },
      { name: 'pairing_request', pattern: /\bpairing_request\b/ },
    ],
  },
  {
    name: 'bridgeOrchestration',
    label: 'Bridge-side orchestration',
    markers: [
      { name: 'source_bridge', pattern: /source:\s*"bridge"/ },
      { name: 'permission_mode', pattern: /\bpermissionMode\b/ },
      { name: 'allowed_domains', pattern: /\ballowedDomains\b/ },
      { name: 'tool_use_id', pattern: /\btoolUseId\b/ },
    ],
  },
  {
    name: 'sidepanelWorkflow',
    label: 'Sidepanel / window-session workflow',
    markers: [
      { name: 'execute_task', pattern: /\bEXECUTE_TASK\b/ },
      { name: 'populate_input_text', pattern: /\bPOPULATE_INPUT_TEXT\b/ },
      { name: 'window_session_id', pattern: /\bwindowSessionId\b/ },
      { name: 'skip_permissions', pattern: /\bskipPermissions\b/ },
    ],
  },
];

function parseArgs(argv) {
  const args = {
    json: false,
    manifestPath: process.env.CLAUDE_BRIDGE_MANIFEST_PATH ?? defaultManifestPath,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--manifest-path') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--manifest-path requires a value');
      }
      args.manifestPath = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function expandHome(filePath) {
  if (!filePath) {
    return filePath;
  }
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME ?? '', filePath.slice(2));
  }
  return filePath;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function extensionIdFromManifest(manifest) {
  const allowedOrigin = Array.isArray(manifest?.allowed_origins)
    ? manifest.allowed_origins[0] ?? null
    : null;
  const match = allowedOrigin?.match(/^chrome-extension:\/\/([a-z]{32})\/$/);
  return match ? match[1] : null;
}

async function discoverInstalledExtension(manifestPath) {
  const manifest = await readJson(manifestPath);
  const extensionId = extensionIdFromManifest(manifest);
  if (!extensionId) {
    throw new Error('Could not derive the Chrome extension id from allowed_origins');
  }

  const extensionRoot = path.join(
    process.env.HOME ?? '',
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'Default',
    'Extensions',
    extensionId,
  );
  if (!(await fileExists(extensionRoot))) {
    throw new Error(`Chrome extension root not found: ${extensionRoot}`);
  }

  const versions = (await fs.readdir(extensionRoot)).sort().reverse();
  const version = versions[0] ?? null;
  if (!version) {
    throw new Error(`No installed extension versions were found under ${extensionRoot}`);
  }

  const extensionDir = path.join(extensionRoot, version);
  const extensionManifestPath = path.join(extensionDir, 'manifest.json');
  const extensionManifest = await readJson(extensionManifestPath);

  return {
    nativeMessagingManifestPath: manifestPath,
    launcherPath: typeof manifest.path === 'string' ? expandHome(manifest.path) : null,
    extensionId,
    extensionDir,
    extensionVersion: extensionManifest.version ?? version,
  };
}

async function loadJavaScriptFiles(extensionDir) {
  const assetsDir = path.join(extensionDir, 'assets');
  const filePaths = [];

  if (await fileExists(assetsDir)) {
    const assetFiles = (await fs.readdir(assetsDir))
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => path.join(assetsDir, name));
    filePaths.push(...assetFiles);
  }

  for (const name of ['service-worker-loader.js', 'sidepanel.bundle.js']) {
    const candidate = path.join(extensionDir, name);
    if (await fileExists(candidate)) {
      filePaths.push(candidate);
    }
  }

  const files = [];
  for (const filePath of filePaths) {
    files.push({
      filePath,
      relativePath: path.relative(extensionDir, filePath) || path.basename(filePath),
      content: await fs.readFile(filePath, 'utf8'),
    });
  }
  return files;
}

function inspectMarkerGroups(files, groups = orchestrationGroups) {
  return groups.map((group) => {
    const markers = group.markers.map((marker) => {
      const matchedFiles = files
        .filter((file) => marker.pattern.test(file.content))
        .map((file) => file.relativePath);
      return {
        name: marker.name,
        found: matchedFiles.length > 0,
        matchedFiles,
      };
    });
    return {
      name: group.name,
      label: group.label,
      markers,
      complete: markers.every((marker) => marker.found),
      foundCount: markers.filter((marker) => marker.found).length,
      totalCount: markers.length,
    };
  });
}

function summarizeInspection(groupResults) {
  const missingCriticalMarkers = groupResults.flatMap((group) =>
    group.markers
      .filter((marker) => !marker.found)
      .map((marker) => `${group.name}:${marker.name}`),
  );

  const summary = {
    nativeMessagingPathConfirmed:
      groupResults.find((group) => group.name === 'nativeMessagingPath')?.complete ?? false,
    bridgeTransportConfirmed:
      groupResults.find((group) => group.name === 'bridgeTransport')?.complete ?? false,
    bridgeOrchestrationConfirmed:
      groupResults.find((group) => group.name === 'bridgeOrchestration')?.complete ?? false,
    sidepanelWorkflowConfirmed:
      groupResults.find((group) => group.name === 'sidepanelWorkflow')?.complete ?? false,
    missingCriticalMarkers,
  };

  const interpretation = [];
  if (summary.nativeMessagingPathConfirmed) {
    interpretation.push(
      'The installed extension still exposes the native-messaging execute_tool path that the wrapper consumes today.',
    );
  }
  if (summary.bridgeTransportConfirmed && summary.bridgeOrchestrationConfirmed) {
    interpretation.push(
      'The original bridge-only control plane remains visible in the installed bundle as a distinct source:"bridge" path with bridge transport events.',
    );
  }
  if (summary.sidepanelWorkflowConfirmed) {
    interpretation.push(
      'Original Claude Code/CiC still appears to enter that bridge path through a sidepanel/window-session workflow rather than native messaging alone.',
    );
  }
  if (missingCriticalMarkers.length > 0) {
    interpretation.push(
      'One or more critical orchestration markers are missing, so parity claims should be treated conservatively until the drift is explained.',
    );
  }

  return { summary, interpretation };
}

function formatTextReport(report) {
  const lines = [
    'Bridge orchestration inspection',
    `- manifest: ${report.runtime.nativeMessagingManifestPath}`,
    `- launcher: ${report.runtime.launcherPath ?? 'unknown'}`,
    `- extension: ${report.runtime.extensionId} @ ${report.runtime.extensionVersion}`,
    `- bundle root: ${report.runtime.extensionDir}`,
    '',
  ];

  for (const group of report.groups) {
    lines.push(
      `${group.label}: ${group.complete ? 'complete' : `partial (${group.foundCount}/${group.totalCount})`}`,
    );
    for (const marker of group.markers) {
      const location = marker.found ? marker.matchedFiles.join(', ') : 'missing';
      lines.push(`  - ${marker.name}: ${location}`);
    }
    lines.push('');
  }

  lines.push('Summary');
  lines.push(
    `- native messaging path confirmed: ${report.summary.nativeMessagingPathConfirmed ? 'yes' : 'no'}`,
  );
  lines.push(
    `- bridge transport confirmed: ${report.summary.bridgeTransportConfirmed ? 'yes' : 'no'}`,
  );
  lines.push(
    `- bridge orchestration confirmed: ${report.summary.bridgeOrchestrationConfirmed ? 'yes' : 'no'}`,
  );
  lines.push(
    `- sidepanel workflow confirmed: ${report.summary.sidepanelWorkflowConfirmed ? 'yes' : 'no'}`,
  );

  if (report.summary.missingCriticalMarkers.length > 0) {
    lines.push(
      `- missing critical markers: ${report.summary.missingCriticalMarkers.join(', ')}`,
    );
  } else {
    lines.push('- missing critical markers: none');
  }

  if (report.interpretation.length > 0) {
    lines.push('');
    lines.push('Interpretation');
    for (const line of report.interpretation) {
      lines.push(`- ${line}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function inspectBridgeOrchestration({ manifestPath }) {
  const runtime = await discoverInstalledExtension(manifestPath);
  const files = await loadJavaScriptFiles(runtime.extensionDir);
  const groups = inspectMarkerGroups(files);
  const { summary, interpretation } = summarizeInspection(groups);
  return {
    runtime,
    scannedFiles: files.map((file) => file.relativePath),
    groups,
    summary,
    interpretation,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await inspectBridgeOrchestration({
    manifestPath: expandHome(args.manifestPath),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(formatTextReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const __test__ = {
  expandHome,
  extensionIdFromManifest,
  inspectMarkerGroups,
  summarizeInspection,
  formatTextReport,
};
