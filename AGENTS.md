# AGENTS.md

# Project: Codex Chrome Bridge

## Purpose

This repository exists to answer one concrete question first, and only then decide whether development should continue.

The question is:

**Can Codex realistically, maintainably, and with acceptable brittleness, reuse the existing local Claude Code + Claude in Chrome environment through a wrapper MCP?**

This is not a generic browser-agent project.
This is not a request to "make browser automation work somehow."
This is a focused investigation into whether an already-working local path can be reused by Codex in a disciplined way.

The first priority is truth.
The second priority is discipline.
The third priority is code.

If the root idea is weak, too coupled, too undocumented, too fragile, or too operationally annoying, **stop early and say so clearly.**

---

## Core Outcome Hierarchy

Rank outcomes in this order:

1. **Best outcome:** prove the path is viable and continue into implementation.
2. **Good outcome:** prove the path is too brittle or not worth it, and stop with high-quality documentation.
3. **Bad outcome:** produce code without first establishing whether the core idea is sound.

A clean, well-supported "no" is a successful result.
Do not force implementation just to create artifacts.

---

## What This Project Is Actually About

The intended target is narrow:

- there is already a local Claude Code + Claude in Chrome setup on this machine,
- that setup may expose some local bridge, process, host, socket, pipe, or other runtime artifact,
- the goal is to determine whether Codex can reuse that same environment through a wrapper MCP,
- the wrapper should present a small, stable surface to Codex,
- the design should avoid hidden manual babysitting.

The goal is **not** to replace the original concept with a different browser automation stack unless the original idea is shown to be weak.

---

## Non-Goals

Do **not** silently drift into any of these:

- building a generic browser framework when the real question is narrower,
- replacing the existing local Chrome / CiC path too early,
- proxying through a live Claude Code session without explicitly labeling that as coupling,
- modifying the user's working Claude Code / Chrome / extension setup just to make the experiment easier,
- touching global settings early because it is convenient,
- shipping something that only works once under mysterious conditions,
- expanding the tool surface before the lower layer is proven.

---

## Ground Rules

### 1. Investigation comes first

You must begin with investigation and planning.
You must **not** begin with implementation.
You must **not** create wrapper source code before the investigation verdict is documented.

### 2. Local evidence beats assumptions

Treat prior knowledge, blog posts, guesses, and community lore as hypotheses.
Prefer what is actually observable on this machine:

- files,
- manifests,
- running processes,
- logs,
- sockets,
- pipes,
- CLI behavior,
- visible runtime artifacts.

### 3. Confirmed vs inferred must be explicit

Always distinguish clearly between:

- confirmed facts,
- reasonable inferences,
- guesses,
- undocumented private behavior,
- reverse-engineered assumptions.

Never blur them together.

### 4. Preserve the existing working environment

Do not casually modify:

- Chrome profile state,
- extension permissions,
- Claude Code configuration,
- native messaging host configuration,
- shell startup files,
- `~/.codex/config.toml`,
- global user settings.

These are late-stage integration surfaces, not early-stage experimentation tools.

### 5. Stop early if the root idea is weak

Be conservative.
Try to kill the idea early if the real local topology does not support it cleanly.
Do not become attached to implementation.

### 6. GREEN is the only automatic implementation gate

Only **GREEN** allows automatic transition into implementation.
If the verdict is **YELLOW** or **RED**, stop after documentation and recommendation.
Do not implement automatically on YELLOW.

---

## How to Start

At the beginning of the run, do the following in order:

1. Read this entire file carefully.
2. Create the `.agent/` documentation working set described below.
3. Produce an investigation-first plan.
4. Begin local evidence gathering.
5. Record findings continuously.
6. Do not write implementation code until the investigation verdict exists.

---

## Required Documentation Working Set

Create and maintain these files under `.agent/` unless a clearly better equivalent already exists.

### `.agent/Investigation.md`

This is the factual record.

It must contain:

- Executive summary
- Environment snapshot
- Codex-side facts
- Claude Code facts
- Claude in Chrome facts
- Local runtime topology actually observed
- Coupling analysis
- Stability and operational risks
- Feasibility verdict: **GREEN / YELLOW / RED**
- Recommended next move
- Appendix of commands run and notable outputs

This file must be readable by a human who did not watch the session.

### `.agent/Plan.md`

This is the milestone plan.

It must contain:

- Objective
- Scope
- Non-scope
- Milestones
- Acceptance criteria per milestone
- Validation method per milestone
- Stop rules
- Decision rules that prevent oscillation

### `.agent/Documentation.md`

This is the running work log.

It must contain:

- Current phase
- Completed work
- Current understanding
- Next action
- Decisions made and why
- Discoveries and surprises
- Known issues
- How to reproduce the current state

### `.agent/Implement.md`

**Create this only after a GREEN verdict.**

This is the implementation runbook.

It must contain:

- implementation milestones,
- validation after each milestone,
- documentation update requirements,
- rollback / backup notes if any global integration ever becomes necessary,
- stop conditions for implementation.

If the verdict is not GREEN, do not create this file.

---

## Mandatory First Deliverable

Before any code is written, produce a solid investigation package.

The investigation must answer these questions plainly:

1. What relevant tools and runtimes are actually installed on this machine?
2. What exact local artifacts suggest a reusable browser bridge exists?
3. What parts are confirmed versus inferred?
4. Does the promising path depend on a live Claude Code session?
5. Is the effective model truly `Codex -> wrapper -> reusable local bridge`, or is it secretly `Codex -> wrapper -> Claude Code session proxy`?
6. What are the likely breakpoints and operational annoyances?
7. Is the result GREEN, YELLOW, or RED?
8. What is the cleanest next move?

If those questions are not answered clearly, the investigation is incomplete.

---

## Mandatory Investigation Scope

No implementation work is allowed until this scope is covered adequately.

### A. Environment baseline

Establish a factual baseline.
Confirm and record at least:

- operating system,
- shell/runtime environment,
- repository root,
- existing guidance files in the repo,
- presence and versions of Codex and Claude Code binaries,
- available implementation runtimes,
- whether Chrome or other relevant browsers are currently running.

### B. Codex-side surface

Determine what Codex can and should consume.
At minimum, record:

- whether Codex MCP configuration already exists,
- whether project-scoped vs user-scoped configuration is more appropriate,
- whether a local stdio wrapper is the right target,
- what sandbox / approval posture appears active or appropriate,
- what integration path should be preferred if implementation later becomes justified.

### C. Claude Code / Claude in Chrome topology

Inspect the actual local topology of the existing setup.
Try to confirm:

- whether the browser extension is installed,
- whether relevant browser integration artifacts appear active,
- whether a native messaging host configuration exists,
- what host binary / command that configuration points to,
- what related processes are running,
- whether sockets, pipes, or other local artifacts appear,
- whether those artifacts exist only while certain processes are alive.

Do not guess paths.
Read the actual files and inspect the actual runtime.

### D. Coupling analysis

Determine exactly what depends on what.
Questions to answer include:

- Is there a reusable local bridge independent of Claude Code conversation state?
- Does the path disappear when Claude Code exits?
- Is the path stable only when a session remains alive?
- Is the bridge reusable, or is the real model just piggybacking on Claude Code's live process?
- Could a wrapper cleanly consume the lower layer without inheriting too much hidden complexity?

### E. Stability and operational risk

Investigate likely practical failure modes.
Consider at minimum:

- idle timeout behavior,
- extension service worker sleep or disconnect,
- startup ordering sensitivity,
- reconnect determinism,
- hidden manual choreography,
- modal / dialog interference,
- multi-session conflicts,
- observability quality,
- whether recovery can be coded cleanly.

Document not just risks, but whether each risk is likely manageable.

### F. Alternative benchmark

Before recommending implementation, benchmark the wrapper concept against at least one cleaner alternative.
Examples might include:

- a browser MCP unrelated to Claude in Chrome,
- a Chrome DevTools or Playwright path,
- a different architecture that achieves the same user value with fewer brittle dependencies.

This does **not** mean pivoting too early.
It means being honest about whether the original path is actually the best one.

---

## Feasibility Gate

You must classify the result of the investigation using one of these three verdicts.

### GREEN

Choose GREEN only if most of the following are substantially true:

- a reusable local bridge or host path is demonstrably real on this machine,
- it can likely be consumed without unacceptable manual choreography,
- the likely failure modes are understandable,
- the path appears maintainable enough for a local wrapper,
- the implementation scope can stay small,
- the architecture is not secretly dependent on a fragile live Claude Code session in a way that defeats the point.

**If the verdict is GREEN:**

- create `.agent/Implement.md`,
- proceed automatically to a minimal proof-of-life wrapper,
- continue cautiously milestone by milestone,
- validate after each milestone,
- keep documentation updated.

### YELLOW

Choose YELLOW if the idea appears technically possible but carries meaningful brittleness, such as:

- dependence on undocumented runtime behavior,
- dependence on a live Claude Code session,
- weak reconnect behavior,
- fragile process timing assumptions,
- poor observability,
- hidden manual choreography,
- unclear maintainability.

**If the verdict is YELLOW:**

- stop after documentation,
- do **not** implement automatically,
- explain the decisive brittleness clearly,
- recommend the smallest sensible next experiment only as an option,
- recommend the cleanest alternative architecture if appropriate.

### RED

Choose RED if one or more of these are true:

- no reusable local bridge can be confirmed,
- the path requires risky or invasive changes,
- the result would be too brittle to justify maintaining,
- the design is inferior enough to cleaner alternatives that it should not be pursued,
- the real mechanism is too private / opaque / coupled to trust.

**If the verdict is RED:**

- stop after documentation,
- do not implement,
- explain the decisive blockers plainly,
- recommend the cleanest alternative.

### Tie-break rule

If the verdict feels borderline between GREEN and YELLOW, choose **YELLOW**.

Conservatism is preferred.

---

## Implementation Eligibility Rules

Implementation is allowed only after the investigation verdict is written into `.agent/Investigation.md`.

- **GREEN** -> implementation may begin automatically.
- **YELLOW** -> no automatic implementation.
- **RED** -> no implementation.

There is no exception to this rule.

---

## Preferred Architecture If GREEN

If implementation becomes justified, prefer this shape:

`Codex -> wrapper MCP -> adapter layer -> discovered local bridge / host path -> existing browser integration`

Keep the wrapper and the adapter conceptually separate.

- The **wrapper** should speak MCP cleanly and expose a stable tool contract.
- The **adapter** should absorb ugly downstream specifics such as stdio, socket access, retries, process spawning, timeouts, or protocol normalization.

Do not let downstream undocumented details leak everywhere.

---

## Preferred First Implementation Scope If GREEN

If and only if GREEN is earned, start with the smallest useful proof-of-life.

### Milestone 1 tool surface

- `browser_health`
- `browser_snapshot`
- `browser_open_or_focus`

These are enough to prove:

- the wrapper starts,
- the wrapper can connect or detect readiness,
- the wrapper can observe browser state,
- the wrapper can cause a small visible action.

### Milestone 2 tool surface

Only after Milestone 1 is stable:

- `browser_click`
- `browser_type`

### Milestone 3 tool surface

Only if the architecture still looks healthy:

- `browser_upload`
- `browser_extract`
- justified higher-level helpers

Do not start with arbitrary JS execution or a giant kitchen-sink tool list.

---

## Implementation Constraints If GREEN

### Keep dependencies light

Prefer the language/runtime that fits the discovered host path best and keeps the code easy to debug.
Consider:

- low dependency count,
- ease of local smoke testing,
- maintainability,
- ease of interacting with discovered IPC or host processes,
- good logging and timeout handling.

### Make failure visible

Include at minimum:

- startup timeout,
- per-tool timeout,
- reconnect logic where realistic,
- structured errors,
- debug logging,
- clear user-visible failure reasons.

### Avoid early global integration

Prefer this order:

1. local wrapper exists,
2. local manual smoke test exists,
3. project-scoped integration exists if justified,
4. global user config is touched only if still necessary and clearly worth it.

If any global config must later be changed, back it up first and document the exact change.

### No magic startup order

If the design depends on a specific process order, timing trick, or hidden warm-up, document that as a defect or risk.
Do not encode tribal knowledge invisibly.

---

## Validation Rules

Validation is mandatory at every milestone.

For investigation milestones, validation means the markdown files contain:

- commands run,
- files inspected,
- paths found,
- outputs observed,
- reasoning for the verdict.

For implementation milestones, validation should include:

- local launch,
- exercising the minimal tool surface,
- recording outputs or visible effects,
- documenting failures and repairs,
- confirming the docs still reflect reality.

If validation fails, repair or stop before expanding scope.

---

## Documentation Discipline

Treat markdown files as durable project memory.

After each meaningful discovery or milestone:

- update `.agent/Documentation.md`,
- update `.agent/Plan.md` if the plan changed,
- update `.agent/Investigation.md` if new facts were learned,
- update `.agent/Implement.md` if GREEN implementation is underway.

A good test is this:

**Could another capable agent open this repo later, read the markdown files, and continue without the original conversation?**

If not, the documentation is not good enough.

---

## Decision Log Expectations

When making a meaningful choice, record:

- options considered,
- evidence supporting the choice,
- tradeoff accepted,
- whether the choice is provisional or final.

Especially record decisions about:

- verdict selection,
- whether the path depends on live Claude Code state,
- whether a local bridge is genuinely reusable,
- whether stdio is the right wrapper transport,
- whether the project should stop.

---

## What to Do If the Path Is Interesting but Brittle

That is YELLOW.

On YELLOW:

- do not implement automatically,
- do not polish,
- do not quietly turn a brittle idea into a pseudo-product,
- document the brittle assumptions,
- propose the smallest rational next experiment only as an option,
- explain the better alternative if one exists.

---

## What to Do If the Path Is Not Worth It

That is RED.

On RED:

- stop implementation,
- leave the repository tidy,
- document the decisive blockers,
- recommend the cleanest alternative,
- explain why that alternative is better.

A high-quality negative conclusion is a success.

---

## Operator Kickoff Prompt

When the operator starts Codex for this repository, the recommended first instruction is:

```text
Read AGENTS.md fully and obey it strictly.

Start with investigation only.
Do not write implementation code, create wrapper source files, or modify Codex/Claude/Chrome configuration until the investigation is complete and the feasibility verdict is written down.

Create and maintain:
- .agent/Investigation.md
- .agent/Plan.md
- .agent/Documentation.md

Be conservative and try to kill the idea early if the root concept is weak.

Your first job is to determine whether Codex can realistically and maintainably reuse the existing local Claude Code + Claude in Chrome environment through a wrapper MCP.

Rules:
- Prefer local evidence over assumptions.
- Distinguish confirmed facts from inferences.
- Do not force a prototype just to produce code.
- Proceed automatically into implementation only if the verdict is GREEN.
- If the verdict is YELLOW or RED, stop after documentation, explain the decisive blockers or brittleness, and recommend the cleanest alternative.
- Create .agent/Implement.md only if the verdict is GREEN.

Use a plan-first approach before coding.
```
