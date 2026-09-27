import { z } from "zod";
import type { Logger } from "./logger.ts";
import { HttpError, Router, json, readBody } from "./http/router.ts";
import type { Organism } from "./domain.ts";
import { HabitatBusyError, HabitatRefusal, type Habitat } from "./evolution.ts";
import type { GitWorktreeWorkspace } from "./git-workspace.ts";
import { missionReached } from "./selection.ts";
import type { HabitatStore } from "./store.ts";

export type HabitatDeps = {
  habitat: Habitat;
  store: HabitatStore;
  workspace: GitWorktreeWorkspace;
  organism: Organism;
  logger: Logger;
};

/** Everything the Cockpit's first screen needs, in one read. Verdicts are re-checked against the present. */
export async function snapshot({ habitat, store, organism }: Pick<HabitatDeps, "habitat" | "store" | "organism">) {
  const mission = habitat.mission;
  const context = await habitat.context();
  const { observation, progress } = habitat.progress();
  const candidates = await Promise.all(store.candidates(mission.id).map(async (c) => ({ ...c, ...(await habitat.assess(c.id, context)) })));
  const proposals = (await habitat.proposals()).map(({ patch, ...p }) => ({ ...p, patchLines: patch.split("\n").length, candidates: candidates.filter((c) => c.proposalId === p.id).map((c) => c.id) }));
  // Lineage: every baseline that was observed, oldest first, with the experiment verdict of the change that produced it.
  const baselines = store.observations(mission.id).reduce<{ revision: string; observationId: string; createdAt: number; acceptedCandidate: string | null; assessment: string | null }[]>((list, o) => {
    const assessment = store.assessment(o.id);
    const entry = { revision: o.revision, observationId: o.id, createdAt: o.createdAt, acceptedCandidate: assessment?.candidateId ?? null, assessment: assessment?.decision.verdict ?? null };
    const existing = list.findIndex((b) => b.revision === o.revision);
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
    return list;
  }, []);
  return {
    organism: { id: organism.id, name: organism.name, repositoryPath: organism.repositoryPath, baselineRef: organism.baselineRef, allowedPaths: organism.allowedPaths },
    mission: { ...mission, reached: missionReached(progress) },
    context,
    progress,
    baseline: observation ? { ...observation, current: observation.revision === context.baselineRevision, evaluations: store.evaluations("observation", observation.id) } : null,
    baselines,
    candidates,
    proposals,
    running: habitat.running,
  };
}

const Accept = z.strictObject({ by: z.string().trim().min(2).max(80) });
const Empty = z.strictObject({});

const REFUSAL_STATUS = { STALE_EVIDENCE: 409, NOT_ACCEPTABLE: 409, BASELINE_NOT_OBSERVED: 409, UNKNOWN: 404 } as const;

export function createHabitatApi(deps: HabitatDeps): Router {
  const { habitat, store, workspace, logger } = deps;

  /** Long jobs run in the background; the Cockpit polls. Failures become recorder events, never silence. */
  const start = (job: string, run: () => Promise<unknown>): Response => {
    if (habitat.running) throw new HttpError(409, "HABITAT_BUSY", `O Habitat já está executando ${habitat.running}.`);
    run().catch((error: unknown) => {
      logger.error("habitat_job_failed", { job, error: String(error) });
      store.record("job_failed", { missionId: habitat.mission.id, data: { job, error: String(error).slice(0, 500) } });
    });
    return json({ started: job }, 202);
  };

  const needCurrentBaseline = async (): Promise<void> => {
    const context = await habitat.context();
    if (!store.latestObservation(habitat.mission.id, context.baselineRevision)) {
      throw new HttpError(409, "BASELINE_NOT_OBSERVED", `A baseline atual ${context.baselineRevision.slice(0, 10)} ainda não foi observada.`);
    }
  };

  return new Router()
    .on("GET", "/api/state", async () => json(await snapshot(deps)))
    .on("POST", "/api/baseline/observe", async (req) => {
      await readBody(req, Empty);
      return start("observe", () => habitat.observeBaseline());
    })
    .on("POST", "/api/proposals/:id/candidate", async (req, { id = "" }) => {
      await readBody(req, Empty);
      if (!(await habitat.proposals()).some((p) => p.id === id)) throw new HttpError(404, "UNKNOWN_PROPOSAL", "Proposta não encontrada.");
      await needCurrentBaseline();
      return start(`evolve:${id}`, () => habitat.evolve(id));
    })
    .on("GET", "/api/candidates/:id", async (_req, { id = "" }) => {
      const candidate = store.candidate(id);
      if (!candidate) throw new HttpError(404, "UNKNOWN_CANDIDATE", "Candidate não encontrado.");
      const decision = store.decision(id) ?? null;
      const baselineId = decision?.binding?.baselineObservationId;
      return json({
        candidate,
        assessment: await habitat.assess(id),
        changes: store.changes(id),
        evaluations: store.evaluations("candidate", id),
        baselineEvaluations: baselineId ? store.evaluations("observation", baselineId) : [],
        decision,
        // The retained revision outlives the worktree: every candidate stays inspectable.
        diff: candidate.revision ? (await workspace.diff(candidate.parentRevision, candidate.revision)).slice(0, 200_000) : null,
        events: store.events(500).filter((e) => e.candidateId === id).reverse(),
      });
    })
    .on("POST", "/api/candidates/:id/reevaluate", async (req, { id = "" }) => {
      await readBody(req, Empty);
      if (!store.candidate(id)?.revision) throw new HttpError(404, "UNKNOWN_CANDIDATE", "Candidate não encontrado.");
      await needCurrentBaseline();
      return start(`reevaluate:${id}`, () => habitat.reevaluate(id));
    })
    .on("POST", "/api/candidates/:id/accept", async (req, { id = "" }) => {
      const { by } = await readBody(req, Accept);
      try {
        return json(await habitat.accept(id, by));
      } catch (error) {
        if (error instanceof HabitatRefusal) throw new HttpError(REFUSAL_STATUS[error.code], error.code, error.message);
        if (error instanceof HabitatBusyError) throw new HttpError(409, "HABITAT_BUSY", error.message);
        throw error;
      }
    })
    .on("GET", "/api/events", () => json({ events: store.events(300) }));
}
