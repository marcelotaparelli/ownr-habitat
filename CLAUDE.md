# OWNR Habitat — control plane

OWNR Habitat is a closed-loop software evolution environment. *Humans define the mission and constraints. Mutation engines propose candidate changes. OWNR independently executes, observes, evaluates and selects them until the software approaches its desired measurable state without leaving its engineering envelope.* **Agents generate change. OWNR decides what survives.**

This repository is the **control plane** only. The software being evolved (an **organism**) lives in its own git repository and is referenced by configuration (`Organism { repositoryPath, baselineRef, allowedPaths }`). The first organism is OWNR Replay (`../ownr-replay`), wired by the adapter in `src/replay/`; the core (`src/*.ts`) never names Replay.

```text
OWNR Habitat (this repo)                      Organism repo (e.g. ownr-replay)
Mission · Envelope · Evaluators · Selector    code, tests, instruments (scripts/measure.ts)
Recorder · MutationProvider · Cockpit    ──►  baseline = rev-parse <baselineRef>
         controls / observes                  candidates = worktrees + refs/habitat/candidates/*
```

## Habitat rules (non-negotiable)
- The software is the evolving object: Mission, Desired State, Fitness, Envelope, Candidate lineage and independent evaluation are first-class. Agents are only one source of candidates (human, LLM, rule, search…); Habitat is not an agent orchestrator.
- Loop: observe → analyze → propose → mutate (isolated candidate) → execute → evaluate → select → accept/reject → observe. Never observe → change production.
- **The agent that writes a change never decides whether it passed**: its claims are stored as information, never as evidence; evaluators re-execute independently.
- **Control plane vs organism**: two independent repositories. Changing Habitat never changes an organism baseline; candidates are worktrees of the organism repo and cannot reach Habitat files. Within the organism, candidates may only touch its allowed paths (HARD path policy, checked before anything runs), so the organism instruments that evaluators execute (tests, typecheck, `scripts/measure.ts`) are protected too. Mission, envelope, selection rules, recorder and proposals live here.
- **Isolation**: organism commands run in the `linux-sandbox` runner by default (namespaces: no network, private PID/mount/IPC/UTS/cgroup; pivot_root into a minimal read-only root with only `/usr`, the bun binary and the dependencies read-only, the checkout as the only writable `/work`, private `/tmp`; cgroup v2 memory/PID/CPU limits; timeout kills the whole cgroup; user nobody, no capabilities, no_new_privs; allowlisted environment only). `trusted-local` exists only as an explicit opt-in (`HABITAT_RUNNER=trusted-local`); Habitat never falls back to it silently.
- **Execution provenance**: evidence is also bound to the hash of its execution environment — runtime as reported inside the runner (bun version/revision), runner identity (kind + derived version + limits), lockfile content at the evaluated revision, installed dependency tree and tool versions (typescript) — and records the commands executed. A different environment makes evidence STALE and baseline observations unusable.
- **Evidence trust** (`Mission.evidence`): raw telemetry is not outcome evidence. Every Mission metric has exactly one trusted source; the same metric from any other evaluator or organism output is ignored (and reported). Each source declares its instrument (the organism files that implement the measurement); values are comparable only while the instrument is byte-identical on both sides, otherwise the comparison is `untrusted`. Instruments must lie outside the candidates' allowed paths (Habitat refuses to start otherwise). Candidates are never measured by telemetry; raw events are schema-validated and rejected rows counted; the telemetry window starts when a baseline was accepted.
- **Evidence binding**: every evaluation is bound to the organism baseline SHA, the evaluated SHA, mission revision + hash, envelope hash, execution environment and the evaluator fingerprint. The fingerprint is **derived**, never declared: a hash of the evaluator's implementation files plus a hash of its configuration (argv, timeouts, parser, parameters). If any of them changes, evidence becomes STALE and must be re-evaluated; legacy/unbound evidence is always STALE. Habitat's own revision is not part of the binding.
- **Verdicts** (no single fitness score; the metric vector and its trade-offs stay explicit): HARD FAIL/NOT_RUN or unmeasured protected metric ⇒ INELIGIBLE · stale evidence ⇒ STALE · broken protected metric, or objectives only worse ⇒ REGRESSED · better and worse at once ⇒ TRADEOFF · nothing better ⇒ NEUTRAL · proxies better ⇒ EXPERIMENT_READY (envelope fully green) or PROXY_IMPROVED (SOFT warnings or unknown proxies) · outcomes better with enough samples ⇒ OUTCOME_IMPROVED / MISSION_MET. **Proxy improvement is never mission improvement**: a candidate judged offline stops at EXPERIMENT_READY; outcomes are only measured in real use of a baseline. SOFT violations are warnings, never a reason to rank a candidate higher.
- Telemetry declares sample size and window; below minimum ⇒ INSUFFICIENT_DATA, and a mission is never "reached" without sufficient evidence. UI distinguishes PASS / FAIL / NOT_RUN / INSUFFICIENT_DATA / STALE — nothing is shown as passing without a check that ran.
- **Acceptance is a human act** (EXPERIMENT_READY ≠ improved ≠ accepted): only current, acceptable evidence; it fast-forwards the organism baseline ref to the candidate's commit (never merge commits, rewrites, push or deploy). The next observation of that baseline judges the experiment. Mission definitions change only through a human revision (revise-mission), which makes older evidence STALE. No self-modification of Habitat. The sandbox shares the host kernel and has no seccomp filter (future: VM/gVisor); trusted-local is NOT a security boundary.
- Not now: auto deploy, swarms, RL/GA frameworks, ML, distributed workers, RBAC, billing, GitHub App, SAST platform, canaries, self-modifying Habitat.

## Product vision (reference for decisions — NOT a build list)
Internal statement: *OWNR is the engineering cockpit for the agentic software era. It helps developers acquire verified technical ownership of unfamiliar code today, and evolves toward an environment where humans direct software agents inside measurable constraints for architecture, security, reliability, performance, testing and observability.* Taglines: "Own the code. Direct the agents." · "From generated code to owned software." Thesis: AI made producing code cheaper; OWNR makes owning software cheaper.

- **Pilot analogy**: the developer sets destination, trajectory and limits and monitors instruments; automation (agents) executes; the human stays responsible — understands, decides, detects anomalies, intervenes. Progressive disclosure: normal → essential, warning → attention, critical → intervention; overview → module → function → line on demand.
- **Engineering flight envelope** (future): agents work inside verifiable constraints — architecture (dependency direction, module boundaries), clean-code signals, tests, security, performance budgets, reliability (timeouts, retries, idempotency), observability as the aircraft's instruments, resource limits. Distinguish HARD constraints (MUST NOT expose secrets) from GUIDELINES (prefer short functions); never become an architectural prison.
- **Deterministic envelope around probabilistic agents**: schemas, types, tests, rules, metrics, limits, sandboxes, human checkpoints. **The agent that implements does not decide it succeeded**: independent verifiers do. **Evidence-driven**: claims come with evidence (p95 = 34 ms, not "fast"; unit ✓ integration ✓, not "works"). **Flight recorder**: goal, agent, context, changes, decisions, checks, approvals — auditability and accountability.
- **Ownership proof ladder**: UNDERSTAND → REBUILD → NAVIGATE (find it in the real system) → CHANGE (a **novel** requirement never seen before, e.g. "tickets with 'data leak' get strong SECURITY evidence" — evidence of transfer, not repetition).
- **Planning is goal-directed**: `plan(repository, goal, existingKnowledge)` → the minimal cognitive route (a route, not a course). Two graphs: a Software Graph (calls, implements, imports, reads, writes…) and a **Knowledge Graph** (what must be understood before X). Future inputs include bugs, issues and PR reviews, not only "learn everything".
- **Real assets**: the pedagogical compiler, knowledge graph, ownership graph, verifiable engineering constraints, evidence graph, learning telemetry. Chat/LLM/RAG are commodities.
- **North Star: Time To Verified Ownership** — not lines generated, prompts, time spent or lessons completed.
- Future autonomy levels (1 agent suggests … 5 routine autonomous maintenance) must remain possible; nothing today should block that path.

**Current priority (in order)**: 1) make Module 1 pedagogically excellent; 2) validate with a real human; 3) convert more modules; 4) test different goals; 5) test external users; 6) only then automate Analyzer/Planner. **Not now**: agent runtime, enterprise policies, SAST platform, Kubernetes, CI platform, complex observability platform, organization management, agent orchestration. Meta-rule: OWNR's own code must demonstrate ownership, simplicity, constraints and evidence.

## Stack
Bun + TypeScript strict, `Bun.serve`, `bun:sqlite`, `bun:test`, Web APIs, HTML + CSS + vanilla TS (bundled with `Bun.build`), Docker only for real isolation. Before adding a dependency: does Bun/TS/the Web Platform already solve it? A dependency must buy complexity reduction, security, reliability, maintainability, performance or interoperability. Runtime deps today: `zod` (boundary validation).

## TypeScript
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. No `any`, no `as unknown as`, no unjustified `!`. Prefer `unknown` + narrowing, discriminated/literal unions, `readonly`, derived types, schemas at the boundary.

## Validation
External data is untrusted: validate at boundaries (HTTP, env, LLM output, GitHub input, DB serialization, sandbox requests, filesystem metadata) with Zod, then pass validated domain data inward. No scattered defensive checks.

## Architecture
Core (`src/*.ts`: domain, selection, evolution, store, ports, evaluators, git workspace, API) knows no organism; organism adapters live in `src/<organism>/`. Abstractions only at real boundaries (MutationProvider, CandidateWorkspace, Evaluator, TelemetrySource). No microservices, queues, Redis, CQRS, event sourcing.

## Code
Explicit names, small functions, early return, linear flow, composition. No "Manager"/"Utils", obscure boolean params, magic numbers/strings, mutable global state. Comments explain *why* / trade-offs, not what.

## Async, security, sandbox
Every external call has a timeout (AbortSignal); think cancellation, cleanup, failure propagation, bounded concurrency (no `Promise.all` over unbounded lists). Least privilege, deny by default, fail safely, limit resources. Consider SSRF, path traversal, command injection (argv only, never shell strings), prompt injection, secret leakage, DoS, XSS. Never send secrets to an LLM. Organism commands run as argv with a minimal environment (no inherited secrets), bounded time and output, in an isolated worktree — which is NOT a security boundary (future: Docker/gVisor).

## HTTP & errors
Validate input, correct status codes, body limits, timeouts, `x-request-id`. Error shape: `{ "error": { "code": "STAGE_NOT_FOUND", "message": "..." } }`. Never leak stack traces, paths or secrets. Never swallow exceptions (`catch {}`): handle, translate or propagate.

## Persistence
SQLite while it fits: transactions, constraints, indexes for real queries, prepared statements.

## Observability
Structured JSON log events (never `console.log("here")`, never tokens/secrets/full source). Metrics only for real questions (request/tutor/sandbox durations, sandbox timeouts/OOM, stage completed/skipped_known).

## Frontend
Tiny bundle (target < 60 KB gzip), no framework/state manager/CSS framework, semantic HTML, keyboard friendly, visible focus, local-first progress for instant feedback.

## Tests & done
`bun:test` for behaviour: domain logic, use cases, boundaries, security-sensitive paths, selection semantics, evidence binding (fixture git repositories, never the real organism). Bugs get a regression test. Done means: works, types correct, errors handled, relevant test exists, no needless complexity. Before claiming done run `bunx tsc --noEmit` and `bun test`; anything not validated is reported as **NOT VERIFIED**.

## Git
Coherent commits. Never push, force-push, destructive reset or deploy without explicit authorization.

## Decision order
security → correctness → simplicity → clarity → testability → performance → proven extensibility.

## Commands
- `HABITAT_RUNNER=sandbox|trusted-local` (default sandbox; needs root, util-linux and cgroup v2 — no Docker available on this host)
- `bun run habitat serve` — Cockpit on http://127.0.0.1:3100 (loopback only)
- `bun run habitat <observe|status|evolve <proposal>|reevaluate <candidate>|accept <candidate> --by <name>|revise-mission --by <name>>`
- `bun test` · `bunx tsc --noEmit`
