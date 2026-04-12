# Troubleshooting

## `npm run probe` fails

Check:

- Chrome is running
- Claude in Chrome is installed
- the native host manifest still exists

Then run:

```bash
npm run compat
```

## Repeated permission popups

This is a known native-messaging limitation, not necessarily a wrapper bug.

Ways to reduce it:

- prefer same-site workflows
- prefer `ALWAYS` over repeated `ONCE` grants for trusted sites
- avoid long approval-heavy sweeps unless you explicitly want them
- keep routine checks on `npm run validate`, not `npm run validate:live`

## `No MCP tab groups found`

The wrapper already attempts managed-tab-group recovery automatically. If it still persists:

```bash
npm run probe
npm run validate
```

If both fail, compatibility drift is more likely than a simple transient tab-group miss.

## Wrapper worked yesterday, not today

Treat it as possible downstream drift first.

Run:

```bash
npm run compat
npm run probe
```

If contract markers or probe health changed, fix compatibility before widening scope.
