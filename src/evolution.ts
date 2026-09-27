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
import { pathAllowed } from "./evaluators.ts";
import type { CandidateWorkspace, DependencyProvider, DependencyTree, Evaluator, MutationProposal, MutationProvider, OrganismRepository, TelemetrySource } from "./ports.ts";
import type { Environment } from "./provenance.ts";
import { decide, measurementsOf, missionProgress, staleReasons } from "./selection.ts";
import { sha256 } from "./identity.ts";
import { HabitatBusyError, JobLock } from "./job-lock.ts";
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
  /** The organism's own repository: its baseline (what is in use) and read access to its content. */
  repository: OrganismRepository;
  /** Identity of the execution environment for a revision (runtime, runner/sandbox, dependencies). */
  environment: { at(revision: string): Promise<Environment> };
  /** Hermetic dependency trees, determined by each revision's manifests. Absent for organisms without dependencies. */
  dependencies?: DependencyProvider;
  logger: Logger;
};

export { HabitatBusyError };

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
  private readonly lock: JobLock;

  constructor(
    private readonly deps: HabitatDeps,
    /** Set only by a human revising the mission; otherwise a changed definition is refused. */
    options: { reviseMissionBy?: string } = {},
  ) {
    this.missionRecord = options.reviseMissionBy ? deps.store.reviseMission(deps.mission, options.reviseMissionBy) : deps.store.ensureMission(deps.mission);
    this.mission = this.missionRecord.mission;
    this.lock = new JobLock(deps.store, `job:${this.mission.id}`);
    const problems = configurationProblems(deps, this.mission);
    if (problems.length > 0) throw new Error(`configuração do Habitat recusada:\n- ${problems.join("\n- ")}`);
  }

  /** The job running for this mission right now — in this instance or in any other process sharing the recorder. */
  get running(): string | null {
    return this.busy ?? this.lock.current();
  }

  /** The facts every piece of evidence is checked against right now. */
  async context(): Promise<EvidenceContext> {
    const baselineRevision = await this.deps.repository.baselineRevision();
    const environment = await this.deps.environment.at(baselineRevision);
    this.deps.store.saveEnvironment(environment);
    return {
      baselineRevision,
      missionId: this.mission.id,
      missionRevision: this.missionRecord.revision,
      missionHash: this.missionRecord.hash,
      envelopeHash: sha256(JSON.stringify(this.mission.envelope)),
      evaluators: [this.deps.pathPolicy, ...this.deps.evaluators].map(fingerprint).sort(),
      environment: environment.hash,
    };
  }

  async observeBaseline(): Promise<{ observationId: string; evaluations: EvaluationResult[] }> {
    return this.exclusive("observe", async () => {
      const { store } = this.deps;
      const tree = await this.prepareDependencies(await this.deps.repository.baselineRevision());
      const context = await this.context();
      const revision = context.baselineRevision;
      // The baseline is measured in its own worktree too: the live checkout is never an evaluation target.
      const workspace = await this.deps.workspace.prepare(`obs-${crypto.randomUUID().slice(0, 8)}`, revision);
      const evaluations: EvaluationResult[] = [];
      try {
        for (const evaluator of this.deps.evaluators) {
          evaluations.push(await this.seal(await this.safely(evaluator, { dir: workspace.dir, dependencies: tree?.dir ?? null, baselineRevision: revision, revision, changes: [] }), evaluator, context, revision));
        }
      } finally {
        await this.deps.workspace.dispose(workspace);
      }
      // Evidence produced with a tree that changed underneath it is not recorded at all.
      await this.verifyDependencies(tree, null);
      const observation = store.addObservation(this.mission.id, revision);
      evaluations.forEach((e) => store.addEvaluation("observation", observation.id, e));
      const telemetry = await this.seal(await this.telemetry(), this.deps.telemetry ?? { id: "telemetry", version: "none" }, context, revision);
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
      const old = this.ownCandidate(candidateId);
      if (!old?.revision) throw new HabitatRefusal("UNKNOWN", `candidate ${candidateId} has no evaluated revision`);
      const patch = await this.deps.workspace.patchBetween(old.parentRevision, old.revision);
      const { claims } = old;
      return this.runCandidate({ id: old.proposalId, hypothesis: old.hypothesis, source: old.source, patch, ...(claims === null ? {} : { claims }) }, old.id);
    });
  }

  private async runCandidate(proposal: MutationProposal, reevaluationOf: string | null): Promise<{ candidate: Candidate; decision: Decision }> {
    const { store } = this.deps;
    const tree = await this.prepareDependencies(await this.deps.repository.baselineRevision());
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
      const evaluationContext = { dir: workspace.dir, dependencies: tree?.dir ?? null, baselineRevision: context.baselineRevision, revision: mutated.revision, changes: mutated.changes };
      // The candidate runs with the baseline's tree; a candidate whose manifests differ would need another one.
      const candidateLock = tree && this.deps.dependencies ? (await this.deps.dependencies.identify(mutated.revision)).lockfile : null;
      const sameDependencies = !tree || candidateLock === tree.lockfile;
      const evaluations: EvaluationResult[] = [];
      const policy = await this.seal(await this.safely(this.deps.pathPolicy, evaluationContext), this.deps.pathPolicy, context, mutated.revision);
      evaluations.push(policy);
      for (const evaluator of this.deps.evaluators) {
        // A candidate outside its allowed paths may have tampered with tests or instruments: run none of its code.
        const result =
          policy.status !== "PASS"
            ? notRun(evaluator.id, "não executado: o candidate violou a política de caminhos")
            : !sameDependencies
              ? notRun(evaluator.id, "não executado: o candidate altera as dependências (manifestos diferentes da baseline)")
              : await this.safely(evaluator, evaluationContext);
        evaluations.push(await this.seal(result, evaluator, context, mutated.revision));
      }
      await this.verifyDependencies(tree, candidate.id);
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
          environment: context.environment,
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
    if (!this.ownCandidate(candidateId)) return { verdict: null, recordedVerdict: null, stale: [] };
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
      const candidate = this.ownCandidate(candidateId);
      if (!candidate?.revision) throw new HabitatRefusal("UNKNOWN", `unknown candidate ${candidateId}`);
      const { verdict, stale } = await this.assess(candidateId);
      if (stale.length > 0) throw new HabitatRefusal("STALE_EVIDENCE", `evidência desatualizada — reavalie antes de aceitar: ${stale.join("; ")}`);
      if (candidate.status !== "evaluated" || !verdict || !ACCEPTABLE.has(verdict)) {
        throw new HabitatRefusal("NOT_ACCEPTABLE", `candidate ${candidateId} está ${verdict ?? candidate.status}; só ${[...ACCEPTABLE].join(", ")} pode virar baseline`);
      }
      await this.deps.repository.advanceBaseline(candidate.parentRevision, candidate.revision);
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
    const measurements = observation ? measurementsOf(this.deps.store.evaluations("observation", observation.id), this.mission.evidence) : new Map<string, Measurement>();
    return { observation, progress: missionProgress(this.mission, measurements) };
  }

  /** Candidates are only compared with an observation of the current baseline, made by the current evaluators. */
  private currentBaseline(context: EvidenceContext): { observation: Observation; evaluations: EvaluationResult[] } {
    const observation = this.deps.store.latestObservation(this.mission.id, context.baselineRevision);
    if (!observation) throw new HabitatRefusal("BASELINE_NOT_OBSERVED", `a baseline atual ${context.baselineRevision.slice(0, 10)} ainda não foi observada`);
    const evaluations = this.deps.store.evaluations("observation", observation.id);
    const current = new Set(context.evaluators);
    const outdated = evaluations.filter(
      (e) =>
        !e.binding ||
        e.binding.missionHash !== context.missionHash ||
        e.binding.envelopeHash !== context.envelopeHash ||
        e.binding.environment !== context.environment ||
        (e.evaluatorId !== "telemetry" && !current.has(e.binding.evaluator)),
    );
    if (outdated.length > 0) throw new HabitatRefusal("BASELINE_NOT_OBSERVED", `a observação ${observation.id} usa missão ou avaliadores antigos (${outdated.map((e) => e.evaluatorId).join(", ")}) ou outro ambiente de execução; observe de novo`);
    return { observation, evaluations };
  }

  /**
   * Binds a result to what it is about (baseline, evaluated revision, mission, envelope, evaluator
   * identity, execution environment) and records the identity of the instrument that measured it:
   * the content of the organism files the Mission declares for that source, at that revision.
   */
  private async seal(result: EvaluationResult, evaluator: { id: string; version: string }, context: EvidenceContext, subjectRevision: string): Promise<EvaluationResult> {
    const paths = this.mission.evidence.instruments[evaluator.id];
    const instrument = paths ? await this.deps.repository.contentHash(subjectRevision, paths) : undefined;
    return {
      ...result,
      binding: this.binding(context, subjectRevision, fingerprint(evaluator)),
      provenance: { commands: result.provenance?.commands ?? [], ...(instrument ? { instrument } : {}) },
    };
  }

  /** The tree the revision's manifests determine, built or re-verified before any evaluation uses it. */
  private async prepareDependencies(revision: string): Promise<DependencyTree | null> {
    if (!this.deps.dependencies) return null;
    const tree = await this.deps.dependencies.ensure(revision);
    if (tree.rebuilt) {
      this.deps.store.record(tree.rebuilt === "tampered" ? "dependencies_rebuilt_after_tampering" : "dependencies_built", { missionId: this.mission.id, data: { lockfile: tree.lockfile, tree: tree.tree } });
    }
    return tree;
  }

  /** After evaluation: the tree must be exactly what it was, or nothing evaluated with it counts. */
  private async verifyDependencies(tree: DependencyTree | null, candidateId: string | null): Promise<void> {
    if (!tree || !this.deps.dependencies) return;
    try {
      await this.deps.dependencies.verify(tree);
    } catch (error) {
      if (candidateId) this.deps.store.updateCandidate(candidateId, { status: "failed" });
      this.deps.store.record("dependencies_changed_during_evaluation", { missionId: this.mission.id, ...(candidateId ? { candidateId } : {}), data: { lockfile: tree.lockfile, error: String(error) } });
      throw error;
    }
  }

  /** Candidates of other missions (other organisms sharing the recorder) do not exist for this Habitat. */
  private ownCandidate(candidateId: string): Candidate | undefined {
    const candidate = this.deps.store.candidate(candidateId);
    return candidate?.missionId === this.mission.id ? candidate : undefined;
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
      environment: context.environment,
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
    const lease = this.lock.acquire(job, this.mission.id);
    this.busy = job;
    try {
      return await run();
    } finally {
      this.busy = null;
      lease.release();
    }
  }
}

/**
 * A Habitat refuses to start when its configuration would let evidence be forged: the mission must
 * belong to this organism, every trusted source must exist, and no instrument may be editable by candidates.
 */
function configurationProblems(deps: HabitatDeps, mission: Mission): string[] {
  const problems: string[] = [];
  if (mission.organismId !== deps.organism.id) problems.push(`a missão ${mission.id} é do organismo ${mission.organismId}, não de ${deps.organism.id}`);
  const known = new Set([deps.pathPolicy.id, ...deps.evaluators.map((e) => e.id), ...(deps.telemetry ? [deps.telemetry.id] : [])]);
  for (const [metric, source] of Object.entries(mission.evidence.sources)) if (!known.has(source)) problems.push(`fonte ${source} de ${metric} não existe neste Habitat`);
  for (const [source, paths] of Object.entries(mission.evidence.instruments)) {
    for (const path of paths) if (pathAllowed(deps.organism.allowedPaths, path)) problems.push(`o instrumento de ${source} (${path}) está dentro dos caminhos que candidates podem alterar`);
  }
  return problems;
}
