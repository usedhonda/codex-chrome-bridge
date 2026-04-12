# Codex Chrome Bridge

Repo-local MCP wrapper that reuses the local Claude Code + Claude in Chrome bridge already running on this machine.

Status: **power-user beta**.

This project is intentionally narrow. It does not replace Claude in Chrome and it does not ship a generic browser framework. It wraps the observed local CiC bridge so Codex can use it through a stable MCP surface.

## What it does

- Discovers the live Claude native-host socket and exposes it as an MCP server.
- Reuses the managed CiC tab-group lifecycle instead of inventing a separate browser stack.
- Provides a practical browser tool surface:
  - health, snapshot, tabs, open/reuse/close
  - click, type, computer actions
  - read_page, page text, JS exec, find, form input
  - console/network reads
  - screenshot and selector-based uploads

## What it does not promise

- No guarantee of long-term compatibility with future Anthropic extension updates.
- No global “trust this forever” permission bypass.
- No zero-popup guarantee on approval-heavy flows.
- No global configuration changes to Codex, Claude, or Chrome.

## Quickstart

```bash
npm run probe
npm run mcp
```

In another shell, run the prompt-safe validator:

```bash
npm run validate
```

For the approval-heavy browser sweep:

```bash
npm run validate:live
```

For compatibility/drift checks:

```bash
npm run compat
```

For the maintainer release gate:

```bash
npm run release:gate
npm run release:gate:live
```

For hermetic contract/unit coverage:

```bash
npm test
```

To launch Codex with this repo-local MCP wiring without depending on the user-level `~/.codex/config.toml`, use:

```bash
npm run codex:bridge
```

Machine-local launcher aliases can also be used from any project on this machine:

```bash
codex-bridge
codex-bridge-exec --skip-git-repo-check --json 'Use the MCP tool named mcp__codex_chrome_bridge__browser_health exactly once. Then report only connect_ok, status_ok, and host_process.binaryVersion.'
```

For a direct non-interactive MCP smoke from this repo:

```bash
npm run codex:bridge:exec -- --skip-git-repo-check --json 'Use the MCP tool named mcp__codex_chrome_bridge__browser_health exactly once. Then report only connect_ok, status_ok, and host_process.binaryVersion.'
```

## Docs

- [Quickstart](./docs/quickstart.md)
- [Compatibility](./docs/compatibility.md)
- [Known Limitations](./docs/known-limitations.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Version Matrix](./compat/version-matrix.json)
- [Investigation record](./.agent/Investigation.md)

## Why the verdict is still YELLOW

The wrapper is usable, but the downstream contract remains private and lifecycle-sensitive. The biggest remaining public-quality caveat is not missing functionality; it is Anthropic-driven protocol drift plus permission choreography on the native-messaging path.
