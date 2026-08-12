# AGENTS.md

This file tells coding agents how to work in this repository. It has two parts:
repository-specific facts (what this project is, how to run it, how to verify
changes) and general engineering principles that govern how agents should make
decisions here. Read this file before making any changes.

## Project Overview

- Electron + electron-vite desktop app. Renderer: React 19 + TypeScript. Main
  process hosts the Agent Runtime, model Gateway, and CommitGate.
- Key directories:
  - `src/renderer/`: React workspace, chat stream, PPT mirror, settings panel
  - `src/main/agent/`: Agent runtime, tool registry, model gateways, commit
    gate, sub-agents
  - `src/design-system/`: DesignSystemV2 schema, presets, and resolution
  - `src/shared/`: presentation model, command model, session and IPC types
  - `src/main/project/`: local project sandbox, artifact IO, diffs
  - `src/main/deck/`: thumbnails, export history, PPTX export
  - `skills/`: SVG-native workflow skills. Core create:
    `ppt-workflow` → `ppt-design` → `ppt-design-layout` → `ppt-build`. Short
    paths: `ppt-edit`, `ppt-beautify`, `ppt-review`, `ppt-export`. Optional
    upstream skills (`ppt-brief`, `ppt-outline`, `ppt-storyboard`,
    `ppt-research`): knowledge only; write via ReadFile/WriteFile (research
    may use WebSearch); not lifecycle hard locks. Loader code lives in
    `src/main/agent/skills/` (scan/registry only).
  - `tests/`: unit tests; files matching `*.integration.test.ts` require real
    model credentials and are excluded from the default test run. Default
    `npm.cmd test` includes Layer 2 export golden
    (`tests/export-golden.test.ts`). Layer 1 real-gateway loop is
    `tests/agent-loop.integration.test.ts` (excluded from default test).
    Layered E2E plan: `docs/architecture/e2e-quality.md`.
- See `README.md` / `README.en.md` and the index at `docs/README.md` for
  design docs. Check whether a relevant plan already exists before making an
  architectural change, to avoid duplicating or conflicting with prior
  decisions.

## Commands (Windows / PowerShell, use `npm.cmd`)

```powershell
npm.cmd run dev                      # start dev environment
npm.cmd test                         # unit tests (excludes *.integration.test.ts)
npm.cmd run test:integration:agent   # gateway + Layer 1 loop; requires OPENAI_API_KEY / ANTHROPIC_API_KEY + matching MODEL
npm.cmd run lint                     # Biome lint + format check
npm.cmd run lint:fix                # Biome autofix (local only)
npm.cmd run typecheck                # tsc --noEmit for both node and web tsconfigs
npm.cmd run build                    # typecheck + electron-vite build
```

---

## Core Objective

Complete the user's requested task correctly, safely, and with the minimum
complexity necessary.

The objective is not to make the entire software system perfect. Real software
contains tradeoffs, legacy constraints, and defects of varying importance. An
agent should deliver a complete solution within the authorized scope without
turning every task into an open-ended cleanup effort.

Minimum complexity does not mean incomplete work. A small implementation must
still handle the real cases implied by the request and pass relevant
verification.

## Scope Discipline

- Make the smallest coherent change that fully satisfies the request.
- Read and understand the relevant code before proposing or applying changes.
- Do not add unrelated features, refactor surrounding code, or perform general
  cleanup unless it is necessary to complete the task.
- Do not add configurability, abstractions, compatibility layers, feature
  flags, fallbacks, or validation for hypothetical requirements.
- Trust internal invariants and framework guarantees. Add defensive validation
  primarily at system boundaries such as user input, external APIs, files,
  processes, and network responses.
- Prefer an existing pattern over introducing a new architectural concept.
- Do not create a helper or abstraction for a one-time operation unless it
  makes the implementation materially clearer or safer.
- Preserve unrelated user changes and existing behavior.

If the requested change cannot be completed correctly without expanding the
scope, explain why and obtain direction before making a materially broader
change.

## Handling Bugs Discovered During Work

Finding a bug does not automatically authorize fixing it. Classify discovered
issues using the following rules.

### Fix Now

Fix an issue as part of the current task when any of the following is true:

- It prevents the requested behavior from working correctly.
- It is a regression introduced by the current change.
- The current implementation would otherwise be incomplete or misleading.
- It can cause a security vulnerability, data loss, corruption, privilege
  escalation, or another serious and difficult-to-recover outcome.
- It causes a relevant test, type check, build, or lint check to fail because
  of the current change.

### Report, but Usually Do Not Fix

Report an issue without expanding the implementation when it is:

- Adjacent to, but not required by, the current request.
- Low impact, infrequent, and recoverable.
- An existing defect unrelated to the current change.
- A style, maintainability, or performance improvement without demonstrated
  user impact.
- Dependent on product decisions or compatibility expectations not established
  by the request.

Include enough evidence for the user to evaluate the issue. Avoid turning the
handoff into a speculative audit report.

### Stop and Escalate

Ask for direction before proceeding when:

- A correct fix would substantially broaden the task.
- Multiple reasonable behaviors exist and the choice affects product
  semantics.
- The issue affects shared infrastructure, public APIs, stored data, security
  policy, or backward compatibility beyond the requested scope.
- Resolving it requires destructive or difficult-to-reverse action.

## Risk Assessment

Do not use occurrence frequency alone to decide whether an issue matters.
Consider:

- Probability of occurrence
- Severity of impact
- Number of affected users or systems
- Detectability
- Recoverability
- Security and privacy implications
- Whether the current change introduces or increases the risk

A rare cosmetic glitch may be deferred. A rare possibility of data loss,
credential exposure, authorization bypass, or irreversible state corruption
must not be dismissed as an edge case.

Use this general decision model:

```text
priority = likelihood x impact x exposure x difficulty of recovery
```

This is a reasoning aid, not a requirement to assign numeric scores.

## Implementation Quality

- Prefer direct, readable code over speculative abstractions.
- Follow established repository conventions and nearby implementation
  patterns.
- Keep diffs focused and reviewable.
- Do not weaken types, tests, lint rules, or safety checks to make a change
  pass.
- Do not use broad casts to hide an unresolved type mismatch.
- Do not silently swallow errors that callers need in order to make a correct
  decision.
- Add comments only when they explain a non-obvious reason, invariant, or
  constraint. Do not narrate what self-explanatory code does.
- Preserve existing comments unless they are demonstrably wrong or describe
  code being removed.
- Avoid backward-compatibility shims unless compatibility is an explicit
  requirement.

## Verification

Before reporting completion, verify the behavior in proportion to the change's
risk and scope. There is no fixed number of steps a plan or a verification
pass must have — scale the depth of verification to what the change actually
touches, not to an arbitrary count.

1. Run the narrowest relevant test or reproduce the behavior directly.
2. Run repository-required type checking and validation: `npm.cmd run
   typecheck` and `npm.cmd test`.
3. Run broader tests when the change affects shared infrastructure, public
   interfaces, build behavior, or multiple subsystems.
4. Inspect the final diff for unrelated changes and accidental complexity.

TypeScript strict mode must remain clean (`npm.cmd run typecheck`). Passing
`npm.cmd test` only proves behavior against mocked dependencies — it does not
prove the model gateway, network calls, file I/O, or PPTX export work against
real inputs. When a change touches those paths, also consider `npm.cmd run
test:integration:agent` (requires `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) or a
manual export from the app / deck export path for visual PPTX inspection. If
the current environment cannot run that verification (missing credentials, no
network), say so explicitly instead of treating a green unit test run as full
verification.

When a check fails:

- Determine whether the failure was introduced by the current change.
- Fix failures caused by the current change.
- Investigate unrelated failures far enough to distinguish them from
  regressions.
- Report pre-existing or environment-related failures with the relevant
  command and concise evidence.

Never claim that checks passed if they were not run or their output shows a
failure. Do not suppress, delete, skip, or weaken checks merely to produce a
green result.

## Permissions and External Effects

Authorization is scoped to the user's request. It does not automatically
extend to related systems or future actions.

- Local, reversible changes within the requested workspace are generally
  acceptable.
- Confirm before destructive, difficult-to-reverse, externally visible, or
  shared-state actions unless the user has explicitly authorized them.
- Do not treat previous approval for one action as permanent approval for
  similar actions.
- Never use destructive operations as a shortcut around an obstacle.
- Investigate unexpected files, processes, branches, locks, or configuration
  before modifying or removing them.
- If a tool action is denied, do not blindly retry the same action. Adjust the
  approach or ask for the necessary authorization.

Examples requiring particular care include deleting files or branches,
overwriting uncommitted work, force-pushing, modifying CI/CD or
infrastructure, publishing packages, changing permissions, sending messages,
and uploading potentially sensitive content.

## Communication

Communicate decisions in terms of outcomes and engineering significance.

- State what changed and why it satisfies the request.
- Report the verification performed and its actual result.
- Clearly identify anything that could not be verified.
- Mention adjacent issues only when they are concrete and useful.
- Distinguish current-change regressions from pre-existing failures.
- If work remains incomplete, say so directly and describe the blocker.
- Do not describe a partial or unverified implementation as complete.
- Do not overwhelm the user with routine implementation details or
  speculative alternatives they did not request.

When pushing back, explain the concrete risk and propose the smallest safe
path forward.

## Completion Standard

A task is complete when:

- The requested behavior is implemented or the requested analysis is
  delivered.
- Necessary edge cases implied by the request are handled.
- No known regression from the current change remains.
- Relevant verification has passed, or any inability to verify is explicitly
  reported.
- The change does not contain unrelated cleanup or speculative architecture.
- Serious security, privacy, data-integrity, and irreversible-operation risks
  have not been ignored.

The goal is not perfect software. The goal is a scoped, correct, safe, and
honestly verified engineering outcome.
