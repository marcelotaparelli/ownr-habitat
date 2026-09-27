import type { Candidate, ComponentRule, ConstraintResult, Decision, Envelope, EvaluationResult, GuardResult, MetricComparison, Mission, Verdict } from "./domain.ts";

/**
 * Candidate Evidence: what changed, why it was proposed, what it can affect, what supports it and why
 * OWNR decided. Built only from recorded data — no model, no new measurement. Every statement says
 * what it rests on, so a heuristic is never read as a fact and a claim is never read as evidence.
 */

/** evidence: from bound, independently produced evaluations. heuristic: from path rules — may be wrong. claim: said by the proposer. */
export type Basis = "evidence" | "heuristic" | "claim";
export type Statement = { basis: Basis; text: string; detail?: string };

export type FileStat = { path: string; status: string; added: number | null; removed: number | null };

/** How far the evidence goes. Each rung needs strictly more than the previous one. */
export type EvidenceLevel = "blocked" | "none" | "proxy" | "outcome" | "mission";

export type CandidateEvidence = {
  verdict: Verdict | null;
  recordedVerdict: Verdict | null;
  level: EvidenceLevel;
  /** What the MutationProvider said. Never evidence. */
  claims: { source: string; hypothesis: string; claims: string | null };
  intent: Statement[];
  changeSummary: Statement[];
  missionHypothesis: Statement[];
  affected: (FileStat & { component: string; kind: string; affects: string; checkedBy: string[] })[];
  blastRadius: Statement[];
  risks: Statement[];
  envelope: { hard: ConstraintResult[]; soft: ConstraintResult[]; uncovered: Envelope["uncovered"] };
  proxies: MetricComparison[];
  guards: GuardResult[];
  outcomes: MetricComparison[];
  provenance: Statement[];
  rationale: Statement[];
};

export type ExplainInput = {
  mission: Mission;
  candidate: Candidate;
  decision: Decision | null;
  verdict: Verdict | null;
  stale: string[];
  evaluations: EvaluationResult[];
  baselineEvaluations: EvaluationResult[];
  files: FileStat[];
  components: ComponentRule[];
  environment: Record<string, unknown> | null;
};

const UNCLASSIFIED = { component: "não classificado", kind: "desconhecido", affects: "", checkedBy: [] as string[] };

export function levelOf(verdict: Verdict | null): EvidenceLevel {
  if (verdict === "MISSION_MET") return "mission";
  if (verdict === "OUTCOME_IMPROVED") return "outcome";
  if (verdict === "EXPERIMENT_READY" || verdict === "PROXY_IMPROVED") return "proxy";
  if (verdict === "INELIGIBLE" || verdict === "STALE" || verdict === "REGRESSED") return "blocked";
  return "none";
}

export function classify(path: string, rules: ComponentRule[]): { component: string; kind: string; affects: string; checkedBy: string[] } {
  for (const rule of rules) {
    const match = new RegExp(rule.pattern).exec(path);
    if (match) return { component: rule.label.replace(/\$(\d)/g, (_, n: string) => match[Number(n)] ?? ""), kind: rule.kind, affects: rule.affects, checkedBy: rule.checkedBy };
  }
  return UNCLASSIFIED;
}

export function explainCandidate(input: ExplainInput): CandidateEvidence {
  const { mission, candidate, decision, evaluations, baselineEvaluations } = input;
  const comparisons = decision?.comparisons ?? [];
  const proxies = comparisons.filter((c) => c.kind === "proxy");
  const outcomes = comparisons.filter((c) => c.kind === "outcome");
  const affected = input.files.map((f) => ({ ...f, ...classify(f.path, input.components) }));
  const byStatus = new Map(evaluations.map((e) => [e.evaluatorId, e.status]));

  return {
    verdict: input.verdict,
    recordedVerdict: decision?.verdict ?? null,
    level: levelOf(input.verdict),
    claims: { source: `${candidate.source.kind} · ${candidate.source.author}`, hypothesis: candidate.hypothesis, claims: candidate.claims },
    intent: intent(mission, candidate, comparisons),
    changeSummary: changeSummary(affected, evaluations, baselineEvaluations, comparisons),
    missionHypothesis: missionHypothesis(mission, comparisons),
    affected,
    blastRadius: blastRadius(affected, byStatus, evaluations),
    risks: risks(input, comparisons, affected),
    envelope: { hard: (decision?.constraints ?? []).filter((c) => c.severity === "hard"), soft: (decision?.constraints ?? []).filter((c) => c.severity === "soft"), uncovered: mission.envelope.uncovered },
    proxies,
    guards: decision?.guards ?? [],
    outcomes,
    provenance: provenance(input),
    rationale: rationale(input.verdict, decision, input.stale),
  };
}

const moved = (c: MetricComparison) => `${c.label}: ${c.baseline ?? "?"} → ${c.candidate ?? "?"}`;

function intent(mission: Mission, candidate: Candidate, comparisons: MetricComparison[]): Statement[] {
  const out: Statement[] = [{ basis: "claim", text: `Declarado pelo autor: ${candidate.hypothesis}` }];
  const changed = comparisons.filter((c) => c.outcome === "improved" || c.outcome === "worse");
  out.push(
    changed.length
      ? { basis: "evidence", text: `Métricas da missão que a evidência mostra se movendo: ${changed.map((c) => `${moved(c)} (${c.outcome})`).join("; ")}` }
      : { basis: "evidence", text: "Nenhuma métrica da missão se moveu na evidência deste candidate." },
  );
  out.push({ basis: "evidence", text: `Missão: ${mission.objective}` });
  return out;
}

/** Report lines present on one side only: what the instruments themselves say changed, verbatim. */
function reportDiff(candidate: EvaluationResult, baseline: EvaluationResult | undefined): { gone: string[]; new: string[] } {
  const lines = (e: EvaluationResult | undefined) => new Set((e?.evidence ?? []).filter((x) => x.kind === "report").flatMap((x) => (x.detail ?? "").split("\n")).filter((l) => l.trim()));
  const before = lines(baseline);
  const after = lines(candidate);
  return { gone: [...before].filter((l) => !after.has(l)), new: [...after].filter((l) => !before.has(l)) };
}

function changeSummary(affected: CandidateEvidence["affected"], evaluations: EvaluationResult[], baseline: EvaluationResult[], comparisons: MetricComparison[]): Statement[] {
  const out: Statement[] = [];
  const known = affected.filter((f) => f.added !== null);
  const added = known.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = known.reduce((n, f) => n + (f.removed ?? 0), 0);
  out.push({ basis: "evidence", text: `${affected.length} arquivo(s) alterado(s), +${added} / −${removed} linhas (git diff contra a baseline)` });
  const groups = new Map<string, string[]>();
  for (const f of affected) groups.set(f.component, [...(groups.get(f.component) ?? []), f.path.split("/").at(-1) ?? f.path]);
  for (const [component, files] of groups) out.push({ basis: "heuristic", text: `${component}: ${files.join(", ")}`, detail: "componente inferido pelo caminho do arquivo" });
  for (const e of evaluations) {
    const diff = reportDiff(e, baseline.find((b) => b.evaluatorId === e.evaluatorId));
    if (diff.gone.length + diff.new.length === 0) continue;
    out.push({
      basis: "evidence",
      text: `${e.evaluatorId} relata ${diff.new.length} linha(s) diferente(s) da baseline`,
      detail: [...diff.gone.slice(0, 12).map((l) => `- ${l}`), ...diff.new.slice(0, 12).map((l) => `+ ${l}`)].join("\n"),
    });
  }
  const unchanged = comparisons.filter((c) => c.outcome === "unchanged");
  if (unchanged.length) out.push({ basis: "evidence", text: `Inalteradas: ${unchanged.map(moved).join("; ")}` });
  return out;
}

function missionHypothesis(mission: Mission, comparisons: MetricComparison[]): Statement[] {
  const out: Statement[] = [];
  for (const c of comparisons.filter((x) => x.kind === "proxy" && (x.outcome === "improved" || x.outcome === "worse"))) {
    const desired = mission.desiredState.find((d) => d.metric === c.metric);
    out.push({
      basis: "evidence",
      text: desired
        ? `${moved(c)} — estado desejado ${desired.operator} ${desired.target}: ${c.candidate !== null && satisfied(c.candidate, desired.operator, desired.target) ? "atingido neste candidate" : "ainda não atingido"}`
        : `${moved(c)} (proxy; sem alvo próprio no estado desejado)`,
    });
  }
  const outcomes = comparisons.filter((c) => c.kind === "outcome");
  if (outcomes.length) {
    out.push({
      basis: "evidence",
      text: `Proxies são hipóteses: a missão só se confirma por outcomes (${outcomes.map((c) => `${c.label}: ${c.outcome}`).join("; ")}).`,
      detail: "Candidates são avaliados antes de qualquer uso real; outcomes só são medidos na baseline em uso, depois de uma aceitação humana.",
    });
  }
  if (out.length === 0) out.push({ basis: "evidence", text: "Nenhuma métrica da missão mudou: nada aproxima ou afasta o estado desejado segundo a evidência." });
  return out;
}

function satisfied(value: number, operator: "<=" | ">=" | "==", target: number): boolean {
  return operator === "<=" ? value <= target : operator === ">=" ? value >= target : value === target;
}

function blastRadius(affected: CandidateEvidence["affected"], status: Map<string, string>, evaluations: EvaluationResult[]): Statement[] {
  const out: Statement[] = [];
  const seen = new Set<string>();
  for (const f of affected) {
    if (seen.has(f.component) || f.kind === UNCLASSIFIED.kind) continue;
    seen.add(f.component);
    const checks = f.checkedBy.map((id) => `${id} ${status.get(id) ?? "NOT_RUN"}`).join(", ");
    out.push({ basis: "heuristic", text: `${f.component} (${f.kind}): ${f.affects}`, detail: checks ? `exercitado por: ${checks}` : "nenhum avaliador declarado para este componente" });
  }
  const outside = evaluations.find((e) => e.evaluatorId === "path-policy")?.errors.filter((e) => e.startsWith("fora dos caminhos") || e.startsWith("symlink")) ?? [];
  for (const error of outside) out.push({ basis: "evidence", text: `Tocou área protegida: ${error}` });
  const kinds = [...new Set(affected.map((f) => f.kind))];
  if (kinds.length) out.push({ basis: "heuristic", text: `Tipos de artefato alterados: ${kinds.join(", ")}`, detail: "classificação por caminho; não prova ausência de efeito em runtime" });
  return out;
}

function risks(input: ExplainInput, comparisons: MetricComparison[], affected: CandidateEvidence["affected"]): Statement[] {
  const out: Statement[] = [];
  if (input.candidate.claims) out.push({ basis: "claim", text: `Alegação não verificada do autor: "${input.candidate.claims}" — a decisão não a usa.` });
  for (const reason of input.stale) out.push({ basis: "evidence", text: `Evidência desatualizada: ${reason}` });
  for (const warning of input.decision?.warnings ?? []) out.push({ basis: "evidence", text: warning });
  const pending = comparisons.filter((c) => c.kind === "outcome" && c.outcome !== "improved" && c.outcome !== "worse" && c.outcome !== "unchanged");
  if (pending.length) out.push({ basis: "evidence", text: `Efeito real não medido: ${pending.map((c) => `${c.label} (${c.outcome})`).join("; ")}` });
  const untrustedProxies = comparisons.filter((c) => c.kind === "proxy" && (c.outcome === "untrusted" || c.outcome === "unknown"));
  if (untrustedProxies.length) out.push({ basis: "evidence", text: `Proxies sem comparação confiável: ${untrustedProxies.map((c) => `${c.label} (${c.outcome})`).join("; ")}` });
  for (const reason of (input.decision?.reasons ?? []).filter((r) => r.startsWith("medida não confiável ignorada"))) out.push({ basis: "evidence", text: reason });
  for (const u of input.mission.envelope.uncovered) out.push({ basis: "evidence", text: `Não verificado por nenhum avaliador: ${u.name}`, detail: u.reason });
  const unclassified = affected.filter((f) => f.kind === UNCLASSIFIED.kind);
  if (unclassified.length) out.push({ basis: "heuristic", text: `Arquivos sem componente conhecido (impacto não estimado): ${unclassified.map((f) => f.path).join(", ")}` });
  const unchecked = affected.filter((f) => f.kind !== UNCLASSIFIED.kind && f.checkedBy.length === 0);
  if (unchecked.length) out.push({ basis: "heuristic", text: `Componentes sem avaliador declarado: ${[...new Set(unchecked.map((f) => f.component))].join(", ")}` });
  return out;
}

function provenance(input: ExplainInput): Statement[] {
  const out: Statement[] = [];
  const binding = input.decision?.binding;
  if (binding) {
    out.push({ basis: "evidence", text: `Baseline ${binding.baselineRevision.slice(0, 10)} → candidate ${binding.candidateRevision.slice(0, 10)} · missão rev ${binding.missionRevision} · observação ${binding.baselineObservationId}` });
  }
  const env = input.environment;
  if (env) {
    const runner = env["runner"] as { kind?: string; description?: string } | undefined;
    const runtime = env["runtime"] as { bun?: string } | undefined;
    const deps = env["dependencies"] as { lockfile?: string; tools?: Record<string, string> } | undefined;
    out.push({
      basis: "evidence",
      text: `Executado em ${runner?.kind ?? "?"} · bun ${runtime?.bun ?? "?"} · ${Object.entries(deps?.tools ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")} · lockfile ${deps?.lockfile ?? "?"}`,
      detail: runner?.description ?? "",
    });
  } else if (binding) {
    out.push({ basis: "evidence", text: `Ambiente ${binding.environment || "desconhecido"} (detalhe não registrado)` });
  }
  for (const e of input.evaluations) {
    const commands = (e.provenance?.commands ?? []).map((c) => `$ ${c.argv.join(" ")} → exit ${c.exitCode ?? "—"}, ${c.durationMs} ms${c.limit ? `, limite ${c.limit}` : ""}${c.timedOut ? ", timeout" : ""}`);
    const instrument = e.provenance?.instrument ? `instrumento ${e.provenance.instrument}` : null;
    if (commands.length || instrument) out.push({ basis: "evidence", text: `${e.evaluatorId}: ${e.status}`, detail: [...commands, ...(instrument ? [instrument] : [])].join("\n") });
  }
  return out;
}

/** Why the Selector reached this verdict, read from the recorded decision (the policy itself is not re-run here). */
export function rationale(verdict: Verdict | null, decision: Decision | null, stale: string[]): Statement[] {
  if (!decision || !verdict) return [{ basis: "evidence", text: "Sem decisão registrada." }];
  const improved = decision.comparisons.filter((c) => c.outcome === "improved");
  const worse = decision.comparisons.filter((c) => c.outcome === "worse");
  const list = (xs: MetricComparison[]) => xs.map(moved).join("; ");
  const say = (text: string): Statement => ({ basis: "evidence", text });
  switch (verdict) {
    case "STALE":
      return [say(`Registrado como ${decision.verdict}, mas a evidência não descreve mais o presente — precisa ser reavaliado antes de qualquer aceitação.`), ...stale.map((s) => say(s))];
    case "INELIGIBLE": {
      const blocked = decision.constraints.filter((c) => c.severity === "hard" && c.status !== "PASS");
      const unmeasured = decision.guards.filter((g) => g.status === "NOT_RUN");
      return [
        say("Saiu do envelope: uma restrição HARD falhou ou não rodou — nenhum ganho de fitness compensa isso."),
        ...blocked.map((c) => say(`HARD ${c.name}: ${c.status} — ${c.detail}`)),
        ...unmeasured.map((g) => say(`Métrica protegida sem medida: ${g.label}`)),
      ];
    }
    case "REGRESSED": {
      const broken = decision.guards.filter((g) => g.status === "FAIL");
      return [
        say("Piorou algo que a missão protege ou persegue, sem melhora que o compense."),
        ...broken.map((g) => say(`Métrica protegida ${g.label}: ${g.value} (exigido ${g.operator} ${g.threshold}) — ${g.reason}`)),
        ...(worse.length ? [say(`Pioraram: ${list(worse)}`)] : []),
      ];
    }
    case "TRADEOFF":
      return [say("Melhora e piora ao mesmo tempo. Não há score único que decida: a troca é uma decisão humana explícita."), say(`Melhoraram: ${list(improved)}`), say(`Pioraram: ${list(worse)}`)];
    case "NEUTRAL":
      return [say("Envelope respeitado, mas nenhuma métrica da missão melhorou.")];
    case "PROXY_IMPROVED":
      return [
        say(`Proxies melhoraram (${list(improved)}), mas não com o envelope inteiro verde ou com todas as proxies comparáveis — por isso não chega a EXPERIMENT_READY.`),
        ...decision.warnings.map((w) => say(w)),
      ];
    case "EXPERIMENT_READY":
      return [
        say(`Proxies melhoraram (${list(improved)}), envelope inteiro verde, nenhuma métrica protegida ou objetivo piorou.`),
        say("É o máximo que um candidate avaliado offline alcança: pode virar um experimento se um humano aceitar. Não é melhora da missão — só outcomes medidos em uso real com amostra suficiente mostram isso."),
      ];
    case "OUTCOME_IMPROVED":
      return [say(`Outcomes melhoraram com amostra suficiente e instrumento idêntico dos dois lados: ${list(improved.filter((c) => c.kind === "outcome"))}.`), say("O estado desejado ainda não está todo atingido.")];
    case "MISSION_MET":
      return [say("Outcomes melhoraram e todo o estado desejado está atingido com dados suficientes.")];
  }
}
