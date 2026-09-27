import { resolve } from "node:path";
import { z } from "zod";
import { minimalEnv, runCommand } from "../command.ts";
import { Habitat } from "../evolution.ts";
import { GitOrganism, GitWorktreeWorkspace } from "../git-workspace.ts";
import type { Logger } from "../logger.ts";
import { DirectoryMutationProvider } from "../proposals.ts";
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

export type HabitatPaths = { root: string; database: string; worktrees: string };

const M1_CONTENT = "data/golden/ops-triage-ai/stages/m1";

/** Wires the Replay organism into a Habitat. The core only ever sees the Organism, never "Replay". */
export function createReplayHabitat(paths: HabitatPaths, logger: Logger, options: { reviseMissionBy?: string } = {}, env: Record<string, string | undefined> = process.env) {
  const parsed = ReplayEnv.safeParse(env);
  if (!parsed.success) throw new Error("Invalid Replay organism configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const config = parsed.data;
  const repository = resolve(paths.root, config.REPLAY_REPOSITORY);
  const organism = replayOrganism(repository, config.REPLAY_BASELINE_REF);
  const git = new GitOrganism(organism.repositoryPath, organism.baselineRef);
  const store = new HabitatStore(paths.database);
  const workspace = new GitWorktreeWorkspace(repository, paths.worktrees);
  const { pathPolicy, evaluators } = replayEvaluators(organism);
  // Telemetry only counts usage of the Module 1 content of the current baseline.
  const since = async (): Promise<number> => {
    const result = await runCommand(["git", "log", "-1", "--format=%ct", await git.baselineRevision(), "--", M1_CONTENT], { cwd: repository, timeoutMs: 30_000, env: minimalEnv() });
    if (result.exitCode !== 0) throw new Error(`git log falhou: ${result.stderr.trim().slice(0, 300)}`);
    return Number(result.stdout.trim()) * 1000;
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
      baselineRevision: () => git.baselineRevision(),
      advanceBaseline: (from, to) => git.advanceBaseline(from, to),
      logger,
    },
    options,
  );
  return { habitat, store, workspace, organism };
}
