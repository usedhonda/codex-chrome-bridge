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

Observed source-level differences:

- the installed extension's native-messaging entrypoint hard-codes `source: "native-messaging"` for tool execution
- the bridge-only path has extra orchestration knobs such as `permissionMode`, `allowedDomains`, and custom prompt handling that are not forwarded through native messaging
- the original CiC runtime also includes higher-level workflow surfaces such as `shortcuts_list` / `shortcuts_execute`

Practical consequence:

- this wrapper can expose and drive the browser tools, but it will not automatically inherit every “Claude Code feels smoother” behavior just by speaking to the same browser bridge
- getting closer to original Claude Code behavior requires more reverse engineering of the bridge-side orchestration layer, not only adding more browser tools

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
