import { z } from "zod";

/**
 * OWNR Habitat domain. The software is the evolving object: an Organism has a Mission
 * (desired measurable state), an Envelope it must never leave, and Candidates whose
 * fate is decided by independent evaluation — never by whoever produced them.
 */

// ---------------------------------------------------------------- measurements & checks

/** PASS/FAIL are verdicts of a check that ran; NOT_RUN means no evidence either way. */
export type CheckStatus = "PASS" | "FAIL" | "NOT_RUN";

export type Measurement = {
  metric: string;
  /** null when there is not enough data to state a value. */
  value: number | null;
  status: "MEASURED" | "INSUFFICIENT_DATA";
  unit?: string;
  /** For telemetry: how many observations the value rests on, and over which window. */
  sampleSize?: number;
  window?: string;
  note?: string;
};

export type Evidence = { kind: "command" | "files" | "report" | "note"; summary: string; detail?: string };

/** Which evaluator produced a result, and with which configuration: evidence from a different one is not comparable. */
export type EvaluatorIdentity = { id: string; version: string };
export const fingerprint = (e: EvaluatorIdentity): string => `${e.id}@${e.version}`;

/** What a piece of evidence is about. Evidence only counts for exactly this binding. */
export type EvidenceBinding = {
  baselineRevision: string;
  /** The revision that was evaluated (the baseline itself for observations). */
  subjectRevision: string;
  missionId: string;
  missionRevision: number;
  missionHash: string;
  envelopeHash: string;
  evaluator: string;
  /** Hash of the execution environment (runtime, runner/sandbox, dependencies) that produced the evidence. */
  environment: string;
};

/** A command as it was executed to produce evidence. */
export type CommandRecord = { argv: string[]; runner: string; exitCode: number | null; durationMs: number; timedOut: boolean; limit: "memory" | "pids" | null };

export type Provenance = {
  commands: CommandRecord[];
  /** Hash of the organism files that implement this measurement, at the evaluated revision (see Mission.evidence). */
  instrument?: string;
};

export type EvaluationResult = {
  evaluatorId: string;
  status: CheckStatus;
  measurements: Measurement[];
  evidence: Evidence[];
  durationMs: number;
  errors: string[];
  /** Attached by Habitat when the result is recorded; absent on legacy evidence (which is therefore stale). */
  binding?: EvidenceBinding;
  /** How the evidence was produced: commands run and the identity of the instrument that measured. */
  provenance?: Provenance;
};

// ---------------------------------------------------------------- mission, envelope, fitness

export const Operator = z.enum(["<=", ">=", "=="]);
export type Operator = z.infer<typeof Operator>;

export const DesiredMetric = z.strictObject({
  metric: z.string().min(1),
  label: z.string().min(1),
  operator: Operator,
  target: z.number(),
  unit: z.string().optional(),
  /** Telemetry-based targets need enough data before anyone may claim them. */
  minSampleSize: z.number().int().positive().optional(),
  window: z.string().optional(),
});
export type DesiredMetric = z.infer<typeof DesiredMetric>;

export const Constraint = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  severity: z.enum(["hard", "soft"]),
  evaluatorId: z.string().min(1),
  /** Without a metric the constraint follows the evaluator status; with one, the measurement must satisfy it. */
  metric: z.string().optional(),
  operator: Operator.optional(),
  threshold: z.number().optional(),
});
export type Constraint = z.infer<typeof Constraint>;

export const Envelope = z.strictObject({
  id: z.string().min(1),
  constraints: z.array(Constraint).min(1),
  /** Properties nobody checks yet — shown as NOT_RUN, never as passing. */
  uncovered: z.array(z.strictObject({ name: z.string(), reason: z.string() })),
});
export type Envelope = z.infer<typeof Envelope>;

/**
 * proxy: measurable on a candidate before anyone uses it (a hypothesis about the outcome).
 * outcome: only measurable in real use of a baseline, and only with enough samples.
 */
export const Objective = z.strictObject({
  metric: z.string().min(1),
  label: z.string().min(1),
  direction: z.enum(["minimize", "maximize"]),
  kind: z.enum(["proxy", "outcome"]),
  minSampleSize: z.number().int().positive().optional(),
});
export type Objective = z.infer<typeof Objective>;

/** Counter-metrics: an objective only counts if these still hold (anti-Goodhart). */
export const Guard = z.strictObject({
  metric: z.string().min(1),
  label: z.string().min(1),
  operator: Operator,
  threshold: z.number(),
  reason: z.string().min(1),
});
export type Guard = z.infer<typeof Guard>;

export const Fitness = z.strictObject({ objectives: z.array(Objective).min(1), guards: z.array(Guard) });
export type Fitness = z.infer<typeof Fitness>;

/**
 * Which evidence the Mission trusts. Raw measurements are not evidence: a metric counts only when it
 * comes from its declared source, and a comparison counts only when that source's instrument (the
 * organism files that implement the measurement) is byte-identical on both sides.
 */
export const EvidencePolicy = z.strictObject({
  /** metric → the only evaluator (or telemetry source) trusted to measure it. */
  sources: z.record(z.string().min(1), z.string().min(1)),
  /** source → organism files implementing its measurement. They must lie outside the organism's allowed paths. */
  instruments: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});
export type EvidencePolicy = z.infer<typeof EvidencePolicy>;

export const Mission = z
  .strictObject({
    id: z.string().min(1),
    organismId: z.string().min(1),
    objective: z.string().min(1),
    desiredState: z.array(DesiredMetric).min(1),
    fitness: Fitness,
    envelope: Envelope,
    evidence: EvidencePolicy,
    status: z.enum(["draft", "active", "paused", "reached", "failed"]),
  })
  .superRefine((mission, ctx) => {
    const referenced = [
      ...mission.desiredState.map((d) => d.metric),
      ...mission.fitness.objectives.map((o) => o.metric),
      ...mission.fitness.guards.map((g) => g.metric),
      ...mission.envelope.constraints.flatMap((c) => (c.metric ? [c.metric] : [])),
    ];
    for (const metric of new Set(referenced)) {
      if (!mission.evidence.sources[metric]) ctx.addIssue({ code: "custom", path: ["evidence", "sources", metric], message: `metric ${metric} has no trusted source` });
    }
    for (const c of mission.envelope.constraints) {
      if (c.metric && mission.evidence.sources[c.metric] !== c.evaluatorId) ctx.addIssue({ code: "custom", path: ["envelope", c.id], message: `constraint ${c.id} reads ${c.metric} from ${c.evaluatorId}, but its trusted source is ${mission.evidence.sources[c.metric]}` });
    }
  });
export type Mission = z.infer<typeof Mission>;

export type Organism = {
  id: string;
  name: string;
  /** Its own git repository, outside Habitat (the control plane never evaluates in place). */
  repositoryPath: string;
  /** The ref naming the baseline (e.g. "master"); the baseline revision is always rev-parse of it. */
  baselineRef: string;
  /** Paths candidates may change; everything else (tests, instruments, sources) is protected. */
  allowedPaths: string[];
};

// ---------------------------------------------------------------- candidates & decisions

/** Lifecycle only. What the evidence says is the Verdict, which can go STALE after the fact. */
export type CandidateStatus = "proposed" | "prepared" | "evaluating" | "evaluated" | "failed" | "accepted";

export type CandidateSource = { kind: "manual" | "llm" | "rule" | "search"; author: string };

export type Candidate = {
  id: string;
  missionId: string;
  proposalId: string;
  generation: number;
  parentRevision: string;
  revision: string | null;
  hypothesis: string;
  source: CandidateSource;
  /** What the producer said about its own change. Information, never evidence. */
  claims: string | null;
  status: CandidateStatus;
  /** A re-evaluation of an earlier candidate's change against a newer baseline. */
  reevaluationOf: string | null;
  createdAt: number;
};

export type FileChange = { path: string; status: string; oldMode: string; newMode: string };

/**
 * Ordered by the strength of the evidence. A candidate evaluated offline can reach at most
 * EXPERIMENT_READY: better proxies are a hypothesis about the mission, not an improvement of it.
 * OUTCOME_IMPROVED and MISSION_MET need outcome measurements with enough samples.
 */
export const VERDICTS = ["INELIGIBLE", "STALE", "REGRESSED", "TRADEOFF", "NEUTRAL", "PROXY_IMPROVED", "EXPERIMENT_READY", "OUTCOME_IMPROVED", "MISSION_MET"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** Verdicts a human may accept as the next baseline. */
export const ACCEPTABLE: ReadonlySet<Verdict> = new Set(["EXPERIMENT_READY", "OUTCOME_IMPROVED", "MISSION_MET"]);

export type ConstraintResult = { constraintId: string; name: string; severity: "hard" | "soft"; status: CheckStatus; detail: string };

export type MetricComparison = {
  metric: string;
  label: string;
  kind: "proxy" | "outcome";
  direction: "minimize" | "maximize";
  baseline: number | null;
  candidate: number | null;
  /**
   * insufficient_data: an outcome whose sample is below the objective's minimum on either side.
   * untrusted: the instrument that measures it differs between the two sides, so the values are not comparable.
   */
  outcome: "improved" | "worse" | "unchanged" | "unknown" | "insufficient_data" | "untrusted";
};

export type GuardResult = Guard & { value: number | null; status: CheckStatus };

/** What a decision was made about; if any of it is no longer current, the decision is STALE. */
export type DecisionBinding = {
  baselineRevision: string;
  candidateRevision: string;
  baselineObservationId: string;
  missionId: string;
  missionRevision: number;
  missionHash: string;
  envelopeHash: string;
  /** Sorted fingerprints of the evaluators whose evidence the decision used. */
  evaluators: string[];
  /** Execution environment of both sides of the comparison (they must be the same). */
  environment: string;
};

/** The facts a binding is checked against right now. */
export type EvidenceContext = Omit<DecisionBinding, "candidateRevision" | "baselineObservationId">;

export type Decision = {
  verdict: Verdict;
  /** Metrics stay a vector: no single fitness score, trade-offs are explicit in comparisons. */
  constraints: ConstraintResult[];
  comparisons: MetricComparison[];
  guards: GuardResult[];
  /** SOFT violations: shown, never a reason to consider a candidate better. */
  warnings: string[];
  /** Every reason points at evidence (a constraint, a comparison, a guard or the binding). */
  reasons: string[];
  binding: DecisionBinding | null;
};

export type DesiredStatus = DesiredMetric & { value: number | null; sampleSize?: number; status: "MET" | "NOT_MET" | "INSUFFICIENT_DATA" };
