import { resolve } from "node:path";
import { z } from "zod";
import { minimalEnv, runCommand } from "../command.ts";
import { Habitat } from "../evolution.ts";
import { HermeticDependencies } from "../dependencies.ts";
import { GitOrganism, GitWorktreeWorkspace } from "../git-workspace.ts";
import type { Logger } from "../logger.ts";
import { DirectoryMutationProvider } from "../proposals.ts";
import { ExecutionEnvironment } from "../provenance.ts";
import { TrustedLocalRunner, type CommandRunner } from "../runner.ts";
import { LinuxSandboxRunner } from "../sandbox.ts";
import { HabitatStore } from "../store.ts";
import { REPLAY_TTVO_MISSION, replayEvaluators, replayOrganism } from "./organism.ts";
import { ReplayTelemetrySource } from "./telemetry.ts";

/** Where the Replay organism is. Paths are relative to the Habitat checkout unless absolute. */
const ReplayEnv = z.object({
  REPLAY_REPOSITORY: z.string().min(1).default("../ownr-replay"),
  REPLAY_BASELINE_REF: z.string().min(1).default("master"),
  /** The Replay's learning events (runtime data of the deployed baseline), opened read-only. Relative to the organism. */
  REPLAY_EVENTS_DB: z.string().min(1).default("repo-replay.sqlite"),
  REPLAY_PROPOSALS: z.string().min(1).default("proposals/replay"),
});

export type HabitatPaths = { root: string; database: string; worktrees: string; dependencies: string };
/** sandbox (default): candidates run isolated. trusted-local: on the host, only when every candidate is trusted. */
export type RunnerKind = "sandbox" | "trusted-local";

const M1_CONTENT = "data/golden/ops-triage-ai/stages/m1";

/** Wires the Replay organism into a Habitat. The core only ever sees the Organism, never "Replay". */
export async function createReplayHabitat(paths: HabitatPaths, runnerKind: RunnerKind, logger: Logger, options: { reviseMissionBy?: string } = {}, env: Record<string, string | undefined> = process.env) {
  const parsed = ReplayEnv.safeParse(env);
  if (!parsed.success) throw new Error("Invalid Replay organism configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const config = parsed.data;
  const repository = resolve(paths.root, config.REPLAY_REPOSITORY);
  const organism = replayOrganism(repository, config.REPLAY_BASELINE_REF);
  const git = new GitOrganism(organism.repositoryPath, organism.baselineRef);
  const store = new HabitatStore(paths.database);
  const runner = createRunner(runnerKind);
  // Evaluations never see the organism's own node_modules: each revision gets the tree its package.json + bun.lock determine.
  const dependencies = new HermeticDependencies(git, paths.dependencies);
  const workspace = new GitWorktreeWorkspace(repository, paths.worktrees, []);
  const environment = await ExecutionEnvironment.probe(runner, { tools: ["typescript"] }, dependencies);
  const { pathPolicy, evaluators } = replayEvaluators(organism, runner);
  // Telemetry only counts usage of the Module 1 content of the current baseline, from the moment it became
  // the baseline: a candidate commit exists before it is accepted, and usage before acceptance is of older content.
  const since = async (): Promise<number> => {
    const revision = await git.baselineRevision();
    const result = await runCommand(["git", "log", "-1", "--format=%ct", revision, "--", M1_CONTENT], { cwd: repository, timeoutMs: 30_000, env: minimalEnv() });
    if (result.exitCode !== 0) throw new Error(`git log falhou: ${result.stderr.trim().slice(0, 300)}`);
    const accepted = store.events(REPLAY_TTVO_MISSION.id, 1000).find((e) => e.kind === "baseline_advanced" && e.data?.to === revision);
    return Math.max(Number(result.stdout.trim()) * 1000, accepted?.createdAt ?? 0);
  };
  const habitat = new Habitat(
    {
      store,
      organism,
      mission: REPLAY_TTVO_MISSION,
      workspace,
      pathPolicy,
      evaluators,
      mutations: new DirectoryMutationProvider(resolve(paths.root, config.REPLAY_PROPOSALS)),
      telemetry: new ReplayTelemetrySource(resolve(repository, config.REPLAY_EVENTS_DB), since),
      repository: git,
      environment,
      dependencies,
      logger,
    },
    options,
  );
  return { habitat, store, workspace, organism, runner };
}

function createRunner(kind: RunnerKind): CommandRunner {
  if (kind === "trusted-local") return new TrustedLocalRunner();
  const reason = LinuxSandboxRunner.unavailable();
  // Never fall back silently: evidence from an unsandboxed run must be an explicit choice.
  if (reason) throw new Error(`sandbox indisponível (${reason}); use HABITAT_RUNNER=trusted-local só se todo candidate for confiável`);
  return new LinuxSandboxRunner(process.execPath);
}
