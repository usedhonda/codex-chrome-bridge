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

## Power-user beta boundary

This project is suitable for users who can:

- run validators
- read structured errors
- tolerate occasional compatibility churn

It is not yet aimed at non-technical “install and forget” usage.
