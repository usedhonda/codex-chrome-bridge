# 041 Bridge Token / Pairing Reverse Engineering

## Task

Reverse-engineer the installed Claude in Chrome bundle without modifying Claude, Chrome, the extension, or the wrapper runtime, and pin down three things from source:

1. how the bridge websocket token is acquired
2. how pairing state is persisted and replied to
3. where bridge-path `tool_call` execution is initiated locally

## Executive Summary

### Confirmed

- The websocket path token in `wss://bridge.claudeusercontent.com/chrome/<token>` is not generated from the local `device_id`.
- The installed bundle acquires a local OAuth access token first, then calls `https://api.anthropic.com/api/oauth/profile`, then uses `account.uuid` from that response as the websocket path token.
- The extension also sends the OAuth bearer token again inside the websocket `connect` payload when `localBridge` is false, which is the current observed configuration.
- Pairing state uses two persistent keys in `chrome.storage.local`:
  - `bridgeDeviceId`
  - `bridgeDisplayName`
- `bridgeDeviceId` is loaded from storage or created once with `crypto.randomUUID()`, then reused.
- On incoming `pairing_request`, the service-worker-side bundle either:
  - routes to a live in-extension prompt via `show_pairing_prompt`, or
  - falls back to opening `pairing.html?...`
- On confirm, the pairing UI sends `pairing_confirmed`; the service-worker-side handler persists `bridgeDisplayName` and emits a websocket `pairing_response` containing:
  - `request_id`
  - `device_id`
  - `name`
- The local receiver/executor for bridge-originated `tool_call` traffic lives in the websocket/service-worker path inside `assets/mcpPermissions-qqAoJjJ8.js`.
- The sidepanel/window-session flow is still relevant, but as an upstream orchestration path. It sends `EXECUTE_TASK` / `POPULATE_INPUT_TEXT` with `windowSessionId` / `skipPermissions`; it is not the local websocket receiver that directly handles `tool_call`.

### Hypothesis

- The remote bridge likely emits `tool_call` after the sidepanel/window-session path submits a task, but that server-side causality is not visible in the installed local source.
- The visible client-side pairing state machine strongly suggests `connect -> waiting -> pairing_request -> pairing_response -> paired`, but only the client handlers for those message types are locally visible.

## Evidence

### 1. Bridge token acquisition path

### Fact

- `assets/mcpPermissions-qqAoJjJ8.js` defines `async function Pa()` as the websocket connect routine.
- Inside `Pa()`:
  - `o = await u()` loads a valid OAuth bearer token
  - `t = await h(o)` resolves the websocket path token
  - `const s = \`wss://bridge.claudeusercontent.com/chrome/${t}\``
  - `new WebSocket(s)` opens the bridge transport
- The imported functions resolve to helpers in `assets/PermissionManager-9s959502.js`:
  - `u()` maps to `Ae`
  - `h()` maps to `Ce`
- `Ae` returns the locally stored OAuth access token only after token validity/refresh checks pass.
- `Ce` calls `${apiBaseUrl}/api/oauth/profile` with `Authorization: Bearer <token>` and returns `r?.account?.uuid`.
- The config helper in `PermissionManager-9s959502.js` still reports:
  - `environment: "production"`
  - `apiBaseUrl: "https://api.anthropic.com"`
  - `wsApiBaseUrl: "wss://api.anthropic.com"`
  - `localBridge: !1`
- On websocket open, the extension sends:
  - `type: "connect"`
  - `client_type: "chrome-extension"`
  - `device_id`
  - `extension_version`
  - optional `display_name`
  - and, because `localBridge` is false, `oauth_token`

### Conclusion

- The `<token>` in `wss://bridge.claudeusercontent.com/chrome/<token>` is source-confirmed to be `account.uuid` from `/api/oauth/profile`, not a locally generated session token and not `bridgeDeviceId`.

### 2. Pairing lifecycle

### Fact

- `assets/mcpPermissions-qqAoJjJ8.js` defines:
  - `Sa()` -> read `bridgeDisplayName` from `chrome.storage.local`
  - `Da()` -> read `bridgeDeviceId` from `chrome.storage.local`, or generate/store it with `crypto.randomUUID()`
- The websocket message handler in `Pa().onmessage` handles `pairing_request`.
- On `pairing_request`, the bundle:
  - de-duplicates by `request_id`
  - reads the current display name via `Sa()`
  - tries `chrome.runtime.sendMessage({ type: "show_pairing_prompt", ... })`
  - if not handled, opens `pairing.html?request_id=...&client_type=...&current_name=...`
- `assets/pairing-H3Cs7KHl.js` confirms the pairing UI behavior:
  - confirm -> `chrome.runtime.sendMessage({ type: "pairing_confirmed", request_id, name })`
  - dismiss -> `chrome.runtime.sendMessage({ type: "pairing_dismissed", request_id })`
- The service-worker-side listener in `assets/mcpPermissions-qqAoJjJ8.js` handles `pairing_confirmed` by:
  - persisting `bridgeDisplayName`
  - loading `bridgeDeviceId` via `Da()`
  - emitting websocket `pairing_response` with `request_id`, `device_id`, and `name`
- The same source pass did not find a corresponding outgoing `pairing_response` path for `pairing_dismissed`.
- The websocket client explicitly handles these related message types:
  - `waiting`
  - `paired`
  - `pairing_request`

### Conclusion

- Pairing persistence is source-confirmed in `chrome.storage.local`.
- `bridgeDeviceId` is the durable device identity used in both `connect` and `pairing_response`.
- `bridgeDisplayName` is the user-facing persisted label.
- The positive pairing path is source-confirmed end to end.
- A negative/dismiss path exists in the UI but is not source-confirmed as a matching websocket reply in the currently inspected client bundle.

### 3. Bridge-path `tool_call` initiator

### Fact

- `assets/mcpPermissions-qqAoJjJ8.js` handles websocket `tool_call` inside `Pa().onmessage`.
- That handler:
  - checks `target_device_id`
  - extracts `tool_use_id`, `tool`, `args`, `permission_mode`, `allowed_domains`, `handle_permission_prompts`, `session_scope`
  - calls the internal executor with `source: "bridge"`
  - emits websocket `tool_result` on completion
- Bridge-originated permission prompts are also wired here:
  - the local executor installs `onPermissionRequired`
  - that callback emits websocket `permission_request`
  - incoming websocket `permission_response` resolves the pending local promise
- `assets/service-worker.ts-H0DVM1LS.js` and `assets/sidepanel-BoLm9pmH.js` separately confirm an upstream task-submission workflow:
  - `open_side_panel`
  - `POPULATE_INPUT_TEXT`
  - `EXECUTE_TASK`
  - `windowSessionId`
  - `skipPermissions`
- `assets/sidepanel-BoLm9pmH.js` handles those messages and gates them against the current sidepanel/window session.

### Conclusion

- The local receiver/executor for bridge-originated `tool_call` traffic is the websocket/service-worker path in `assets/mcpPermissions-qqAoJjJ8.js`.
- The sidepanel code is not the direct local consumer of websocket `tool_call`; it is the visible orchestration/UI layer that appears to precede remote bridge task issuance.

## Impact

### Confirmed gap shrink

- The repo already knew that original Claude Code used a `source: "bridge"` path.
- This pass reduces ambiguity in three specific places:
  - what the websocket path token actually is
  - where pairing identity is persisted
  - where bridge `tool_call` is locally received and executed

### Remaining unknowns

- How the remote bridge token/profile path is authorized beyond the locally visible OAuth helpers
- What exact server-side transition follows `pairing_response`
- What exact upstream action on the remote side turns a sidepanel task into a websocket `tool_call`

## Fact / Hypothesis Boundary

### Fact

- `account.uuid` from `/api/oauth/profile` becomes the websocket path token
- `bridgeDeviceId` and `bridgeDisplayName` live in `chrome.storage.local`
- `pairing_confirmed` persists `bridgeDisplayName` and emits `pairing_response`
- websocket `tool_call` is locally received/executed in the service-worker-side bridge bundle

### Hypothesis

- The remote bridge emits `tool_call` because the sidepanel/window-session flow submitted a task upstream
- The full pairing state machine probably moves through `waiting` to `paired`, but only the client-side edges are locally visible

## Commands

```text
rg -n -C 3 'wss://bridge\\.claudeusercontent\\.com/chrome/|async function Pa|async function Da|async function Sa|pairing_request|pairing_response|tool_call|permission_request|show_pairing_prompt|pairing_confirmed|pairing_dismissed' "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.66_0/assets/mcpPermissions-qqAoJjJ8.js" "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.66_0/assets/pairing-H3Cs7KHl.js" "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.66_0/assets/service-worker.ts-H0DVM1LS.js" "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.66_0/assets/sidepanel-BoLm9pmH.js"
rg -n -C 3 'api/oauth/profile|bridgeDeviceId|bridgeDisplayName|async function Ae|async function Ce|localBridge|environment:\"production\"|wsApiBaseUrl|ACCESS_TOKEN' "$HOME/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.66_0/assets/PermissionManager-9s959502.js"
python3 (substring extraction helper over the same installed bundle files)
```
