# Compatibility

## Supported posture

This project targets the **currently installed local Claude in Chrome path** and follows Anthropic updates rather than freezing the environment forever.

Current locally validated baseline:

- Claude Code launcher target: `2.1.104`
- Live native host observed: `2.1.104`
- Chrome extension: `Claude in Chrome (Beta) 1.0.66`
- Repo baseline record: `compat/version-matrix.json`
- Maintainer gate: `npm run release:gate:live` passed on this baseline

## Compatibility policy

- The wrapper is **wrapper-only**.
- It does not patch the Anthropic extension, native host manifest, or Chrome profile.
- If downstream contract markers disappear, the wrapper should fail closed instead of pretending to work.

## Drift detection

Run:

```bash
npm run compat
```

It checks for:

- native host manifest presence
- launcher presence
- extension installation
- key private contract markers in the installed extension bundle
- live probe connectivity
- launcher/live version skew
- presence of the current version in `compat/version-matrix.json`

## Known drift risks

- private `execute_tool` request/response shape changes
- `session_scope` / `tabGroupId` semantics changing
- missing-tab-group text payload changing shape
- permission manager behavior changing across extension releases

## Test layers

- `npm test`: hermetic helper/contract coverage
- `npm run validate`: prompt-safe live MCP coverage
- `npm run validate:live`: approval-heavy browser sweep
- `npm run compat`: drift/contract marker detection
- `npm run release:gate`: prompt-safe maintainer gate
- `npm run release:gate:live`: full maintainer gate including the approval-heavy sweep

The hermetic layer now also includes fixture-based downstream content coverage for currently observed CiC responses such as:

- missing managed tab-group payloads
- tab-context JSON payloads
- screenshot success summaries
- create-tab summaries
- navigate summaries

## Version skew

Launcher/live version mismatch is reported as a warning, not an automatic hard failure. It becomes a hard problem only when behavior also diverges.

## Version matrix

The repo now keeps a checked-in baseline matrix at `compat/version-matrix.json`.

Use it for:

- recording validated local baselines
- making release drift visible in code review
- deciding whether a new Anthropic update needs parser or compatibility work

## Drift response

`npm run compat` now emits a machine-readable `decision` block as well as raw checks.

The expected maintainer response is:

- `fix-wrapper`
  - the runtime still exists, but private-contract markers drifted
  - next move: wrapper-only parser/compat repair
- `document-limitation`
  - only warning-level drift is present, such as unvalidated version skew or a matrix miss
  - next move: downgrade public claims or extend the matrix before widening support
- `reclassify-red`
  - foundational runtime discovery or live probe health failed
  - next move: re-evaluate whether wrapper-only support is still honest at all

This keeps Anthropic-side updates from turning into hand-wavy judgement calls.
