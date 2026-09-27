import type { Logger } from "./logger.ts";
import {
  ACCEPTABLE,
  fingerprint,
  type Candidate,
  type Decision,
  type EvaluationResult,
  type EvidenceBinding,
  type EvidenceContext,
  type Measurement,
  type Mission,
  type Organism,
  type Verdict,
} from "./domain.ts";
import { notRun } from "./evaluators.ts";
import type { CandidateWorkspace, Evaluator, MutationProposal, MutationProvider, TelemetrySource } from "./ports.ts";
import { decide, measurementsOf, missionProgress, staleReasons } from "./selection.ts";
import { sha256 } from "./identity.ts";
import type { HabitatStore, MissionRecord, Observation } from "./store.ts";

export type HabitatLogger = Logger;

export type HabitatDeps = {
  store: HabitatStore;
  organism: Organism;
  mission: Mission;
  workspace: CandidateWorkspace;
  /** Runs first; when it fails nothing else executes (the candidate touched what it must not). */
  pathPolicy: Evaluator;
  evaluators: Evaluator[];
  mutations: MutationProvider;
  telemetry?: TelemetrySource;
  /** Current revision of the organism (what is in use): the only baseline evidence may be about. */
  baselineRevision: () => Promise<string>;
  /** Makes an accepted candidate the new baseline. Must refuse unless the baseline is still `from`. */
  advanceBaseline: (from: string, to: string) => Promise<void>;
  logger: Logger;
};

export class HabitatBusyError extends Error {
  override readonly name = "HabitatBusyError";
}

/** A request that the evidence does not support (stale, not acceptable, baseline not observed). */
export class HabitatRefusal extends Error {
  override readonly name = "HabitatRefusal";
  constructor(
    readonly code: "STALE_EVIDENCE" | "NOT_ACCEPTABLE" | "BASELINE_NOT_OBSERVED" | "UNKNOWN",
    message: string,
  ) {
    super(message);
  }
}

export type CandidateAssessment = { verdict: Verdict | null; recordedVerdict: Verdict | null; stale: string[] };

/**
 * The closed loop: observe the baseline, turn proposals into isolated candidates, evaluate
 * them independently, decide, let a human accept one as the next baseline, observe again.
 * One job at a time: evaluations are heavy and must not interleave.
 */
export class Habitat {
  readonly mission: Mission;
  private readonly missionRecord: MissionRecord;
  private busy: string | null = null;

  constructor(
    private readonly deps: HabitatDeps,
    /** Set only by a human revising the mission; otherwise a changed definition is refused. */
    options: { reviseMissionBy?: string } = {},
  ) {
    this.missionRecord = options.reviseMissionBy ? deps.store.reviseMission(deps.mission, options.reviseMissionBy) : deps.store.ensureMission(deps.mission);
    this.mission = this.missionRecord.mission;
  }

  get running(): string | null {
    return this.busy;
  }

  /** The facts every piece of evidence is checked against right now. */
  async context(): Promise<EvidenceContext> {
    return {
      baselineRevision: await this.deps.baselineRevision(),
      missionId: this.mission.id,
      missionRevision: this.missionRecord.revision,
      missionHash: this.missionRecord.hash,
      envelopeHash: sha256(JSON.stringify(this.mission.envelope)),
      evaluators: [this.deps.pathPolicy, ...this.deps.evaluators].map(fingerprint).sort(),
    };
  }

  async observeBaseline(): Promise<{ observationId: string; evaluations: EvaluationResult[] }> {
    return this.exclusive("observe", async () => {
      const { store } = this.deps;
      const context = await this.context();
      const revision = context.baselineRevision;
      const observation = store.addObservation(this.mission.id, revision);
      const bind = (evaluator: string): EvidenceBinding => this.binding(context, revision, evaluator);
      // The baseline is measured in its own worktree too: the live checkout is never an evaluation target.
      const workspace = await this.deps.workspace.prepare(observation.id, revision);
      const evaluations: EvaluationResult[] = [];
      try {
        for (const evaluator of this.deps.evaluators) {
          const result = { ...(await this.safely(evaluator, { dir: workspace.dir, baselineRevision: revision, revision, changes: [] })), binding: bind(fingerprint(evaluator)) };
          store.addEvaluation("observation", observation.id, result);
          evaluations.push(result);
        }
      } finally {
        await this.deps.workspace.dispose(workspace);
      }
      const telemetry = { ...(await this.telemetry()), binding: bind(this.deps.telemetry ? fingerprint(this.deps.telemetry) : "telemetry@none") };
      store.addEvaluation("observation", observation.id, telemetry);
      evaluations.push(telemetry);
      store.record("observation_recorded", {
        missionId: this.mission.id,
        data: { observationId: observation.id, revision, measurements: evaluations.flatMap((e) => e.measurements).map((m) => `${m.metric}=${m.value ?? m.status}`) },
      });
      this.assessExperiment(observation, evaluations);
      this.deps.logger.info("observation_recorded", { observationId: observation.id, revision });
      return { observationId: observation.id, evaluations };
    });
  }

  /**
   * When the observed baseline is an accepted candidate, the experiment is judged by comparing this
   * observation with the one of the baseline it replaced — outcomes included, once they have data.
   */
  private assessExperiment(observation: Observation, evaluations: EvaluationResult[]): void {
    const { store } = this.deps;
    const accepted = store.candidates(this.mission.id).find((c) => c.status === "accepted" && c.revision === observation.revision);
    if (!accepted) return;
    const previous = store.latestObservation(this.mission.id, accepted.parentRevision);
    if (!previous) return;
    // Observations do not re-run the path policy: the accepted candidate's own result is about this same revision.
    const policy = store.evaluations("candidate", accepted.id).filter((e) => e.evaluatorId === this.deps.pathPolicy.id && e.binding?.subjectRevision === observation.revision);
    const decision = decide(this.mission, store.evaluations("observation", previous.id), [...policy, ...evaluations]);
    store.saveAssessment(observation.id, accepted.id, decision);
    store.record("experiment_assessed", {
      missionId: this.mission.id,
      candidateId: accepted.id,
      data: { observationId: observation.id, previousObservationId: previous.id, verdict: decision.verdict, reasons: decision.reasons },
    });
  }

  async proposals(): Promise<MutationProposal[]> {
    return this.deps.mutations.propose();
  }

  /** proposal → isolated candidate → independent evaluation → decision. Never touches the baseline. */
  async evolve(proposalId: string): Promise<{ candidate: Candidate; decision: Decision }> {
    return this.exclusive(`evolve:${proposalId}`, async () => {
      const proposal = (await this.deps.mutations.propose()).find((p) => p.id === proposalId);
      if (!proposal) throw new HabitatRefusal("UNKNOWN", `unknown proposal ${proposalId}`);
      return this.runCandidate(proposal, null);
    });
  }

  /** The same change, replayed onto the current baseline and judged again from scratch. */
  async reevaluate(candidateId: string): Promise<{ candidate: Candidate; decision: Decision }> {
    return this.exclusive(`reevaluate:${candidateId}`, async () => {
      const old = this.deps.store.candidate(candidateId);
      if (!old?.revision) throw new HabitatRefusal("UNKNOWN", `candidate ${candidateId} has no evaluated revision`);
      const patch = await this.deps.workspace.patchBetween(old.parentRevision, old.revision);
      const { claims } = old;
      return this.runCandidate({ id: old.proposalId, hypothesis: old.hypothesis, source: old.source, patch, ...(claims === null ? {} : { claims }) }, old.id);
    });
  }

  private async runCandidate(proposal: MutationProposal, reevaluationOf: string | null): Promise<{ candidate: Candidate; decision: Decision }> {
    const { store } = this.deps;
    const context = await this.context();
    const { observation, evaluations: baselineEvaluations } = this.currentBaseline(context);
    const parentGeneration = await this.baselineGeneration(context.baselineRevision);

    const candidate = store.addCandidate({
      id: `cand-${crypto.randomUUID().slice(0, 8)}`,
      missionId: this.mission.id,
      proposalId: proposal.id,
      generation: parentGeneration + 1,
      parentRevision: context.baselineRevision,
      hypothesis: proposal.hypothesis,
      source: proposal.source,
      claims: proposal.claims ?? null,
      reevaluationOf,
    });
    store.record(reevaluationOf ? "candidate_reevaluation_started" : "candidate_proposed", {
      missionId: this.mission.id,
      candidateId: candidate.id,
      data: { proposalId: proposal.id, generation: candidate.generation, parentRevision: context.baselineRevision, reevaluationOf, hypothesis: proposal.hypothesis, source: proposal.source, claims: proposal.claims ?? null },
    });

    const workspace = await this.deps.workspace.prepare(candidate.id, context.baselineRevision);
    let decision: Decision;
    try {
      let mutated;
      try {
        mutated = await this.deps.workspace.mutate(workspace, proposal.patch, `habitat candidate ${candidate.id}: ${proposal.hypothesis.slice(0, 60)}`);
      } catch (error) {
        store.updateCandidate(candidate.id, { status: "failed" });
        store.record("candidate_failed", { missionId: this.mission.id, candidateId: candidate.id, data: { reason: `patch não se aplica à baseline: ${String(error)}` } });
        throw error;
      }
      await this.deps.workspace.retain(candidate.id, mutated.revision);
      store.updateCandidate(candidate.id, { status: "prepared", revision: mutated.revision });
      store.addChanges(candidate.id, mutated.changes);
      store.record("candidate_prepared", { missionId: this.mission.id, candidateId: candidate.id, data: { revision: mutated.revision, files: mutated.changes.map((c) => `${c.status} ${c.path}`) } });

      store.updateCandidate(candidate.id, { status: "evaluating" });
      store.record("candidate_evaluation_started", { missionId: this.mission.id, candidateId: candidate.id });
      const evaluationContext = { dir: workspace.dir, baselineRevision: context.baselineRevision, revision: mutated.revision, changes: mutated.changes };
      const bind = (evaluator: Evaluator): EvidenceBinding => this.binding(context, mutated.revision, fingerprint(evaluator));
      const evaluations: EvaluationResult[] = [];
      const policy = { ...(await this.safely(this.deps.pathPolicy, evaluationContext)), binding: bind(this.deps.pathPolicy) };
      evaluations.push(policy);
      for (const evaluator of this.deps.evaluators) {
        // A candidate outside its allowed paths may have tampered with tests or evaluators: run none of its code.
        const result = policy.status === "PASS" ? await this.safely(evaluator, evaluationContext) : notRun(evaluator.id, "não executado: o candidate violou a política de caminhos");
        evaluations.push({ ...result, binding: bind(evaluator) });
      }
      evaluations.forEach((e) => store.addEvaluation("candidate", candidate.id, e));

      decision = {
        ...decide(this.mission, baselineEvaluations, evaluations),
        binding: {
          baselineRevision: context.baselineRevision,
          candidateRevision: mutated.revision,
          baselineObservationId: observation.id,
          missionId: context.missionId,
          missionRevision: context.missionRevision,
          missionHash: context.missionHash,
          envelopeHash: context.envelopeHash,
          evaluators: context.evaluators,
        },
      };
      store.saveDecision(candidate.id, decision);
      for (const c of decision.constraints.filter((x) => x.status !== "PASS")) {
        store.record("constraint_failed", { missionId: this.mission.id, candidateId: candidate.id, data: { constraint: c.name, severity: c.severity, status: c.status, detail: c.detail } });
      }
      store.updateCandidate(candidate.id, { status: "evaluated" });
      store.record("candidate_evaluation_finished", { missionId: this.mission.id, candidateId: candidate.id, data: { verdict: decision.verdict, warnings: decision.warnings, reasons: decision.reasons } });
      this.deps.logger.info("candidate_evaluated", { candidateId: candidate.id, verdict: decision.verdict });
    } finally {
      await this.deps.workspace.dispose(workspace);
    }
    const final = store.candidate(candidate.id);
    if (!final) throw new Error("candidate vanished");
    return { candidate: final, decision };
  }

  /** The newest accepted generation in the baseline's history (0 when no candidate was ever accepted into it). */
  private async baselineGeneration(baseline: string): Promise<number> {
    let generation = 0;
    for (const c of this.deps.store.candidates(this.mission.id)) {
      if (c.status === "accepted" && c.revision && c.generation > generation && (await this.deps.workspace.isAncestor(c.revision, baseline))) generation = c.generation;
    }
    return generation;
  }

  /** The recorded verdict, unless the evidence no longer describes the present — then STALE. */
  async assess(candidateId: string, context?: EvidenceContext): Promise<CandidateAssessment> {
    const { store } = this.deps;
    const decision = store.decision(candidateId);
    if (!decision) return { verdict: null, recordedVerdict: null, stale: [] };
    // An accepted candidate is part of the baseline's history, not a pending decision.
    if (store.candidate(candidateId)?.status === "accepted") return { verdict: decision.verdict, recordedVerdict: decision.verdict, stale: [] };
    const stale = staleReasons(decision.binding, store.evaluations("candidate", candidateId), context ?? (await this.context()));
    return { verdict: stale.length > 0 ? "STALE" : decision.verdict, recordedVerdict: decision.verdict, stale };
  }

  /**
   * A human act: the candidate becomes the new baseline. Only with current evidence and an
   * acceptable verdict. Never pushes or deploys; the next observation judges the experiment.
   */
  async accept(candidateId: string, by: string): Promise<{ from: string; to: string }> {
    return this.exclusive(`accept:${candidateId}`, async () => {
      const { store } = this.deps;
      const candidate = store.candidate(candidateId);
      if (!candidate?.revision) throw new HabitatRefusal("UNKNOWN", `unknown candidate ${candidateId}`);
      const { verdict, stale } = await this.assess(candidateId);
      if (stale.length > 0) throw new HabitatRefusal("STALE_EVIDENCE", `evidência desatualizada — reavalie antes de aceitar: ${stale.join("; ")}`);
      if (candidate.status !== "evaluated" || !verdict || !ACCEPTABLE.has(verdict)) {
        throw new HabitatRefusal("NOT_ACCEPTABLE", `candidate ${candidateId} está ${verdict ?? candidate.status}; só ${[...ACCEPTABLE].join(", ")} pode virar baseline`);
      }
      await this.deps.advanceBaseline(candidate.parentRevision, candidate.revision);
      store.updateCandidate(candidateId, { status: "accepted" });
      store.record("candidate_accepted", { missionId: this.mission.id, candidateId, data: { by, verdict } });
      store.record("baseline_advanced", { missionId: this.mission.id, candidateId, data: { from: candidate.parentRevision, to: candidate.revision, by } });
      this.deps.logger.info("baseline_advanced", { candidateId, from: candidate.parentRevision, to: candidate.revision });
      return { from: candidate.parentRevision, to: candidate.revision };
    });
  }

  /** Where the organism stands: the latest baseline observation against the desired state. */
  progress() {
    const observation = this.deps.store.latestObservation(this.mission.id);
    const measurements = observation ? measurementsOf(this.deps.store.evaluations("observation", observation.id)) : new Map<string, Measurement>();
    return { observation, progress: missionProgress(this.mission, measurements) };
  }

  /** Candidates are only compared with an observation of the current baseline, made by the current evaluators. */
  private currentBaseline(context: EvidenceContext): { observation: Observation; evaluations: EvaluationResult[] } {
    const observation = this.deps.store.latestObservation(this.mission.id, context.baselineRevision);
    if (!observation) throw new HabitatRefusal("BASELINE_NOT_OBSERVED", `a baseline atual ${context.baselineRevision.slice(0, 10)} ainda não foi observada`);
    const evaluations = this.deps.store.evaluations("observation", observation.id);
    const current = new Set(context.evaluators);
    const outdated = evaluations.filter(
      (e) => e.evaluatorId !== "telemetry" && (!e.binding || e.binding.missionHash !== context.missionHash || e.binding.envelopeHash !== context.envelopeHash || !current.has(e.binding.evaluator)),
    );
    if (outdated.length > 0) throw new HabitatRefusal("BASELINE_NOT_OBSERVED", `a observação ${observation.id} usa missão ou avaliadores antigos (${outdated.map((e) => e.evaluatorId).join(", ")}); observe de novo`);
    return { observation, evaluations };
  }

  private binding(context: EvidenceContext, subjectRevision: string, evaluator: string): EvidenceBinding {
    return {
      baselineRevision: context.baselineRevision,
      subjectRevision,
      missionId: context.missionId,
      missionRevision: context.missionRevision,
      missionHash: context.missionHash,
      envelopeHash: context.envelopeHash,
      evaluator,
    };
  }

  private async telemetry(): Promise<EvaluationResult> {
    if (!this.deps.telemetry) return notRun("telemetry", "nenhuma fonte de telemetria configurada");
    const started = performance.now();
    const measurements = await this.deps.telemetry.measure();
    const insufficient = measurements.filter((m) => m.status === "INSUFFICIENT_DATA").length;
    return {
      evaluatorId: "telemetry",
      // Telemetry informs the mission; it is not a gate, so it reports what it saw rather than PASS/FAIL.
      status: "PASS",
      measurements,
      evidence: [{ kind: "report", summary: `${measurements.length} métricas de uso real, ${insufficient} sem dados suficientes` }],
      durationMs: Math.round(performance.now() - started),
      errors: [],
    };
  }

  /** An evaluator crash is a FAIL with the error as evidence, never an exception that skips the decision. */
  private async safely(evaluator: Evaluator, context: Parameters<Evaluator["evaluate"]>[0]): Promise<EvaluationResult> {
    try {
      return await evaluator.evaluate(context);
    } catch (error) {
      this.deps.logger.error("evaluator_crashed", { evaluatorId: evaluator.id, error: String(error) });
      return { evaluatorId: evaluator.id, status: "FAIL", measurements: [], evidence: [{ kind: "note", summary: "o avaliador falhou ao executar", detail: String(error) }], durationMs: 0, errors: [String(error)] };
    }
  }

  private async exclusive<T>(job: string, run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new HabitatBusyError(`Habitat is busy with ${this.busy}`);
    this.busy = job;
    try {
      return await run();
    } finally {
      this.busy = null;
    }
  }
}
