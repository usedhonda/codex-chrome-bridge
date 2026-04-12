# Quickstart

## Prerequisites

- macOS with Google Chrome
- local Claude in Chrome/native-host runtime already present on the machine
- Node.js 24+

This project does **not** install or patch the Anthropic extension for you. It assumes the local CiC path already exists, and it does not require you to keep a Claude Code terminal session open while using the wrapper.

## First run

```bash
npm run probe
```

Expected result:

- a live native-host process
- a Unix socket under `/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock`
- `connect_ok: true`

This is the main safety check: it proves the existing bridge is reachable before you ask Codex to use it.

Start the MCP wrapper:

```bash
npm run mcp
```

Run the prompt-safe validator:

```bash
npm run validate
```

Run the hermetic contract/unit layer:

```bash
npm test
```

## Launch Codex with the repo-local MCP

Use the repo-local launcher when you want Codex itself to see this MCP without inheriting unrelated failures from the user-level `~/.codex/config.toml`:

```bash
npm run codex:bridge
```

For a direct non-interactive smoke:

```bash
npm run codex:bridge:exec -- --skip-git-repo-check --json 'Use the MCP tool named mcp__codex_chrome_bridge__browser_health exactly once. Then report only connect_ok, status_ok, and host_process.binaryVersion.'
```

## Use it from other projects on this machine

Machine-local launchers now exist in `~/bin`:

```bash
codex-bridge
codex-bridge-exec --skip-git-repo-check --json 'Use the MCP tool named mcp__codex_chrome_bridge__browser_health exactly once. Then report only connect_ok, status_ok, and host_process.binaryVersion.'
```

To target another project root explicitly:

```bash
codex-bridge -C /path/to/other/project
codex-bridge-exec -C /path/to/other/project --skip-git-repo-check --json 'Use the MCP tool named mcp__codex_chrome_bridge__browser_health exactly once. Then report only connect_ok, status_ok, and host_process.binaryVersion.'
```

## Approval-heavy validation

```bash
npm run validate:live
```

Use this only when you intentionally want to exercise the permission-heavy browser path. It may trigger CiC permission popups.

## Compatibility check

```bash
npm run compat
```

This verifies the currently observed contract:

- native host manifest exists
- launcher exists
- extension assets still expose key private contract markers
- probe can still connect

The validated local baseline is tracked in:

```bash
compat/version-matrix.json
```

## Release gate

Prompt-safe release gate:

```bash
npm run release:gate
```

Full maintainer gate:

```bash
npm run release:gate:live
```
