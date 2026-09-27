import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { minimalEnv, runCommand } from "../src/command.ts";
import { Mission, type DecisionBinding, type EvaluationResult, type EvidenceContext, type Measurement } from "../src/domain.ts";
import { CommandEvaluator, PathPolicyEvaluator, notRun } from "../src/evaluators.ts";
import { Habitat, HabitatBusyError, HabitatRefusal } from "../src/evolution.ts";
import { GitOrganism, GitWorktreeWorkspace } from "../src/git-workspace.ts";
import type { EvaluationContext, Evaluator, MutationProposal, TelemetrySource } from "../src/ports.ts";
import type { CommandRunner } from "../src/runner.ts";
import { REPLAY_TTVO_MISSION, replayEvaluators, replayOrganism } from "../src/replay/organism.ts";
import { ReplayTelemetrySource } from "../src/replay/telemetry.ts";
import { LinuxSandboxRunner } from "../src/sandbox.ts";
import { decide, missionProgress, missionReached, staleReasons } from "../src/selection.ts";
import { HabitatStore, MissionDriftError } from "../src/store.ts";
import { silentLogger } from "../src/logger.ts";
import { TrustedLocalRunner } from "../src/runner.ts";
import { canonical, deriveVersion } from "../src/identity.ts";

const LOCAL = new TrustedLocalRunner();

// ------------------------------------------------------------------ pure selection

const evaluation = (evaluatorId: string, status: EvaluationResult["status"], metrics: Record<string, number> = {}, extra: Measurement[] = []): EvaluationResult => ({
  evaluatorId,
  status,
  measurements: [...Object.entries(metrics).map(([metric, value]) => ({ metric, value, status: "MEASURED" as const })), ...extra],
  evidence: [],
  durationMs: 0,
  errors: status === "PASS" ? [] : [`${evaluatorId} ${status}`],
  // Same instrument on both sides unless a test says otherwise.
  provenance: { commands: [], instrument: `instrument-of-${evaluatorId}` },
});
const usage = (value: number, sampleSize: number): Measurement => ({ metric: "usage.success", value, status: "MEASURED", sampleSize });

const MISSION: Mission = {
  id: "fixture-mission",
  organismId: "fixture",
  objective: "Baixar o score sem perder cobertura, e o sucesso real subir.",
  status: "active",
  desiredState: [
    { metric: "score", label: "Score", operator: "<=", target: 3 },
    { metric: "usage.success", label: "Sucesso real", operator: ">=", target: 0.9, minSampleSize: 10 },
  ],
  fitness: {
    objectives: [
      { metric: "score", label: "Score", direction: "minimize", kind: "proxy" },
      { metric: "length", label: "Comprimento", direction: "minimize", kind: "proxy" },
      { metric: "usage.success", label: "Sucesso real", direction: "maximize", kind: "outcome", minSampleSize: 10 },
    ],
    guards: [{ metric: "coverage", label: "Cobertura", operator: ">=", threshold: 3, reason: "menos score não pode vir de cobrir menos" }],
  },
  envelope: {
    id: "fixture-envelope",
    constraints: [
      { id: "paths", name: "Caminhos", severity: "hard", evaluatorId: "path-policy" },
      { id: "check", name: "Checagem", severity: "hard", evaluatorId: "check" },
      { id: "size", name: "Tamanho", severity: "soft", evaluatorId: "score", metric: "size", operator: "<=", threshold: 100 },
    ],
    uncovered: [{ name: "Segurança", reason: "sem avaliador" }],
  },
  evidence: {
    sources: { score: "score", length: "score", coverage: "score", size: "score", "usage.success": "telemetry" },
    instruments: { score: ["evaluators/rule.txt"], telemetry: ["evaluators/telemetry.txt"] },
  },
};

/** One subject's evidence; `usage` measurements come from telemetry, their only trusted source. */
const run = (metrics: Record<string, number>, check: EvaluationResult["status"] = "PASS", usageMeasurements: Measurement[] = []) => [
  evaluation("path-policy", "PASS"),
  evaluation("check", check),
  evaluation("score", "PASS", { size: 10, coverage: 3, length: 5, ...metrics }),
  ...(usageMeasurements.length ? [evaluation("telemetry", "PASS", {}, usageMeasurements)] : []),
];
const baseline = run({ score: 10 });

describe("selection", () => {
  test("HARD FAIL is INELIGIBLE even with much better fitness", () => {
    const decision = decide(MISSION, baseline, run({ score: 0, coverage: 9 }, "FAIL"));
    expect(decision.verdict).toBe("INELIGIBLE");
    expect(decision.reasons[0]).toContain("HARD Checagem: FAIL");
  });

  test("HARD NOT_RUN is INELIGIBLE: a check that did not run is not a pass", () => {
    const candidate = [evaluation("path-policy", "PASS"), notRun("check", "sem runner"), evaluation("score", "PASS", { score: 1, coverage: 3, size: 1, length: 5 })];
    expect(decide(MISSION, baseline, candidate).verdict).toBe("INELIGIBLE");
  });

  test("a broken protected metric is REGRESSED, whatever the objectives say", () => {
    const decision = decide(MISSION, baseline, run({ score: 1, coverage: 2 }));
    expect(decision.verdict).toBe("REGRESSED");
    expect(decision.guards[0]?.status).toBe("FAIL");
  });

  test("objectives stay a vector: better and worse at once is TRADEOFF, only worse is REGRESSED, nothing is NEUTRAL", () => {
    const tradeoff = decide(MISSION, baseline, run({ score: 5, length: 9 }));
    expect(tradeoff.verdict).toBe("TRADEOFF");
    expect(tradeoff.comparisons.map((c) => [c.metric, c.outcome])).toEqual([
      ["score", "improved"],
      ["length", "worse"],
      ["usage.success", "insufficient_data"],
    ]);
    expect(decide(MISSION, baseline, run({ score: 12 })).verdict).toBe("REGRESSED");
    expect(decide(MISSION, baseline, run({ score: 10 })).verdict).toBe("NEUTRAL");
  });

  test("better proxies inside a green envelope are EXPERIMENT_READY — never an outcome improvement", () => {
    const decision = decide(MISSION, baseline, run({ score: 5 }));
    expect(decision.verdict).toBe("EXPERIMENT_READY");
    expect(decision.reasons.join(" ")).toContain("só um experimento em uso real pode confirmar");
  });

  test("a SOFT violation is a warning and never makes a candidate better", () => {
    const heavy = decide(MISSION, baseline, run({ score: 5, size: 500 }));
    expect(heavy.verdict).toBe("PROXY_IMPROVED");
    expect(heavy.warnings[0]).toContain("SOFT Tamanho");
    // Without improvement, the warning changes nothing either way.
    expect(decide(MISSION, baseline, run({ score: 10, size: 500 })).verdict).toBe("NEUTRAL");
  });

  test("outcomes count only with enough samples", () => {
    const before = run({ score: 10 }, "PASS", [usage(0.5, 20)]);
    expect(decide(MISSION, before, run({ score: 5 }, "PASS", [usage(0.95, 4)])).verdict).toBe("EXPERIMENT_READY");
    expect(decide(MISSION, before, run({ score: 5 }, "PASS", [usage(0.8, 20)])).verdict).toBe("OUTCOME_IMPROVED");
    expect(decide(MISSION, before, run({ score: 2 }, "PASS", [usage(0.95, 20)])).verdict).toBe("MISSION_MET");
    expect(decide(MISSION, before, run({ score: 5 }, "PASS", [usage(0.3, 20)])).verdict).toBe("TRADEOFF");
  });

  test("insufficient telemetry never claims the desired state", () => {
    const progress = missionProgress(MISSION, new Map([["score", { metric: "score", value: 1, status: "MEASURED" as const }], ["usage.success", usage(1, 4)]]));
    expect(progress.map((p) => p.status)).toEqual(["MET", "INSUFFICIENT_DATA"]);
    expect(missionReached(progress)).toBe(false);
  });

  test("evidence is STALE when the baseline, mission, envelope or evaluators change, or when it is unbound", () => {
    const binding: DecisionBinding = { baselineRevision: "b1", candidateRevision: "c1", baselineObservationId: "o1", missionId: "m", missionRevision: 1, missionHash: "mh", envelopeHash: "eh", evaluators: ["check@1", "score@1"], environment: "env1" };
    const now: EvidenceContext = { baselineRevision: "b1", missionId: "m", missionRevision: 1, missionHash: "mh", envelopeHash: "eh", evaluators: ["check@1", "score@1"], environment: "env1" };
    const bound = (e: EvaluationResult): EvaluationResult => ({ ...e, binding: { baselineRevision: "b1", subjectRevision: "c1", missionId: "m", missionRevision: 1, missionHash: "mh", envelopeHash: "eh", evaluator: `${e.evaluatorId}@1`, environment: "env1" } });
    const evidence = [bound(evaluation("check", "PASS")), bound(evaluation("score", "PASS"))];
    expect(staleReasons(binding, evidence, now)).toEqual([]);
    expect(staleReasons(binding, evidence, { ...now, baselineRevision: "b2" })[0]).toContain("a baseline mudou");
    expect(staleReasons(binding, evidence, { ...now, missionRevision: 2, missionHash: "mh2" })[0]).toContain("a missão mudou");
    expect(staleReasons(binding, evidence, { ...now, envelopeHash: "eh2" })[0]).toContain("o envelope mudou");
    expect(staleReasons(binding, evidence, { ...now, environment: "env2" })[0]).toContain("o ambiente de execução mudou");
    expect(staleReasons(binding, evidence, { ...now, evaluators: ["check@2", "score@1"] })[0]).toContain("avaliadores mudaram: check@1");
    expect(staleReasons(binding, [evaluation("check", "PASS")], now)[0]).toContain("evidência não vinculada");
    expect(staleReasons(null, evidence, now)[0]).toContain("sem vínculo");
  });
});

// ------------------------------------------------------------------ commands

describe("runCommand", () => {
  test("argv is never interpreted by a shell", async () => {
    const hostile = "a; echo injected $(id) `id` && rm -rf /nope";
    const result = await runCommand(["printf", "%s", hostile], { cwd: tmpdir(), timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(hostile);
  });

  test("a command that runs too long is killed and reported as timed out", async () => {
    const result = await runCommand(["sleep", "5"], { cwd: tmpdir(), timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(2000);
  });

  test("unbounded output is cut and the command killed", async () => {
    const result = await runCommand(["yes"], { cwd: tmpdir(), timeoutMs: 5000, maxOutputBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  test("the environment carries no secrets from the parent", () => {
    process.env.HABITAT_TEST_SECRET = "sk-should-not-leak";
    expect(Object.keys(minimalEnv()).sort()).not.toContain("HABITAT_TEST_SECRET");
    delete process.env.HABITAT_TEST_SECRET;
  });

  test("a failing CommandEvaluator is FAIL with the command as evidence", async () => {
    const result = await new CommandEvaluator("check", ["false"], { timeoutMs: 5000, output: "exit-code" }, LOCAL).evaluate({ dir: tmpdir(), baselineRevision: "a", revision: "b", changes: [] });
    expect(result.status).toBe("FAIL");
    expect(result.evidence[0]?.summary).toContain("false");
  });

  test("an organism instrument (probe) is judged by its validated JSON, never trusted blindly", async () => {
    const ctx = { dir: tmpdir(), baselineRevision: "a", revision: "b", changes: [] };
    const probe = (json: string) => new CommandEvaluator("probe", ["printf", "%s", json], { timeoutMs: 5000, output: "probe" }, LOCAL).evaluate(ctx);
    const ok = await probe(JSON.stringify({ measurements: [{ metric: "m.x", value: 3 }], evidence: [{ summary: "ok" }], problems: [] }));
    expect(ok.status).toBe("PASS");
    expect(ok.measurements.find((m) => m.metric === "m.x")).toMatchObject({ value: 3, status: "MEASURED" });
    const problems = await probe(JSON.stringify({ measurements: [], evidence: [], problems: ["currículo inválido"] }));
    expect(problems).toMatchObject({ status: "FAIL", errors: ["currículo inválido"] });
    expect((await probe("PASS, trust me")).status).toBe("FAIL");
    expect((await probe(JSON.stringify({ measurements: [{ metric: "m.x", value: "3" }], evidence: [], problems: [] }))).status).toBe("FAIL");
  });
});

// ------------------------------------------------------------------ closed loop on fixture repositories

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const result = await runCommand(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@local", ...args], { cwd, timeoutMs: 20_000, env: minimalEnv() });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** The fixture's "curriculum": score and coverage live in content/, the rules in evaluators/ (protected). */
class ScoreEvaluator implements Evaluator {
  readonly id = "score";
  readonly version = "1";
  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const read = (name: string) => Number(readFileSync(join(context.dir, "content", name), "utf8"));
    return evaluation(this.id, "PASS", { score: read("score.txt"), coverage: read("coverage.txt"), size: 10, length: 5 });
  }
}

class CrashingEvaluator implements Evaluator {
  readonly id = "check";
  readonly version = "crash";
  async evaluate(): Promise<EvaluationResult> {
    throw new Error("evaluator exploded");
  }
}

/** Real use, scripted: what learners did with whatever baseline is deployed. */
class ScriptedTelemetry implements TelemetrySource {
  readonly id = "telemetry";
  readonly version = "1";
  next: Measurement[] = [];
  async measure(): Promise<Measurement[]> {
    return this.next;
  }
}

let root = "";
let fixture = "";

type Fixture = { repo: string; worktrees: string; head: string };

/** A fresh clone per test: acceptance moves branches, and tests must not see each other's baselines. */
async function freshRepo(): Promise<Fixture> {
  const dir = join(root, `repo-${crypto.randomUUID().slice(0, 6)}`);
  await git(root, "clone", "--quiet", fixture, dir);
  return { repo: dir, worktrees: `${dir}-worktrees`, head: await git(dir, "rev-parse", "HEAD") };
}

async function patchFor(repo: string, files: Record<string, string>, links: Record<string, string> = {}, base = "HEAD"): Promise<string> {
  const dir = join(root, `author-${crypto.randomUUID().slice(0, 6)}`);
  await git(repo, "worktree", "add", "--detach", dir, base);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));
  await git(dir, "add", "-A");
  const patch = (await runCommand(["git", "diff", "--cached", "--binary"], { cwd: dir, timeoutMs: 10_000, env: minimalEnv() })).stdout;
  await git(repo, "worktree", "remove", "--force", dir);
  return patch;
}

const proposal = (id: string, patch: string, claims?: string): MutationProposal => ({ id, hypothesis: `Hipótese ${id} do fixture.`, source: { kind: "manual", author: "test" }, patch, ...(claims ? { claims } : {}) });

type FixtureOptions = {
  crash?: boolean;
  checkTimeoutMs?: number;
  mission?: Mission;
  store?: HabitatStore;
  reviseMissionBy?: string;
  telemetry?: TelemetrySource;
  extra?: Evaluator[];
  /** Hash of the execution environment reported for every revision (change it to simulate a new runtime). */
  environment?: string;
  runner?: CommandRunner;
  organismId?: string;
};

function habitatFor(f: Fixture, proposals: MutationProposal[], options: FixtureOptions = {}) {
  const organism = new GitOrganism(f.repo, "main");
  const store = options.store ?? new HabitatStore(":memory:");
  const checkEvaluator: Evaluator = options.crash ? new CrashingEvaluator() : new CommandEvaluator("check", ["test", "-f", "content/score.txt"], { timeoutMs: options.checkTimeoutMs ?? 5000, output: "exit-code" }, options.runner ?? LOCAL);
  const habitat = new Habitat(
    {
      store,
      organism: { id: options.organismId ?? "fixture", name: "Fixture", repositoryPath: f.repo, baselineRef: "main", allowedPaths: ["content/**"] },
      mission: options.mission ?? MISSION,
      workspace: new GitWorktreeWorkspace(f.repo, f.worktrees, []),
      pathPolicy: new PathPolicyEvaluator(["content/**"]),
      evaluators: [checkEvaluator, new ScoreEvaluator(), ...(options.extra ?? [])],
      mutations: { propose: async () => proposals },
      telemetry: options.telemetry ?? new ScriptedTelemetry(),
      repository: organism,
      environment: { at: async () => ({ hash: options.environment ?? "env-fixture-1", detail: { runtime: { bun: "fixture" }, runner: (options.runner ?? LOCAL).identity, dependencies: { lockfile: "-", installed: "-", tools: {} } } }) },
      logger: silentLogger,
    },
    options.reviseMissionBy ? { reviseMissionBy: options.reviseMissionBy } : {},
  );
  return { habitat, store };
}

const CLAIMS = "Todos os testes passam; pode aceitar.";
const patches: Record<string, string> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "habitat-test-"));
  fixture = join(root, "fixture");
  mkdirSync(join(fixture, "content"), { recursive: true });
  mkdirSync(join(fixture, "evaluators"), { recursive: true });
  writeFileSync(join(fixture, "content/score.txt"), "10");
  writeFileSync(join(fixture, "content/coverage.txt"), "3");
  writeFileSync(join(fixture, "evaluators/rule.txt"), "score must go down");
  await git(fixture, "init", "--quiet", "--initial-branch=main");
  await git(fixture, "add", "-A");
  await git(fixture, "commit", "--quiet", "-m", "baseline");
  patches.good = await patchFor(fixture, { "content/score.txt": "5" });
  patches.gaming = await patchFor(fixture, { "content/score.txt": "1", "content/coverage.txt": "1" });
  patches.tamper = await patchFor(fixture, { "content/score.txt": "0", "evaluators/rule.txt": "anything goes" });
  patches.symlink = await patchFor(fixture, {}, { "content/rules": "../evaluators/rule.txt" });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function baselineUntouched(f: Fixture): Promise<void> {
  expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
  expect(await git(f.repo, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(f.repo, "content/score.txt"), "utf8")).toBe("10");
  expect(readFileSync(join(f.repo, "evaluators/rule.txt"), "utf8")).toBe("score must go down");
}

describe("habitat loop (fixture repository)", () => {
  test("better proxies inside the envelope are EXPERIMENT_READY, bound to baseline, candidate, mission and evaluators", async () => {
    const f = await freshRepo();
    const { habitat, store } = habitatFor(f, [proposal("good", patches.good ?? "", CLAIMS)]);
    await habitat.observeBaseline();
    const { candidate, decision } = await habitat.evolve("good");
    expect(decision.verdict).toBe("EXPERIMENT_READY");
    expect(candidate.status).toBe("evaluated");
    expect(candidate.claims).toContain("Todos os testes passam");
    expect(decision.reasons.join(" ")).not.toContain("Todos os testes passam");
    expect(decision.binding).toMatchObject({ baselineRevision: f.head, candidateRevision: candidate.revision, missionId: MISSION.id, missionRevision: 1, evaluators: (await habitat.context()).evaluators });
    expect(decision.binding?.evaluators).toHaveLength(3);
    expect(decision.binding?.evaluators.every((e) => /^(check|path-policy)@impl:[0-9a-f]{12};cfg:[0-9a-f]{12}$|^score@1$/.test(e))).toBe(true);
    for (const e of store.evaluations("candidate", candidate.id)) expect(e.binding).toMatchObject({ baselineRevision: f.head, subjectRevision: candidate.revision, missionHash: decision.binding?.missionHash });
    expect((await habitat.assess(candidate.id)).verdict).toBe("EXPERIMENT_READY");
    expect(existsSync(join(f.worktrees, candidate.id))).toBe(false);
    expect(await git(f.repo, "rev-parse", `refs/habitat/candidates/${candidate.id}`)).toBe(candidate.revision ?? "");
    await baselineUntouched(f);
  });

  test("a candidate that touches evaluators is INELIGIBLE, runs nothing, and stays inspectable", async () => {
    const f = await freshRepo();
    const { habitat, store } = habitatFor(f, [proposal("tamper", patches.tamper ?? "", CLAIMS)]);
    await habitat.observeBaseline();
    const { candidate, decision } = await habitat.evolve("tamper");
    expect(decision.verdict).toBe("INELIGIBLE");
    const evaluations = store.evaluations("candidate", candidate.id);
    expect(evaluations.find((e) => e.evaluatorId === "path-policy")?.errors).toContain("fora dos caminhos permitidos: evaluators/rule.txt");
    expect(evaluations.filter((e) => e.evaluatorId !== "path-policy").map((e) => e.status)).toEqual(["NOT_RUN", "NOT_RUN"]);
    expect(await git(f.repo, "cat-file", "-t", `refs/habitat/candidates/${candidate.id}`)).toBe("commit");
    await baselineUntouched(f);
  });

  test("symlinks are refused even inside allowed paths; cutting a protected metric is REGRESSED; a crash is a FAIL", async () => {
    const f = await freshRepo();
    const { habitat } = habitatFor(f, [proposal("symlink", patches.symlink ?? ""), proposal("gaming", patches.gaming ?? "")]);
    await habitat.observeBaseline();
    expect((await habitat.evolve("symlink")).decision.verdict).toBe("INELIGIBLE");
    expect((await habitat.evolve("gaming")).decision.verdict).toBe("REGRESSED");
    const crashing = habitatFor(f, [proposal("good", patches.good ?? "")], { crash: true }).habitat;
    await crashing.observeBaseline();
    const { decision } = await crashing.evolve("good");
    expect(decision.verdict).toBe("INELIGIBLE");
    expect(decision.constraints.find((c) => c.constraintId === "check")?.detail).toContain("evaluator exploded");
  });

  test("a patch that does not apply fails and leaves no workspace behind", async () => {
    const f = await freshRepo();
    const stale = "diff --git a/content/x.txt b/content/x.txt\n--- a/content/x.txt\n+++ b/content/x.txt\n@@ -1 +1 @@\n-nope\n+yes\n";
    const { habitat, store } = habitatFor(f, [proposal("stale", stale)]);
    await habitat.observeBaseline();
    await expect(habitat.evolve("stale")).rejects.toThrow();
    const [candidate] = store.candidates(MISSION.id);
    expect(candidate?.status).toBe("failed");
    expect(existsSync(join(f.worktrees, candidate?.id ?? "x"))).toBe(false);
    await baselineUntouched(f);
  });

  test("when the baseline moves, evidence goes STALE, acceptance is refused, and re-evaluation replays the change", async () => {
    const f = await freshRepo();
    const { habitat, store } = habitatFor(f, [proposal("good", patches.good ?? "")]);
    await habitat.observeBaseline();
    const first = await habitat.evolve("good");
    writeFileSync(join(f.repo, "content/coverage.txt"), "4");
    await git(f.repo, "commit", "--quiet", "-am", "someone else changed the baseline");

    const assessment = await habitat.assess(first.candidate.id);
    expect(assessment.verdict).toBe("STALE");
    expect(assessment.recordedVerdict).toBe("EXPERIMENT_READY");
    expect(assessment.stale[0]).toContain("a baseline mudou");
    await expect(habitat.accept(first.candidate.id, "reviewer")).rejects.toMatchObject({ code: "STALE_EVIDENCE" });
    await expect(habitat.reevaluate(first.candidate.id)).rejects.toMatchObject({ code: "BASELINE_NOT_OBSERVED" });

    await habitat.observeBaseline();
    const again = await habitat.reevaluate(first.candidate.id);
    expect(again.candidate.reevaluationOf).toBe(first.candidate.id);
    expect(again.candidate.parentRevision).toBe(await git(f.repo, "rev-parse", "HEAD"));
    expect(again.decision.verdict).toBe("EXPERIMENT_READY");
    expect(store.events(MISSION.id).some((e) => e.kind === "candidate_reevaluation_started")).toBe(true);
  });

  test("changing an evaluator's configuration makes old evidence stale and the old observation unusable", async () => {
    const f = await freshRepo();
    const store = new HabitatStore(":memory:");
    const before = habitatFor(f, [proposal("good", patches.good ?? "")], { store }).habitat;
    await before.observeBaseline();
    const { candidate } = await before.evolve("good");
    const after = habitatFor(f, [proposal("good", patches.good ?? "")], { store, checkTimeoutMs: 9000 }).habitat;
    const assessment = await after.assess(candidate.id);
    expect(assessment.verdict).toBe("STALE");
    expect(assessment.stale.join(" ")).toContain("avaliadores mudaram");
    await expect(after.evolve("good")).rejects.toMatchObject({ code: "BASELINE_NOT_OBSERVED" });
  });

  test("a changed mission is refused until a human revises it; then earlier evidence is STALE", async () => {
    const f = await freshRepo();
    const store = new HabitatStore(":memory:");
    const { habitat } = habitatFor(f, [proposal("good", patches.good ?? "")], { store });
    await habitat.observeBaseline();
    const { candidate } = await habitat.evolve("good");
    const loosened: Mission = { ...MISSION, envelope: { ...MISSION.envelope, constraints: MISSION.envelope.constraints.map((c) => ({ ...c, severity: "soft" as const })) } };
    expect(() => habitatFor(f, [], { store, mission: loosened })).toThrow(MissionDriftError);
    const revised = habitatFor(f, [], { store, mission: loosened, reviseMissionBy: "product owner" }).habitat;
    const assessment = await revised.assess(candidate.id);
    expect(assessment.verdict).toBe("STALE");
    expect(assessment.stale.join(" ")).toContain("a missão mudou (revisão 1 → 2)");
    expect(store.events(MISSION.id).find((e) => e.kind === "mission_revised")?.data).toMatchObject({ by: "product owner" });
  });

  test("closed loop: observe → candidate → evaluate → accept → new baseline → observe again → second generation", async () => {
    const f = await freshRepo();
    const telemetry = new ScriptedTelemetry();
    const proposals = [proposal("good", patches.good ?? ""), proposal("gaming", patches.gaming ?? "")];
    const { habitat, store } = habitatFor(f, proposals, { telemetry });

    telemetry.next = [usage(0.5, 20)];
    await habitat.observeBaseline();
    const gaming = await habitat.evolve("gaming");
    const good = await habitat.evolve("good");
    expect(good.candidate.generation).toBe(1);
    await expect(habitat.accept(gaming.candidate.id, "reviewer")).rejects.toMatchObject({ code: "NOT_ACCEPTABLE" });

    // Human acceptance: fast-forward only, the candidate's own commit becomes the baseline.
    const { from, to } = await habitat.accept(good.candidate.id, "reviewer");
    expect(from).toBe(f.head);
    expect(to).toBe(good.candidate.revision ?? "");
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(to);
    expect(readFileSync(join(f.repo, "content/score.txt"), "utf8")).toBe("5");
    await expect(habitat.accept(good.candidate.id, "reviewer")).rejects.toBeInstanceOf(HabitatRefusal);
    // The competitor was judged against the old baseline: its evidence no longer describes the present.
    expect((await habitat.assess(gaming.candidate.id)).verdict).toBe("STALE");

    // Observe the new baseline; real use now shows the outcome with enough samples.
    telemetry.next = [usage(0.8, 20)];
    const { observationId } = await habitat.observeBaseline();
    const experiment = store.assessment(observationId);
    expect(experiment?.candidateId).toBe(good.candidate.id);
    expect(experiment?.decision.verdict).toBe("OUTCOME_IMPROVED");

    // Second generation, proposed against the new baseline.
    const next = proposal("better", await patchFor(f.repo, { "content/score.txt": "2" }));
    proposals.push(next);
    const second = await habitat.evolve("better");
    expect(second.candidate.generation).toBe(2);
    expect(second.candidate.parentRevision).toBe(to);
    expect(second.decision.verdict).toBe("EXPERIMENT_READY");
    expect(store.events(MISSION.id).map((e) => e.kind)).toEqual(expect.arrayContaining(["candidate_accepted", "baseline_advanced", "experiment_assessed"]));

    // A human commit on top of the accepted baseline keeps the lineage: the next candidate is still generation 2.
    writeFileSync(join(f.repo, "content/coverage.txt"), "4");
    await git(f.repo, "commit", "--quiet", "-am", "human change on top of the accepted baseline");
    expect((await habitat.assess(second.candidate.id)).verdict).toBe("STALE");
    await habitat.observeBaseline();
    const replayed = await habitat.reevaluate(second.candidate.id);
    expect(replayed.candidate.generation).toBe(2);
    expect(replayed.decision.verdict).toBe("EXPERIMENT_READY");
  });

  test("one job at a time", async () => {
    const f = await freshRepo();
    const { habitat } = habitatFor(f, [proposal("good", patches.good ?? ""), proposal("gaming", patches.gaming ?? "")]);
    await habitat.observeBaseline();
    const first = habitat.evolve("good");
    await expect(habitat.evolve("gaming")).rejects.toBeInstanceOf(HabitatBusyError);
    await first;
  });
});

describe("habitat store", () => {
  test("a v1 database migrates; its decisions become STALE instead of keeping the old verdicts", () => {
    const dir = mkdtempSync(join(tmpdir(), "habitat-v1-"));
    const path = join(dir, "habitat.sqlite");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE missions (id TEXT PRIMARY KEY, organism_id TEXT NOT NULL, definition TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE observations (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, revision TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE candidates (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, proposal_id TEXT NOT NULL, generation INTEGER NOT NULL, parent_revision TEXT NOT NULL, revision TEXT, hypothesis TEXT NOT NULL, source TEXT NOT NULL, claims TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE candidate_changes (candidate_id TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, old_mode TEXT NOT NULL, new_mode TEXT NOT NULL);
      CREATE TABLE evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, evaluator_id TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE decisions (candidate_id TEXT PRIMARY KEY, verdict TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE habitat_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, mission_id TEXT, candidate_id TEXT, data TEXT, created_at INTEGER NOT NULL);
      INSERT INTO missions VALUES ('m', 'o', '{"id":"m"}', 1);
      INSERT INTO candidates VALUES ('cand-1', 'm', 'p', 1, 'aaa', 'bbb', 'h', '{"kind":"manual","author":"x"}', NULL, 'promotable', 2);
      INSERT INTO decisions VALUES ('cand-1', 'PROMOTABLE', '{"verdict":"PROMOTABLE","constraints":[],"comparisons":[],"guards":[],"reasons":["x"]}', 3);
    `);
    db.close();
    try {
      const store = new HabitatStore(path);
      expect(store.candidate("cand-1")?.status).toBe("evaluated");
      const decision = store.decision("cand-1");
      expect(decision?.verdict).toBe("STALE");
      expect(decision?.reasons[0]).toContain("semântica antiga (PROMOTABLE)");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ Replay organism

describe("Replay organism", () => {
  const replay = replayOrganism("/repo", "master");
  const policy = new PathPolicyEvaluator(replay.allowedPaths);
  const check = (path: string) => policy.evaluate({ dir: "/", baselineRevision: "a", revision: "b", changes: [{ path, status: "M", oldMode: "100644", newMode: "100644" }] });

  test("candidates may change curriculum content, never tests, evaluators or Habitat", async () => {
    expect((await check("data/golden/ops-triage-ai/stages/m1/14-whole-words/stage.json")).status).toBe("PASS");
    expect((await check("scripts/author-golden-m1.ts")).status).toBe("PASS");
    for (const path of ["tests/curriculum.test.ts", "src/services/curriculum-check.ts", "scripts/measure.ts", "src/server.ts", "data/golden/ops-triage-ai/stages/../../../../src/x.ts", "package.json"]) {
      expect((await check(path)).status).toBe("FAIL");
    }
  });

  test("the mission protects correctness as HARD constraints and separates proxies from outcomes", () => {
    const hard = REPLAY_TTVO_MISSION.envelope.constraints.filter((c) => c.severity === "hard").map((c) => c.evaluatorId);
    expect(hard).toEqual(expect.arrayContaining(["path-policy", "typecheck", "tests", "replay-curriculum"]));
    const outcomes = REPLAY_TTVO_MISSION.fitness.objectives.filter((o) => o.kind === "outcome");
    expect(outcomes.map((o) => o.metric)).toEqual(["replay.median_microstage_seconds", "replay.checkpoint_success_rate", "replay.novel_change_success_rate"]);
    expect(outcomes.every((o) => o.minSampleSize !== undefined)).toBe(true);
  });

  test("curriculum and bundle come from the organism's own instrument, which candidates cannot touch", async () => {
    const { evaluators } = replayEvaluators(replay, LOCAL);
    expect(evaluators.map((e) => e.id)).toEqual(["replay-curriculum", "replay-bundle", "typecheck", "tests"]);
    expect((await check("scripts/measure.ts")).status).toBe("FAIL");
  });

  test("telemetry without data says INSUFFICIENT_DATA, and counts only events after the content change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "habitat-telemetry-"));
    const path = join(dir, "events.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, learner_id TEXT, journey_id TEXT, stage_id TEXT, type TEXT, data TEXT, created_at INTEGER)");
    const insert = db.query("INSERT INTO events (learner_id, journey_id, stage_id, type, data, created_at) VALUES (?, 'ops-triage-ai', ?, ?, ?, ?)");
    insert.run("old", "ops-triage-ai.m1-01", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 999_000 }), 500);
    insert.run("l1", "ops-triage-ai.m1-01", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 30_000 }), 2000);
    insert.run("l1", "ops-triage-ai.m1-02", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 90_000 }), 2001);
    db.close();
    try {
      const empty = await new ReplayTelemetrySource(join(dir, "missing.sqlite"), async () => 0).measure();
      expect(empty.filter((m) => m.metric !== "telemetry.rejected_events").every((m) => m.status === "INSUFFICIENT_DATA")).toBe(true);
      expect(empty.find((m) => m.metric === "telemetry.rejected_events")?.value).toBe(0);
      const measured = await new ReplayTelemetrySource(path, async () => 1000).measure();
      expect(measured.find((m) => m.metric === "replay.median_microstage_seconds")).toMatchObject({ value: 60, sampleSize: 2, status: "MEASURED" });
      expect(measured.find((m) => m.metric === "replay.novel_change_success_rate")?.status).toBe("INSUFFICIENT_DATA");
      // Two samples measured, but the mission needs 30: still not claimable.
      const progress = missionProgress(REPLAY_TTVO_MISSION, new Map(measured.map((m) => [m.metric, m])));
      expect(progress.find((p) => p.metric === "replay.median_microstage_seconds")?.status).toBe("INSUFFICIENT_DATA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ evaluator identity

describe("evaluator identity is derived, not declared", () => {
  test("it follows the implementation's content and the configuration — nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "habitat-identity-"));
    try {
      const impl = join(dir, "impl.ts");
      const unrelated = join(dir, "cockpit.css");
      writeFileSync(impl, "export const rule = 1;");
      writeFileSync(unrelated, "body {}");
      const v1 = deriveVersion([impl], { argv: ["bun", "test"], timeoutMs: 1000 });
      expect(v1).toMatch(/^impl:[0-9a-f]{12};cfg:[0-9a-f]{12}$/);
      expect(deriveVersion([impl], { timeoutMs: 1000, argv: ["bun", "test"] })).toBe(v1);
      writeFileSync(unrelated, "body { color: red }");
      expect(deriveVersion([impl], { argv: ["bun", "test"], timeoutMs: 1000 })).toBe(v1);
      const [impl1, cfg1] = v1.split(";");
      const [implSlower, cfgSlower] = deriveVersion([impl], { argv: ["bun", "test"], timeoutMs: 2000 }).split(";");
      expect(implSlower).toBe(impl1);
      expect(cfgSlower).not.toBe(cfg1);
      writeFileSync(impl, "export const rule = 2;");
      const [implEdited, cfgEdited] = deriveVersion([impl], { argv: ["bun", "test"], timeoutMs: 1000 }).split(";");
      expect(implEdited).not.toBe(impl1);
      expect(cfgEdited).toBe(cfg1);
      expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("command evaluators differ by argv, timeout and output parser, and are stable otherwise", () => {
    const make = (argv: string[], timeoutMs: number, output: "exit-code" | "bun-test" | "probe") => new CommandEvaluator("x", argv, { timeoutMs, output }, LOCAL).version;
    const base = make(["bun", "test"], 1000, "bun-test");
    expect(make(["bun", "test"], 1000, "bun-test")).toBe(base);
    expect(new Set([base, make(["bun", "test", "--bail"], 1000, "bun-test"), make(["bun", "test"], 2000, "bun-test"), make(["bun", "test"], 1000, "exit-code")]).size).toBe(4);
  });

  test("editing an evaluator's implementation makes its evidence STALE and the old observation unusable", async () => {
    const f = await freshRepo();
    const dir = mkdtempSync(join(tmpdir(), "habitat-rule-"));
    const rule = join(dir, "rule.ts");
    writeFileSync(rule, "export const minimum = 1;");
    class RuleEvaluator implements Evaluator {
      readonly id = "rule";
      readonly version = deriveVersion([rule], {});
      async evaluate(): Promise<EvaluationResult> {
        return evaluation(this.id, "PASS");
      }
    }
    try {
      const store = new HabitatStore(":memory:");
      const before = habitatFor(f, [proposal("good", patches.good ?? "")], { store, extra: [new RuleEvaluator()] }).habitat;
      await before.observeBaseline();
      const { candidate } = await before.evolve("good");
      expect((await before.assess(candidate.id)).verdict).toBe("EXPERIMENT_READY");
      writeFileSync(rule, "export const minimum = 2;");
      const after = habitatFor(f, [proposal("good", patches.good ?? "")], { store, extra: [new RuleEvaluator()] }).habitat;
      const assessment = await after.assess(candidate.id);
      expect(assessment.verdict).toBe("STALE");
      expect(assessment.stale.join(" ")).toContain("avaliadores mudaram: rule@");
      await expect(after.evolve("good")).rejects.toMatchObject({ code: "BASELINE_NOT_OBSERVED" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ control plane vs organism

describe("control plane and organism are separate repositories", () => {
  test("changing only Habitat keeps the organism baseline and its evidence valid", async () => {
    const f = await freshRepo();
    const control = join(root, `habitat-${crypto.randomUUID().slice(0, 6)}`);
    mkdirSync(control);
    writeFileSync(join(control, "cockpit.css"), "body {}");
    await git(control, "init", "--quiet", "--initial-branch=main");
    await git(control, "add", "-A");
    await git(control, "commit", "--quiet", "-m", "habitat");

    const store = new HabitatStore(":memory:");
    const before = habitatFor(f, [proposal("good", patches.good ?? "")], { store });
    await before.habitat.observeBaseline();
    const { candidate } = await before.habitat.evolve("good");
    const contextBefore = await before.habitat.context();

    // A Habitat-only change: new commit in the control repository, Habitat restarted on the same recorder.
    writeFileSync(join(control, "cockpit.css"), "body { color: red }");
    await git(control, "commit", "--quiet", "-am", "cockpit tweak");
    const after = habitatFor(f, [proposal("good", patches.good ?? "")], { store }).habitat;

    expect(await after.context()).toEqual(contextBefore);
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
    expect(await after.assess(candidate.id)).toEqual({ verdict: "EXPERIMENT_READY", recordedVerdict: "EXPERIMENT_READY", stale: [] });
    // The baseline observation is still current: no re-observation needed to keep evolving.
    expect((await after.evolve("good")).decision.verdict).toBe("EXPERIMENT_READY");
  });

  test("the baseline ref only moves fast-forward, and a checkout that is not on it stays untouched", async () => {
    const f = await freshRepo();
    const organism = new GitOrganism(f.repo, "main");
    const { habitat } = habitatFor(f, [proposal("good", patches.good ?? "")]);
    await habitat.observeBaseline();
    const { candidate } = await habitat.evolve("good");
    await git(f.repo, "checkout", "--quiet", "--detach");

    const { to } = await habitat.accept(candidate.id, "reviewer");
    expect(await organism.baselineRevision()).toBe(to);
    expect(await git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
    expect(readFileSync(join(f.repo, "content/score.txt"), "utf8")).toBe("10");

    await expect(organism.advanceBaseline(to, f.head)).rejects.toThrow("não é fast-forward");
    await expect(organism.advanceBaseline(f.head, to)).rejects.toThrow("a baseline não é mais");
    expect(() => new GitOrganism(f.repo, "main..evil")).toThrow("invalid baseline ref");
  });
});

// ------------------------------------------------------------------ telemetry and measurement trust

describe("raw measurements are not trusted evidence", () => {
  const withInstrument = (e: EvaluationResult, instrument: string): EvaluationResult => ({ ...e, provenance: { commands: [], instrument } });

  test("a metric counts only from its declared source; the same metric from anywhere else is ignored", () => {
    const forged = evaluation("probe", "PASS", { score: 0 }, [usage(0.99, 1000)]);
    const decision = decide(MISSION, run({ score: 10 }, "PASS", [usage(0.5, 20)]), [...run({ score: 10 }, "PASS", [usage(0.5, 20)]), forged]);
    expect(decision.verdict).toBe("NEUTRAL");
    expect(decision.reasons).toEqual(expect.arrayContaining(["medida não confiável ignorada: score emitida por probe (fonte confiável: score)", "medida não confiável ignorada: usage.success emitida por probe (fonte confiável: telemetry)"]));
  });

  test("outcomes produced by different instrumentation are not comparable, whatever the numbers", () => {
    const before = run({ score: 10 }, "PASS", [usage(0.5, 20)]).map((e) => (e.evaluatorId === "telemetry" ? withInstrument(e, "events-v1") : e));
    const after = run({ score: 5 }, "PASS", [usage(0.95, 20)]).map((e) => (e.evaluatorId === "telemetry" ? withInstrument(e, "events-v2") : e));
    const decision = decide(MISSION, before, after);
    expect(decision.comparisons.find((c) => c.metric === "usage.success")?.outcome).toBe("untrusted");
    expect(decision.verdict).toBe("EXPERIMENT_READY");
  });

  test("the Mission must name a trusted source for every metric it uses, and constraints must read from it", () => {
    const { score: _dropped, ...sources } = MISSION.evidence.sources;
    expect(() => Mission.parse({ ...MISSION, evidence: { ...MISSION.evidence, sources } })).toThrow("metric score has no trusted source");
    expect(() => Mission.parse({ ...MISSION, evidence: { ...MISSION.evidence, sources: { ...MISSION.evidence.sources, size: "check" } } })).toThrow("its trusted source is check");
  });

  test("Habitat refuses instruments that candidates could edit, and missions of another organism", async () => {
    const f = await freshRepo();
    const editable: Mission = { ...MISSION, evidence: { ...MISSION.evidence, instruments: { ...MISSION.evidence.instruments, telemetry: ["content/events.ts"] } } };
    expect(() => habitatFor(f, [], { mission: editable })).toThrow("o instrumento de telemetry (content/events.ts) está dentro dos caminhos que candidates podem alterar");
    expect(() => habitatFor(f, [], { organismId: "other" })).toThrow("é do organismo fixture, não de other");
  });

  test("a candidate cannot claim outcomes by making an organism instrument report them", async () => {
    const f = await freshRepo();
    // An organism-side instrument that reports whatever the checkout tells it to — like edited telemetry would.
    class ReportingInstrument implements Evaluator {
      readonly id = "reporting";
      readonly version = "1";
      async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
        const claimed = existsSync(join(context.dir, "content/claimed.txt")) ? Number(readFileSync(join(context.dir, "content/claimed.txt"), "utf8")) : 0;
        return evaluation(this.id, "PASS", { score: 0 }, [usage(claimed, 1000)]);
      }
    }
    const forged = proposal("forged", await patchFor(f.repo, { "content/claimed.txt": "0.99" }));
    const { habitat } = habitatFor(f, [forged], { extra: [new ReportingInstrument()] });
    await habitat.observeBaseline();
    const { decision } = await habitat.evolve("forged");
    expect(decision.verdict).toBe("NEUTRAL");
    expect(decision.comparisons.find((c) => c.metric === "usage.success")?.outcome).toBe("insufficient_data");
    expect(decision.reasons.join(" ")).toContain("usage.success emitida por reporting");
  });

  test("a change of execution environment makes evidence STALE and requires a new observation", async () => {
    const f = await freshRepo();
    const store = new HabitatStore(":memory:");
    const before = habitatFor(f, [proposal("good", patches.good ?? "")], { store }).habitat;
    await before.observeBaseline();
    const { candidate } = await before.evolve("good");
    const after = habitatFor(f, [proposal("good", patches.good ?? "")], { store, environment: "env-fixture-2" }).habitat;
    const assessment = await after.assess(candidate.id);
    expect(assessment.verdict).toBe("STALE");
    expect(assessment.stale.join(" ")).toContain("o ambiente de execução mudou");
    await expect(after.evolve("good")).rejects.toMatchObject({ code: "BASELINE_NOT_OBSERVED" });
  });

  test("evidence records the instrument identity and the commands that produced it", async () => {
    const f = await freshRepo();
    const { habitat, store } = habitatFor(f, [proposal("good", patches.good ?? "")]);
    await habitat.observeBaseline();
    const { candidate } = await habitat.evolve("good");
    const evaluations = store.evaluations("candidate", candidate.id);
    expect(evaluations.find((e) => e.evaluatorId === "score")?.provenance?.instrument).toMatch(/^[0-9a-f]{16}$/);
    expect(evaluations.find((e) => e.evaluatorId === "check")?.provenance?.commands).toEqual([{ argv: ["test", "-f", "content/score.txt"], runner: "trusted-local", exitCode: 0, durationMs: expect.any(Number), timedOut: false, limit: null }]);
    expect(evaluations.every((e) => e.binding?.environment === "env-fixture-1")).toBe(true);
  });

  test("malformed raw events are rejected and counted, never interpreted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "habitat-raw-"));
    const path = join(dir, "events.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, learner_id TEXT, journey_id TEXT, stage_id TEXT, type TEXT, data TEXT, created_at INTEGER)");
    const insert = db.query("INSERT INTO events (learner_id, journey_id, stage_id, type, data, created_at) VALUES (?, 'ops-triage-ai', ?, ?, ?, ?)");
    insert.run("l1", "ops-triage-ai.m1-01", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 60_000 }), 10);
    insert.run("l2", "ops-triage-ai.m1-01", "stage_status_changed", "{not json", 10);
    insert.run("", "ops-triage-ai.m1-01", "stage_status_changed", JSON.stringify({ status: "completed", timeSpentMs: 1 }), 10);
    db.close();
    try {
      const measured = await new ReplayTelemetrySource(path, async () => 0).measure();
      expect(measured.find((m) => m.metric === "telemetry.rejected_events")?.value).toBe(2);
      expect(measured.find((m) => m.metric === "replay.median_microstage_seconds")).toMatchObject({ value: 60, sampleSize: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ two organisms

describe("two organisms under one Habitat recorder do not contaminate each other", () => {
  test("baselines, candidates, refs, observations, evidence, telemetry and recorder stay per organism", async () => {
    const a = await freshRepo();
    const b0 = await freshRepo();
    // A second, independent history: B diverges from its first commit on.
    writeFileSync(join(b0.repo, "content/score.txt"), "20");
    await git(b0.repo, "commit", "--quiet", "-am", "organism B baseline");
    const b: Fixture = { ...b0, head: await git(b0.repo, "rev-parse", "HEAD"), worktrees: a.worktrees };
    const MISSION_B: Mission = { ...MISSION, id: "fixture-mission-b", organismId: "fixture-b" };

    const store = new HabitatStore(":memory:");
    const telemetryA = new ScriptedTelemetry();
    const telemetryB = new ScriptedTelemetry();
    telemetryA.next = [usage(0.5, 20)];
    telemetryB.next = [usage(0.7, 20)];
    const A = habitatFor(a, [proposal("good", patches.good ?? "")], { store, telemetry: telemetryA }).habitat;
    const B = habitatFor(b, [proposal("good-b", await patchFor(b.repo, { "content/score.txt": "15" }))], { store, telemetry: telemetryB, mission: MISSION_B, organismId: "fixture-b" }).habitat;

    const obsA = await A.observeBaseline();
    const obsB = await B.observeBaseline();
    const candA = (await A.evolve("good")).candidate;
    const candB = (await B.evolve("good-b")).candidate;
    await A.accept(candA.id, "reviewer");

    // Baseline: only A moved.
    expect(await git(a.repo, "rev-parse", "main")).toBe(candA.revision ?? "");
    expect(await git(b.repo, "rev-parse", "main")).toBe(b.head);
    // Evidence of B is untouched by A's acceptance.
    expect((await B.assess(candB.id)).verdict).toBe("EXPERIMENT_READY");
    // Candidates and refs live only in their own organism.
    expect(store.candidates(MISSION.id).map((c) => c.id)).toEqual([candA.id]);
    expect(store.candidates(MISSION_B.id).map((c) => c.id)).toEqual([candB.id]);
    expect(await git(a.repo, "for-each-ref", "--format=%(refname)", "refs/habitat")).toBe(`refs/habitat/candidates/${candA.id}`);
    expect(await git(b.repo, "for-each-ref", "--format=%(refname)", "refs/habitat")).toBe(`refs/habitat/candidates/${candB.id}`);
    // Observations and their evidence are bound to their own organism's revisions and mission.
    expect(store.observations(MISSION.id).map((o) => o.revision)).toEqual([a.head]);
    expect(store.observations(MISSION_B.id).map((o) => o.revision)).toEqual([b.head]);
    for (const e of store.evaluations("candidate", candB.id)) expect(e.binding).toMatchObject({ missionId: MISSION_B.id, baselineRevision: b.head, subjectRevision: candB.revision });
    // Telemetry: each observation holds its own organism's numbers.
    const usageOf = (observationId: string) => store.evaluations("observation", observationId).find((e) => e.evaluatorId === "telemetry")?.measurements[0]?.value;
    expect([usageOf(obsA.observationId), usageOf(obsB.observationId)]).toEqual([0.5, 0.7]);
    // Recorder: each mission's history mentions only its own candidates.
    expect(store.events(MISSION.id).every((e) => e.missionId === MISSION.id && e.candidateId !== candB.id)).toBe(true);
    expect(store.events(MISSION_B.id).every((e) => e.missionId === MISSION_B.id && e.candidateId !== candA.id)).toBe(true);
    expect(store.events(MISSION_B.id).some((e) => e.kind === "baseline_advanced")).toBe(false);
    // Neither Habitat can see, judge, replay or accept the other's candidate.
    expect(await A.assess(candB.id)).toEqual({ verdict: null, recordedVerdict: null, stale: [] });
    await expect(A.accept(candB.id, "reviewer")).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(B.reevaluate(candA.id)).rejects.toMatchObject({ code: "UNKNOWN" });
  });
});

// ------------------------------------------------------------------ the loop through the real sandbox

describe.skipIf(LinuxSandboxRunner.unavailable() !== null)("candidates evaluated in the linux sandbox", () => {
  test("the fixture loop runs sandboxed and records it in the evidence", async () => {
    const f = await freshRepo();
    const runner = new LinuxSandboxRunner(process.execPath, null, { memoryMb: 256, pids: 64, cpus: 1, tmpMb: 16 });
    const { habitat, store } = habitatFor(f, [proposal("good", patches.good ?? "")], { runner });
    await habitat.observeBaseline();
    const { candidate, decision } = await habitat.evolve("good");
    expect(decision.verdict).toBe("EXPERIMENT_READY");
    const check = store.evaluations("candidate", candidate.id).find((e) => e.evaluatorId === "check");
    expect(check).toMatchObject({ status: "PASS", provenance: { commands: [{ runner: "linux-sandbox", exitCode: 0, limit: null }] } });
  });
});
