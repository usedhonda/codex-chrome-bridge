# Known Limitations

## Permission choreography

The native-messaging path still flows through CiC permission management.

Observed behavior:

- `ALWAYS` permissions persist by netloc
- `ONCE` permissions are keyed by `toolUseId` and self-destruct after one use
- `domain_transition` is checked separately

Practical consequence:

- repeated popups on the same site are still possible when tool category changes, a new domain boundary is crossed, or previous grants were only `ONCE`

## Private downstream contract

This wrapper depends on Anthropic-owned extension/native-host internals that are not documented as a public third-party API.

Practical consequence:

- future extension updates can break behavior even when the wrapper code itself does not change

## Not the full Claude Code orchestration layer

This project reuses the existing Claude in Chrome/native-host browser path, but it does **not** become the full Claude Code product runtime.

The current wrapper-only boundary intentionally leaves these three areas as limitations rather than pretending to fully recreate them:

- bridge token acquisition / remote bridge auth
- pairing server-side semantics beyond the locally visible confirm path
- the upstream bridge control-plane that turns sidepanel task state into remote `tool_call`

Observed source-level differences:

- the installed extension's native-messaging entrypoint hard-codes `source: "native-messaging"` for tool execution
- the original in-product path enters from the sidepanel/window-session workflow, not from native messaging alone
- that sidepanel path carries higher-level state such as prompt population, selected model, attachments, window session IDs, and skip-permission/session UI state
- bridge-originated tool calls are sent through a separate `source: "bridge"` branch that reports `tool_result` / `permission_request` events over the bridge channel
- the bridge-only path has extra orchestration knobs such as `permissionMode`, `allowedDomains`, and custom prompt handling that are not forwarded through native messaging
- the original CiC runtime also includes higher-level workflow surfaces such as `shortcuts_list` / `shortcuts_execute`

Practical consequence:

- this wrapper can expose and drive the browser tools, but it will not automatically inherit every “Claude Code feels smoother” behavior just by speaking to the same browser bridge
- getting closer to original Claude Code behavior requires more reverse engineering of the bridge-side orchestration layer, not only adding more browser tools
- the wrapper now has better local parity helpers (session context, result summaries, handoff hints), but those are still local wrapper behavior, not bridge-server parity

More concretely:

- the wrapper currently speaks to the observed native-messaging/browser-tool surface
- original Claude Code appears to layer a sidepanel-driven orchestration loop on top of that surface
- so parity gaps are now more about missing orchestration state than missing raw browser primitives
- maintainers can re-check that split with `npm run inspect:orchestration`, which inspects the installed bundle without patching Claude/CiC

### Explicit wrapper-only limits

#### 1. Bridge token acquisition / remote bridge auth

Observed source-level facts:

- the installed bundle opens `wss://bridge.claudeusercontent.com/chrome/<token>`
- that `<token>` is resolved from the OAuth bearer path by calling `/api/oauth/profile` and taking `account.uuid`
- the same bridge connect payload also carries `oauth_token` in the currently observed production path

Practical consequence:

- the wrapper can inspect and document this flow, but it does not currently replace or recreate the Anthropic-owned bridge authentication path

#### 2. Pairing server-side semantics

Observed source-level facts:

- `bridgeDeviceId` and `bridgeDisplayName` are persisted locally in `chrome.storage.local`
- the client-side confirm path emits `pairing_response { request_id, device_id, name }`
- the installed UI also emits `pairing_dismissed`, but the full server-side contract around dismiss/confirm transitions is not locally visible

Practical consequence:

- the wrapper can mirror local identity/session state, but it should not claim full parity for the remote pairing lifecycle

#### 3. Upstream bridge control-plane

Observed source-level facts:

- sidepanel/service-worker code drives `EXECUTE_TASK`, `POPULATE_INPUT_TEXT`, `windowSessionId`, and `skipPermissions`
- websocket-side bridge code separately receives `tool_call` and emits `tool_result` / `permission_request`
- the locally visible source does not expose the full server-side step that turns the sidepanel workflow into remote bridge `tool_call`

Practical consequence:

- wrapper-only parity should focus on local orchestration helpers, not on pretending that the upstream Anthropic bridge control-plane has been recreated

## New conversation tab bias

The installed CiC source explicitly documents a create-first bias for new conversations:

- `tabs_context_mcp` says each new conversation should create its own new tab unless the user explicitly asks to reuse an existing one

Practical consequence:

- extra tab creation is not always a wrapper bug; some of it is original CiC design pressure
- this wrapper can smooth specific cases, like reusing the bootstrap blank tab, but should not pretend the downstream model is reuse-first by default

## Power-user beta boundary

This project is suitable for users who can:

- run validators
- read structured errors
- tolerate occasional compatibility churn

It is not yet aimed at non-technical “install and forget” usage.
