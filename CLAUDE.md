@AGENTS.md

# AGENTS.md

## Mission

This repository is being used to answer one concrete question and, only if the answer is favorable, to continue directly into implementation.

The question is this:

Can Codex reliably use the same local Chrome / Claude in Chrome environment that currently works with Claude Code, by means of a local wrapper MCP that presents a stable interface to Codex?

The preferred outcome is not merely a memo. The preferred outcome is a disciplined sequence:

1. investigate the local machine and the real runtime topology,
2. decide whether the idea is feasible,
3. if feasible, continue into a minimal proof-of-life wrapper,
4. if that succeeds, continue into a more usable implementation,
5. if it is not feasible or is too brittle, stop cleanly and recommend the safest alternative.

This file is the operating contract for that work. Read it fully before doing anything. Do not skim it and start coding.

## Big Picture

This is not a generic “build a browser MCP” task.

The desired target is narrower and more specific:

- there is already a local Claude Code + Claude in Chrome setup on this machine,
- that existing setup may already expose some local bridge, host process, socket, pipe, or other runtime artifact,
- the goal is to determine whether Codex can benefit from that same local environment without depending on fragile, manual babysitting,
- the wrapper MCP should ideally normalize the downstream behavior into a small, stable, low-surprise tool surface.

The first goal is truth, not optimism. If the answer is “no”, or “only with fragile undocumented coupling”, say so clearly.

## Non-Goals

Do not silently drift into any of these:

- replacing the user’s browser workflow with a completely unrelated browser automation stack unless the original idea is shown to be weak,
- breaking or reconfiguring the user’s working Claude Code / Claude in Chrome setup just to make the experiment easier,
- introducing dangerous full-access automation before feasibility is clear,
- depending on undocumented private behavior without labeling it as such,
- shipping something that “works once on this machine” but has no explanation, no logs, and no documented operating model,
- expanding into a general browser-agent platform unless that is explicitly required later.

## Core Execution Contract

Before you take action, internalize the following contract.

You must begin with investigation and planning. You must not begin with implementation.

You must prefer local evidence over assumptions. If you think you know how Claude in Chrome works internally, treat that as a hypothesis until you confirm it on this machine.

You must distinguish clearly between:

- confirmed facts,
- reasonable inferences,
- guesses,
- undocumented private behavior.

You must write down your findings as you go so another agent or human can resume from the written documents alone.

You must continue autonomously through the approved path when the gate criteria are met. Do not stop to ask for “next steps” at every milestone. Only interrupt for real blockers, destructive changes, or permissions that cannot be worked around safely.

## How to Start

At the start of the run, do the following in order.

1. Read this entire file.
2. Create the documentation working set described below.
3. Enter planning mode in substance, even if the surface does not have an explicit toggle.
4. Produce an investigation-first plan before making code changes.
5. Treat investigation as the mandatory first milestone.

## Required Documentation Working Set

Create and maintain these files under `.agent/` unless the repository already has a clearly better equivalent location.

### `.agent/Investigation.md`

This is the factual record of what you discovered.

It must contain:

- Executive summary
- Environment snapshot
- Codex-side facts
- Claude Code / Claude in Chrome facts
- Runtime topology actually observed on this machine
- Coupling analysis
- Stability risks
- Feasibility verdict: GREEN / YELLOW / RED
- Recommended next move
- Appendix of commands run and important outputs

### `.agent/Plan.md`

This is the milestone plan.

It must contain:

- Objective
- Scope and non-scope
- Milestones
- Acceptance criteria for each milestone
- Validation commands or validation approach per milestone
- Stop rules
- Decision notes that prevent oscillation

### `.agent/Documentation.md`

This is the living status and audit log.

It must contain:

- Current phase
- What was completed
- What is next
- Decisions made and why
- Surprises and discoveries
- Known issues
- How to run the current state
- How to demonstrate the current state

### `.agent/Implement.md`

Create this only after the investigation gate has been passed.

This is the execution runbook. It should tell the agent how to proceed without drifting.

It must make clear that:

- `Plan.md` is the source of truth for milestones,
- validations must be run after each milestone,
- failures must be repaired before proceeding,
- documentation must be updated continuously.

## Operating Principles

### 1. Local evidence wins

Prefer facts from the current machine over memory, blog posts, guesswork, or community lore.

If you inspect a manifest file, running process, socket, config file, binary path, or log file, that is stronger than any prior belief.

### 2. Official interfaces beat reverse engineering

If an official surface exists, prefer it.

If you must use reverse-engineered or undocumented runtime behavior, keep that behavior isolated behind an adapter layer and label it clearly in the docs and code.

### 3. Preserve the working environment

Do not casually modify:

- the user’s Chrome profile,
- extension site permissions,
- Claude Code configuration,
- native messaging host manifests,
- `~/.codex/config.toml`,
- other global settings.

Treat these as late-stage integration surfaces, not early-stage experimentation tools.

### 4. Small stable surfaces are better than large magical ones

The wrapper MCP should not begin by exposing every possible browser action.

Start with a small surface that proves the architecture:

- health / readiness,
- observe current browser state,
- open or focus a tab.

Only expand when the lower layer is stable.

### 5. Do not hide brittleness

If the design only works while a live Claude Code session remains open, or only after manual extension reconnection, or only with a particular process order, document that plainly.

A clever but brittle prototype is still useful, but only if its brittleness is obvious.

## Known Context to Carry In Your Head

Work from these assumptions unless local evidence disproves them.

- Codex can use MCP servers and is comfortable with local process-based servers. A local stdio wrapper is therefore a natural target.
- Codex benefits from plan-first execution and from durable markdown files that capture the plan, status, and decisions.
- Claude Code + Claude in Chrome use a browser extension and a native messaging host configuration. Connection and idle problems may occur over long sessions.
- The desired outcome is not to control Chrome “somehow”; the desired outcome is to determine whether the existing Claude Code / Claude in Chrome path can be reused safely and usefully by Codex.

These are starting assumptions, not permission to skip verification.

## Gate System

You must classify the result of the investigation with one of three verdicts.

### GREEN

Choose GREEN only if the following are substantially true:

- a reusable local bridge or adapter path is real on this machine,
- the bridge can be consumed without unacceptable manual choreography,
- the path is stable enough for a proof-of-life wrapper and probably for a practical local tool,
- the likely failure modes are understandable and containable,
- the implementation can be kept scoped.

If the verdict is GREEN, proceed to the minimal proof-of-life wrapper automatically.

### YELLOW

Choose YELLOW if the path appears technically possible but has meaningful brittleness, such as:

- dependence on undocumented runtime behavior,
- dependence on a live Claude Code session,
- weak reconnect behavior,
- fragile process or timing assumptions,
- incomplete observability.

If the verdict is YELLOW, proceed only to a minimal proof-of-life wrapper. Do not proceed to a broader or more polished implementation unless that proof-of-life is unusually strong and well-contained.

### RED

Choose RED if one or more of the following are true:

- no real reusable local bridge can be confirmed,
- the path requires risky invasive changes to the user’s existing setup,
- the result would be too brittle to justify maintaining,
- the path is inferior enough to a cleaner alternative that it should not be pursued.

If the verdict is RED, stop after documentation and recommend alternatives. Do not force an implementation just to produce code.

## Mandatory Investigation Scope

The first phase is investigation only. No implementation work before this phase is complete.

### A. Environment baseline

Establish the working baseline.

Confirm and record:

- operating system and relevant shell/runtime environment,
- working directory and repository root,
- whether the repo already contains agent guidance files,
- the presence and versions of Codex and Claude Code binaries,
- what language toolchains are available for implementation,
- whether Chrome or Edge is currently running.

The goal is to know what tools are actually present before discussing architecture.

### B. Codex-side capability surface

Determine what the Codex side can and should consume.

At minimum, record:

- whether there is existing Codex MCP configuration,
- whether project-scoped or user-scoped configuration is already in play,
- whether the task should prefer a project-scoped `.codex/config.toml` over the global config,
- what sandbox and approval posture is currently active or appropriate,
- whether stdio is the correct wrapper transport.

Do not assume that global configuration changes are acceptable just because they are technically easy.

### C. Claude Code / Claude in Chrome topology

Inspect the local topology of the existing setup.

At minimum, attempt to confirm:

- whether the browser extension is installed and, if practical, whether it appears active,
- whether the native messaging host configuration file exists,
- what host binary or command that configuration points to,
- what relevant Claude Code processes are running,
- whether any sockets, pipes, or local bridge artifacts appear when the browser integration is active,
- whether those artifacts exist independently of an actively speaking Claude Code session.

Do not guess the path. Read the manifest and inspect the runtime.

### D. Coupling analysis

Determine exactly what depends on what.

Questions to answer include:

- Is there a reusable local bridge independent of Claude Code’s conversation state?
- Is the effective path Chrome extension -> native host -> local IPC, or something more indirect?
- Does the usable runtime disappear when Claude Code exits?
- Is the browser side reconnectable in a deterministic way?
- Is the wrapper concept really “consume an existing bridge”, or is it actually “proxy through a live Claude Code process”? Those are not the same thing.

### E. Stability and operational risk

Investigate the practical failure modes.

At minimum, consider:

- idle timeout behavior,
- extension service worker sleep or disconnect,
- race conditions on browser startup,
- modal dialog blocking behavior,
- conflicts if multiple agent sessions touch the same channel,
- whether the downstream path can recover automatically.

Document not only the risk, but also whether that risk can be mitigated in code.

### F. Alternatives benchmark

Before committing to the wrapper path, benchmark it mentally against at least one alternative.

Examples include:

- a browser MCP that does not depend on Claude in Chrome,
- a Playwright-driven or Chrome DevTools-driven path,
- a different architecture that achieves the same user value with fewer brittle dependencies.

This does not mean replacing the original goal too early. It means being honest about opportunity cost.

## Mandatory Investigation Outputs

By the end of investigation, `.agent/Investigation.md` must clearly answer the following in plain language.

1. What is actually installed and running on this machine?
2. What exact local artifacts suggest a reusable browser bridge?
3. What parts are confirmed versus inferred?
4. Does the promising path depend on live Claude Code session state?
5. What are the likely breakpoints?
6. What verdict do you assign: GREEN, YELLOW, or RED?
7. What is the best next move?

If a human read only that file, they should understand the situation.

## Implementation Eligibility Rules

Implementation is allowed only after the investigation verdict is recorded.

- GREEN -> proceed to proof-of-life wrapper, then potentially broader implementation.
- YELLOW -> proceed only to proof-of-life wrapper.
- RED -> no wrapper implementation.

If you are on the border between GREEN and YELLOW, choose YELLOW.

## Preferred Technical Architecture

If implementation is justified, the preferred architecture is:

`Codex -> wrapper MCP -> adapter layer -> discovered local bridge or host path -> existing browser integration`

Keep the wrapper and adapter separate.

The wrapper layer should speak MCP cleanly and expose a stable tool contract.

The adapter layer should absorb the ugly specifics of the downstream integration, whether that means process spawning, stdio exchange, socket access, retries, or protocol normalization.

Do not let undocumented downstream details leak all over the codebase.

## Preferred Initial Tool Surface

If you build a proof-of-life wrapper, start with the smallest useful interface.

### Milestone 1 tools

- `browser_health`
- `browser_snapshot`
- `browser_open_or_focus`

These three are enough to prove that:

- the wrapper can start and connect,
- the wrapper can observe the browser state in a structured way,
- the wrapper can cause a small, visible browser action.

### Milestone 2 tools

Only after Milestone 1 is demonstrably stable:

- `browser_click`
- `browser_type`

### Milestone 3 tools

Only if the architecture still looks healthy:

- `browser_upload`
- `browser_extract`
- any higher-level helpers that are justified by real usage patterns

Do not begin with arbitrary JavaScript execution or a huge kitchen-sink tool list.

## Implementation Constraints

If you implement, obey the following.

### Keep dependencies light

Prefer the runtime already best supported by the local environment.

Choose the implementation language based on:

- ease of interacting with the discovered host or IPC path,
- debuggability,
- low dependency count,
- ease of writing smoke tests,
- maintainability for future edits.

Do not install a large framework unless it clearly buys something important.

### Make failure visible

Include:

- startup timeout,
- per-tool timeout,
- reconnect logic where feasible,
- structured error responses,
- debug logging that can be enabled without editing code,
- clear messages when the downstream browser bridge is unavailable.

### Keep unsafe operations behind gates

Do not immediately modify global Codex config.

Prefer this order:

1. local wrapper executable exists,
2. local manual smoke test exists,
3. project-scoped integration exists if appropriate,
4. global user config is touched only if still justified.

If you modify a global config, create a timestamped backup first and document exactly what changed.

### Do not depend on magic startup order

If the wrapper only works when processes are started in a particular order, document that as a defect or risk, not as invisible tribal knowledge.

## Validation Rules

At every milestone, validate before continuing.

Validation does not have to be fancy, but it must be real.

For investigation milestones, validation means the docs contain concrete commands, paths, and observations.

For proof-of-life milestones, validation should include:

- launching the wrapper locally,
- exercising the minimal tools,
- recording outputs or visible browser effects,
- documenting failures and repairs.

For broader implementation milestones, add appropriate unit or smoke tests if the chosen runtime and architecture support them sensibly.

If a validation fails, repair the failure before expanding scope.

## Documentation Discipline

Treat the markdown documents as durable project memory.

After each meaningful milestone or discovery:

- update `.agent/Documentation.md`,
- update `.agent/Plan.md` if the plan changed,
- update `.agent/Investigation.md` if new facts were discovered,
- record design choices in a decision log,
- record surprises, not just successes.

A good test is this:

Could another agent open the repo later, read the markdown files, and continue without needing the original chat transcript? If not, the docs are not good enough.

## Decision Log Expectations

When you make a meaningful choice, record:

- what options were considered,
- what evidence supported the choice,
- what tradeoff was accepted,
- whether the choice is provisional or final.

Useful decisions to log include:

- choosing stdio over another transport,
- choosing a language runtime,
- deciding whether the path is GREEN or YELLOW,
- deciding whether to depend on a live Claude Code process,
- deciding to stop and recommend an alternative.

## What to Do if the Path Is Brittle but Interesting

That is a YELLOW path.

In that case, the goal is not polish. The goal is a proof-of-life that teaches us something real.

A YELLOW proof-of-life should:

- prove the mechanism with the smallest surface,
- keep code isolated,
- document the brittle assumption explicitly,
- avoid global integration by default,
- make teardown and abandonment easy.

Do not quietly let a YELLOW path become a pseudo-production tool.

## What to Do if the Path Is Not Worth It

That is a RED path.

In that case:

- stop implementation,
- document the decisive reasons,
- propose the cleanest alternative architecture,
- explain why the alternative is better,
- keep the repo in a tidy state.

A clean “no” with excellent reasoning is a successful outcome.

## Suggested File/Directory Shape If You Implement

Use this only if it fits the chosen runtime and repository context.

- `AGENTS.md`
- `.agent/Investigation.md`
- `.agent/Plan.md`
- `.agent/Documentation.md`
- `.agent/Implement.md`
- `wrapper/` or `src/` for the MCP server and adapter
- `tests/` or equivalent for smoke checks if appropriate
- `README.md` for local operation and usage

If you choose a different layout, explain why.

## Content Requirements for `README.md`

If code is produced, the README must include:

- what this wrapper is and is not,
- the downstream dependency model,
- prerequisites,
- how to run it locally,
- how to test the proof-of-life,
- known limitations,
- failure and reconnect notes,
- a sample Codex configuration snippet if integration is justified,
- how to remove or disable it.

## Content Requirements for the Final Integration Step

If you reach the stage where Codex should actually use the wrapper MCP, provide a clearly marked configuration snippet rather than immediately editing global config without explanation.

If you do decide a config edit is justified, document:

- the original file location,
- the backup location,
- the exact diff,
- how to revert it.

Prefer project-scoped configuration when it is sufficient.

## Rules for Asking the Human

Do not keep asking for reassurance.

Only ask the human when one of these is true:

- a required permission cannot be obtained otherwise,
- a destructive or global change is about to be made,
- two viable paths have materially different tradeoffs and the choice is product-level rather than technical,
- a required local fact cannot be observed and only the human can supply it.

When you do ask, ask one precise question, not a vague bundle of questions.

## Preferred Working Style

Be calm, skeptical, and explicit.

Prefer plain statements like:

- “Confirmed: the manifest points to X.”
- “Inferred: process Y likely opens socket Z, but this is not yet proven.”
- “Risk: this path appears to require a live Claude Code session.”
- “Decision: classify as YELLOW and limit work to proof-of-life.”

Avoid both hype and defeatism.

## Suggested Kickoff Prompt for the Human

If the human starts a fresh Codex run, the following prompt is a good entry point:

“Read AGENTS.md completely and follow it strictly. Start with investigation only. Create the required files under .agent/. Produce a feasibility verdict for a wrapper MCP that may reuse the local Claude Code + Claude in Chrome environment. If the verdict is GREEN, continue into a minimal proof-of-life implementation. If the verdict is YELLOW, continue only into a proof-of-life. If the verdict is RED, stop and recommend the cleanest alternative.”

## Final Reminder

The true deliverable is not “some code.”

The true deliverable is one of these three outcomes:

- a well-evidenced GREEN path with a working proof-of-life and perhaps a usable wrapper,
- a well-evidenced YELLOW path with a contained prototype and explicit caveats,
- a well-evidenced RED path with a clean recommendation not to proceed.

All three are valid. What is not valid is skipping the hard thinking and writing code first.
