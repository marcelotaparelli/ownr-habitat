import { describe, expect, test } from "bun:test";
import type { Candidate, ComponentRule, EvaluationResult, Measurement, Mission, Verdict } from "../src/domain.ts";
import { classify, explainCandidate, levelOf, type ExplainInput } from "../src/explain.ts";
import { decide } from "../src/selection.ts";

const evaluation = (evaluatorId: string, status: EvaluationResult["status"], metrics: Record<string, number> = {}, extra: Measurement[] = [], detail?: string): EvaluationResult => ({
  evaluatorId,
  status,
  measurements: [...Object.entries(metrics).map(([metric, value]) => ({ metric, value, status: "MEASURED" as const })), ...extra],
  evidence: detail ? [{ kind: "report", summary: "relatório", detail }] : [],
  durationMs: 0,
  errors: status === "PASS" ? [] : [`${evaluatorId} ${status}`],
  provenance: { commands: [{ argv: ["bun", "probe"], runner: "linux-sandbox", exitCode: status === "PASS" ? 0 : 1, durationMs: 5, timedOut: false, limit: null }], instrument: `instrument-of-${evaluatorId}` },
});

const MISSION: Mission = {
  id: "m",
  organismId: "o",
  objective: "Baixar o score sem perder cobertura.",
  status: "active",
  desiredState: [
    { metric: "score", label: "Score", operator: "<=", target: 3 },
    { metric: "usage", label: "Uso real", operator: ">=", target: 0.9, minSampleSize: 10 },
  ],
  fitness: {
    objectives: [
      { metric: "score", label: "Score", direction: "minimize", kind: "proxy" },
      { metric: "length", label: "Comprimento", direction: "minimize", kind: "proxy" },
      { metric: "usage", label: "Uso real", direction: "maximize", kind: "outcome", minSampleSize: 10 },
    ],
    guards: [{ metric: "coverage", label: "Cobertura", operator: ">=", threshold: 3, reason: "não ensinar menos" }],
  },
  envelope: {
    id: "e",
    constraints: [
      { id: "check", name: "Checagem", severity: "hard", evaluatorId: "check" },
      { id: "size", name: "Tamanho", severity: "soft", evaluatorId: "score", metric: "size", operator: "<=", threshold: 100 },
    ],
    uncovered: [{ name: "Segurança", reason: "sem avaliador" }],
  },
  evidence: { sources: { score: "score", length: "score", coverage: "score", size: "score", usage: "telemetry" }, instruments: { score: ["rules.txt"] } },
};

const run = (metrics: Record<string, number>, check: EvaluationResult["status"] = "PASS", detail?: string) => [
  evaluation("path-policy", "PASS"),
  evaluation("check", check),
  evaluation("score", "PASS", { size: 10, coverage: 3, length: 5, ...metrics }, [], detail),
];

const CANDIDATE: Candidate = {
  id: "cand-1",
  missionId: "m",
  proposalId: "p",
  generation: 1,
  parentRevision: "a".repeat(40),
  revision: "b".repeat(40),
  hypothesis: "Baixar o score encurtando a etapa 3.",
  source: { kind: "llm", author: "agente" },
  claims: "Todos os testes passam e o aluno aprende mais rápido.",
  status: "evaluated",
  reevaluationOf: null,
  createdAt: 0,
};

const RULES: ComponentRule[] = [
  { pattern: "^content/stages/(\\d+)-([^/]+)/", label: "Etapa $1 ($2)", kind: "conteúdo", affects: "o que o aluno vê nesta etapa e nas seguintes", checkedBy: ["score", "check"] },
  { pattern: "^docs/", label: "Documentação", kind: "docs", affects: "nada em runtime", checkedBy: [] },
];

function explain(overrides: Partial<ExplainInput> & { baseline?: EvaluationResult[]; candidateEvals?: EvaluationResult[] } = {}) {
  const baselineEvaluations = overrides.baseline ?? run({ score: 10 }, "PASS", "etapa-3  7\netapa-4  2");
  const evaluations = overrides.candidateEvals ?? run({ score: 5 }, "PASS", "etapa-3  4\netapa-4  2");
  const decision = overrides.decision === undefined ? { ...decide(MISSION, baselineEvaluations, evaluations), binding: null } : overrides.decision;
  return explainCandidate({
    mission: MISSION,
    candidate: CANDIDATE,
    decision,
    verdict: overrides.verdict === undefined ? (decision?.verdict ?? null) : overrides.verdict,
    stale: overrides.stale ?? [],
    evaluations,
    baselineEvaluations,
    files: overrides.files ?? [
      { path: "content/stages/03-short/stage.json", status: "M", added: 4, removed: 7 },
      { path: "content/stages/03-short/ref.ts", status: "M", added: 1, removed: 2 },
      { path: "misc/notes.txt", status: "A", added: 3, removed: 0 },
    ],
    components: RULES,
    environment: overrides.environment ?? { runtime: { bun: "1.4.2" }, runner: { kind: "linux-sandbox", description: "sem rede" }, dependencies: { lockfile: "abc", tools: { typescript: "7.0.2" } } },
  });
}

const all = (e: ReturnType<typeof explain>) => [...e.intent, ...e.changeSummary, ...e.missionHypothesis, ...e.blastRadius, ...e.risks, ...e.provenance, ...e.rationale];

describe("Candidate Evidence", () => {
  test("claims stay in the claims block and never appear as evidence", () => {
    const e = explain();
    expect(e.claims).toEqual({ source: "llm · agente", hypothesis: CANDIDATE.hypothesis, claims: CANDIDATE.claims });
    const mentioning = all(e).filter((s) => s.text.includes(CANDIDATE.hypothesis) || s.text.includes(CANDIDATE.claims ?? "--"));
    expect(mentioning.length).toBeGreaterThan(0);
    expect(mentioning.every((s) => s.basis === "claim")).toBe(true);
    expect(e.rationale.every((s) => s.basis === "evidence")).toBe(true);
  });

  test("path-derived statements are marked as heuristics; unknown files are an explicit uncertainty", () => {
    const e = explain();
    expect(e.affected.map((f) => f.component)).toEqual(["Etapa 03 (short)", "Etapa 03 (short)", "não classificado"]);
    expect(e.blastRadius.find((s) => s.text.startsWith("Etapa 03"))).toMatchObject({ basis: "heuristic", detail: "exercitado por: score PASS, check PASS" });
    expect(e.changeSummary.filter((s) => s.text.startsWith("Etapa 03") || s.text.startsWith("não classificado")).every((s) => s.basis === "heuristic")).toBe(true);
    expect(e.risks).toContainEqual({ basis: "heuristic", text: "Arquivos sem componente conhecido (impacto não estimado): misc/notes.txt" });
  });

  test("the change summary comes from the diff and from what the instruments themselves report", () => {
    const e = explain();
    expect(e.changeSummary[0]).toEqual({ basis: "evidence", text: "3 arquivo(s) alterado(s), +8 / −9 linhas (git diff contra a baseline)" });
    expect(e.changeSummary.find((s) => s.text.startsWith("score relata"))).toEqual({ basis: "evidence", text: "score relata 1 linha(s) diferente(s) da baseline", detail: "- etapa-3  7\n+ etapa-3  4" });
    expect(e.intent[1]?.text).toContain("Score: 10 → 5 (improved)");
  });

  test("the mission hypothesis states that proxies are not outcomes", () => {
    const e = explain();
    expect(e.missionHypothesis[0]?.text).toBe("Score: 10 → 5 — estado desejado <= 3: ainda não atingido");
    expect(e.missionHypothesis.at(-1)?.text).toContain("a missão só se confirma por outcomes (Uso real: insufficient_data)");
    expect(e.risks.map((s) => s.text)).toContain("Efeito real não medido: Uso real (insufficient_data)");
  });

  test("envelope, proxy and outcome evidence are separated, and uncovered checks are listed as risks", () => {
    const e = explain();
    expect(e.envelope.hard.map((c) => c.constraintId)).toEqual(["check"]);
    expect(e.envelope.soft.map((c) => c.constraintId)).toEqual(["size"]);
    expect(e.proxies.map((c) => c.metric)).toEqual(["score", "length"]);
    expect(e.outcomes.map((c) => c.metric)).toEqual(["usage"]);
    expect(e.risks.map((s) => s.text)).toContain("Não verificado por nenhum avaliador: Segurança");
  });

  test("provenance names the runner, the runtime and every command", () => {
    const e = explain();
    expect(e.provenance.find((s) => s.text.startsWith("Executado em"))?.text).toBe("Executado em linux-sandbox · bun 1.4.2 · typescript 7.0.2 · lockfile abc");
    expect(e.provenance.find((s) => s.text === "check: PASS")?.detail).toBe("$ bun probe → exit 0, 5 ms\ninstrumento instrument-of-check");
  });

  test("the rationale explains each verdict from the recorded decision", () => {
    const at = (candidateEvals: EvaluationResult[], baseline?: EvaluationResult[]) => explain({ candidateEvals, ...(baseline ? { baseline } : {}) });
    const cases: [Verdict, ReturnType<typeof explain>, string][] = [
      ["EXPERIMENT_READY", at(run({ score: 5 })), "Não é melhora da missão"],
      ["INELIGIBLE", at(run({ score: 0 }, "FAIL")), "HARD Checagem: FAIL"],
      ["REGRESSED", at(run({ score: 5, coverage: 1 })), "Métrica protegida Cobertura: 1"],
      ["TRADEOFF", at(run({ score: 5, length: 9 })), "Pioraram: Comprimento: 5 → 9"],
      ["NEUTRAL", at(run({ score: 10 })), "nenhuma métrica da missão melhorou"],
      ["PROXY_IMPROVED", at(run({ score: 5, size: 500 })), "SOFT Tamanho"],
      [
        "OUTCOME_IMPROVED",
        at([...run({ score: 5 }), evaluation("telemetry", "PASS", {}, [{ metric: "usage", value: 0.8, status: "MEASURED", sampleSize: 20 }])], [...run({ score: 10 }), evaluation("telemetry", "PASS", {}, [{ metric: "usage", value: 0.5, status: "MEASURED", sampleSize: 20 }])]),
        "Outcomes melhoraram com amostra suficiente",
      ],
    ];
    for (const [verdict, e, phrase] of cases) {
      expect(e.verdict).toBe(verdict);
      expect(e.rationale.map((s) => s.text).join(" ")).toContain(phrase);
    }
    const stale = explain({ verdict: "STALE", stale: ["a baseline mudou: aaa → bbb"] });
    expect(stale.rationale.map((s) => s.text)).toEqual(["Registrado como EXPERIMENT_READY, mas a evidência não descreve mais o presente — precisa ser reavaliado antes de qualquer aceitação.", "a baseline mudou: aaa → bbb"]);
    expect(stale.level).toBe("blocked");
  });

  test("the evidence ladder keeps proxy, outcome and mission apart", () => {
    expect([levelOf("PROXY_IMPROVED"), levelOf("EXPERIMENT_READY"), levelOf("OUTCOME_IMPROVED"), levelOf("MISSION_MET")]).toEqual(["proxy", "proxy", "outcome", "mission"]);
    expect([levelOf("INELIGIBLE"), levelOf("STALE"), levelOf("REGRESSED"), levelOf("NEUTRAL"), levelOf("TRADEOFF"), levelOf(null)]).toEqual(["blocked", "blocked", "blocked", "none", "none", "none"]);
  });

  test("component rules: first match wins and groups fill the label", () => {
    expect(classify("content/stages/12-weights/x.ts", RULES)).toMatchObject({ component: "Etapa 12 (weights)", kind: "conteúdo" });
    expect(classify("docs/a.md", RULES).component).toBe("Documentação");
    expect(classify("other", RULES).component).toBe("não classificado");
  });
});
