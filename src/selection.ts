import type {
  CheckStatus,
  Constraint,
  ConstraintResult,
  Decision,
  DecisionBinding,
  DesiredStatus,
  EvaluationResult,
  EvidenceContext,
  Fitness,
  GuardResult,
  Measurement,
  MetricComparison,
  Mission,
  Operator,
  Envelope,
  EvidencePolicy,
  Verdict,
} from "./domain.ts";

/**
 * Selection: the pure rules that decide what survives. No I/O, no clock, no model —
 * the same evidence always yields the same decision. There is no single fitness score:
 * every objective is compared on its own and trade-offs stay visible.
 */

export function satisfies(value: number, operator: Operator, target: number): boolean {
  if (operator === "<=") return value <= target;
  if (operator === ">=") return value >= target;
  return value === target;
}

/**
 * The measurements the Mission trusts: a metric counts only when its declared source produced it.
 * The same metric emitted by any other evaluator (an organism instrument, a candidate's output) is ignored.
 */
export function measurementsOf(evaluations: EvaluationResult[], policy: Pick<EvidencePolicy, "sources">): Map<string, Measurement> {
  const map = new Map<string, Measurement>();
  for (const evaluation of evaluations) {
    for (const m of evaluation.measurements) if (policy.sources[m.metric] === evaluation.evaluatorId) map.set(m.metric, m);
  }
  return map;
}

/** Measurements of Mission metrics that came from somewhere other than their trusted source. */
export function untrustedMeasurements(evaluations: EvaluationResult[], policy: Pick<EvidencePolicy, "sources">): string[] {
  return evaluations.flatMap((e) =>
    e.measurements.filter((m) => policy.sources[m.metric] !== undefined && policy.sources[m.metric] !== e.evaluatorId).map((m) => `${m.metric} emitida por ${e.evaluatorId} (fonte confiável: ${policy.sources[m.metric]})`),
  );
}

export function checkEnvelope(envelope: Envelope, evaluations: EvaluationResult[], policy: Pick<EvidencePolicy, "sources">): ConstraintResult[] {
  const byEvaluator = new Map(evaluations.map((e) => [e.evaluatorId, e]));
  const measurements = measurementsOf(evaluations, policy);
  return envelope.constraints.map((c) => checkConstraint(c, byEvaluator.get(c.evaluatorId), measurements));
}

function checkConstraint(constraint: Constraint, evaluation: EvaluationResult | undefined, measurements: Map<string, Measurement>): ConstraintResult {
  const base = { constraintId: constraint.id, name: constraint.name, severity: constraint.severity };
  if (!evaluation || evaluation.status === "NOT_RUN") {
    return { ...base, status: "NOT_RUN", detail: evaluation?.errors[0] ?? `avaliador ${constraint.evaluatorId} não executou` };
  }
  if (constraint.metric && constraint.operator && constraint.threshold !== undefined) {
    const m = measurements.get(constraint.metric);
    if (!m || m.value === null) return { ...base, status: "NOT_RUN", detail: `sem medida para ${constraint.metric}` };
    const ok = satisfies(m.value, constraint.operator, constraint.threshold);
    return { ...base, status: ok ? "PASS" : "FAIL", detail: `${constraint.metric} = ${m.value} (esperado ${constraint.operator} ${constraint.threshold})` };
  }
  return { ...base, status: evaluation.status, detail: evaluation.status === "PASS" ? "passou" : (evaluation.errors[0] ?? "falhou") };
}

export function checkGuards(fitness: Fitness, measurements: Map<string, Measurement>): GuardResult[] {
  return fitness.guards.map((g) => {
    const m = measurements.get(g.metric);
    const value = m?.value ?? null;
    const status: CheckStatus = value === null ? "NOT_RUN" : satisfies(value, g.operator, g.threshold) ? "PASS" : "FAIL";
    return { ...g, value, status };
  });
}

/** An outcome value only counts with enough samples; otherwise nobody may claim it moved. */
const enough = (m: Measurement | undefined, min: number | undefined): boolean =>
  m !== undefined && m.status === "MEASURED" && m.value !== null && (min === undefined || (m.sampleSize ?? 0) >= min);

/** The instrument hash each side's source reported; a comparison needs the same instrument on both sides. */
const instrumentOf = (evaluations: EvaluationResult[], source: string | undefined): string | undefined => evaluations.find((e) => e.evaluatorId === source)?.provenance?.instrument;

export function compareObjectives(
  fitness: Fitness,
  policy: EvidencePolicy,
  baseline: EvaluationResult[],
  candidate: EvaluationResult[],
): MetricComparison[] {
  const before = measurementsOf(baseline, policy);
  const after = measurementsOf(candidate, policy);
  return fitness.objectives.map((o) => {
    const source = policy.sources[o.metric];
    if (source && policy.instruments[source]) {
      const a = instrumentOf(baseline, source);
      const b = instrumentOf(candidate, source);
      const values = { metric: o.metric, label: o.label, kind: o.kind, direction: o.direction, baseline: before.get(o.metric)?.value ?? null, candidate: after.get(o.metric)?.value ?? null };
      // Values measured by different instruments (or by an unidentified one) are not comparable.
      if (values.baseline !== null && values.candidate !== null && (!a || !b || a !== b)) return { ...values, outcome: "untrusted" as const };
    }
    return compareOne(o, before, after);
  });
}

function compareOne(o: Fitness["objectives"][number], baseline: Map<string, Measurement>, candidate: Map<string, Measurement>): MetricComparison {
  const b = baseline.get(o.metric);
  const c = candidate.get(o.metric);
  const before = b?.value ?? null;
  const after = c?.value ?? null;
  const base = { metric: o.metric, label: o.label, kind: o.kind, direction: o.direction, baseline: before, candidate: after };
  if (o.kind === "outcome" && !(enough(b, o.minSampleSize) && enough(c, o.minSampleSize))) return { ...base, outcome: "insufficient_data" };
  if (before === null || after === null) return { ...base, outcome: "unknown" };
  const better = o.direction === "minimize" ? after < before : after > before;
  const worse = o.direction === "minimize" ? after > before : after < before;
  return { ...base, outcome: better ? "improved" : worse ? "worse" : "unchanged" };
}

/**
 * 1. A HARD constraint that failed or did not run ⇒ INELIGIBLE, whatever the fitness.
 * 2. A protected metric (guard) that broke ⇒ REGRESSED; one that could not be measured blocks like a HARD check.
 * 3. Objectives, compared one by one: something worse and something better ⇒ TRADEOFF; only worse ⇒ REGRESSED.
 * 4. Outcomes improved with enough data ⇒ OUTCOME_IMPROVED, or MISSION_MET when every desired metric is met.
 * 5. Nothing improved ⇒ NEUTRAL.
 * 6. Only proxies improved ⇒ EXPERIMENT_READY when the envelope is fully green and every proxy was compared,
 *    PROXY_IMPROVED otherwise. SOFT violations are warnings: they never make a candidate better.
 */
export function decide(mission: Pick<Mission, "envelope" | "fitness" | "desiredState" | "evidence">, baseline: EvaluationResult[], candidate: EvaluationResult[]): Decision {
  const policy = mission.evidence;
  const constraints = checkEnvelope(mission.envelope, candidate, policy);
  const candidateMeasurements = measurementsOf(candidate, policy);
  const guards = checkGuards(mission.fitness, candidateMeasurements);
  const comparisons = compareObjectives(mission.fitness, policy, baseline, candidate);
  const warnings = constraints.filter((c) => c.severity === "soft" && c.status !== "PASS").map((c) => `SOFT ${c.name}: ${c.status} — ${c.detail}`);
  const reasons: string[] = untrustedMeasurements(candidate, policy).map((m) => `medida não confiável ignorada: ${m}`);
  const result = (verdict: Verdict): Decision => ({ verdict, constraints, comparisons, guards, warnings, reasons, binding: null });

  const hardBlocked = constraints.filter((c) => c.severity === "hard" && c.status !== "PASS");
  const unmeasuredGuards = guards.filter((g) => g.status === "NOT_RUN");
  if (hardBlocked.length > 0 || unmeasuredGuards.length > 0) {
    for (const c of hardBlocked) reasons.push(`HARD ${c.name}: ${c.status} — ${c.detail}`);
    for (const g of unmeasuredGuards) reasons.push(`métrica protegida sem medida: ${g.label}`);
    return result("INELIGIBLE");
  }

  const brokenGuards = guards.filter((g) => g.status === "FAIL");
  for (const g of brokenGuards) reasons.push(`métrica protegida ${g.label}: ${g.value} (exigido ${g.operator} ${g.threshold}) — ${g.reason}`);
  for (const c of comparisons) reasons.push(`${c.kind === "outcome" ? "outcome" : "proxy"} ${c.label}: ${c.baseline ?? "?"} → ${c.candidate ?? "?"} (${c.outcome})`);
  if (brokenGuards.length > 0) return result("REGRESSED");

  const improved = comparisons.filter((c) => c.outcome === "improved");
  const worse = comparisons.filter((c) => c.outcome === "worse");
  if (worse.length > 0) return result(improved.length > 0 ? "TRADEOFF" : "REGRESSED");

  if (improved.some((c) => c.kind === "outcome")) {
    return result(missionProgress(mission, candidateMeasurements).every((p) => p.status === "MET") ? "MISSION_MET" : "OUTCOME_IMPROVED");
  }
  if (improved.length === 0) return result("NEUTRAL");

  const unknownProxies = comparisons.filter((c) => c.kind === "proxy" && (c.outcome === "unknown" || c.outcome === "untrusted"));
  for (const c of unknownProxies) reasons.push(`proxy sem comparação: ${c.label}`);
  if (warnings.length > 0 || unknownProxies.length > 0) return result("PROXY_IMPROVED");
  const pending = comparisons.filter((c) => c.outcome === "insufficient_data" || c.outcome === "untrusted");
  if (pending.length > 0) reasons.push(`outcomes ainda sem dados suficientes (${pending.map((c) => c.label).join(", ")}): só um experimento em uso real pode confirmar`);
  return result("EXPERIMENT_READY");
}

/** Why a decision no longer holds. Empty means the evidence still describes the present. */
export function staleReasons(binding: DecisionBinding | null, evaluations: EvaluationResult[], current: EvidenceContext): string[] {
  if (!binding) return ["evidência sem vínculo (registrada antes do evidence binding)"];
  const reasons: string[] = [];
  if (binding.baselineRevision !== current.baselineRevision) reasons.push(`a baseline mudou: ${binding.baselineRevision.slice(0, 10)} → ${current.baselineRevision.slice(0, 10)}`);
  if (binding.missionId !== current.missionId || binding.missionRevision !== current.missionRevision || binding.missionHash !== current.missionHash) {
    reasons.push(`a missão mudou (revisão ${binding.missionRevision} → ${current.missionRevision})`);
  }
  if (binding.envelopeHash !== current.envelopeHash) reasons.push("o envelope mudou");
  if (binding.environment !== current.environment) reasons.push(`o ambiente de execução mudou (${binding.environment.slice(0, 10) || "desconhecido"} → ${current.environment.slice(0, 10)})`);
  const now = new Set(current.evaluators);
  const changed = binding.evaluators.filter((e) => !now.has(e));
  if (changed.length > 0 || binding.evaluators.length !== current.evaluators.length) reasons.push(`avaliadores mudaram: ${changed.join(", ") || "conjunto diferente"}`);
  // Each piece of evidence must be about this candidate, this baseline and this mission.
  const unbound = evaluations.filter(
    (e) =>
      !e.binding ||
      e.binding.baselineRevision !== binding.baselineRevision ||
      e.binding.subjectRevision !== binding.candidateRevision ||
      e.binding.missionHash !== binding.missionHash ||
      e.binding.envelopeHash !== binding.envelopeHash ||
      e.binding.environment !== binding.environment,
  );
  if (unbound.length > 0) reasons.push(`evidência não vinculada a esta decisão: ${unbound.map((e) => e.evaluatorId).join(", ")}`);
  return reasons;
}

/** Where the organism stands against the mission. Never MET without enough data. */
export function missionProgress(mission: Pick<Mission, "desiredState">, measurements: Map<string, Measurement>): DesiredStatus[] {
  return mission.desiredState.map((d) => {
    const m = measurements.get(d.metric);
    const sampleSize = m?.sampleSize;
    if (!m || m.value === null || !enough(m, d.minSampleSize)) {
      return { ...d, value: m?.value ?? null, ...(sampleSize === undefined ? {} : { sampleSize }), status: "INSUFFICIENT_DATA" };
    }
    return { ...d, value: m.value, ...(sampleSize === undefined ? {} : { sampleSize }), status: satisfies(m.value, d.operator, d.target) ? "MET" : "NOT_MET" };
  });
}

export const missionReached = (progress: DesiredStatus[]): boolean => progress.length > 0 && progress.every((p) => p.status === "MET");
