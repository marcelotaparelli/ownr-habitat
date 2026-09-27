import type { Candidate, ConstraintResult, Decision, EvaluationResult, FileChange, Measurement, MetricComparison } from "../src/domain.ts";
import type { Basis, CandidateEvidence, EvidenceLevel, Statement } from "../src/explain.ts";
import type { CandidateAssessment } from "../src/evolution.ts";
import type { HabitatEvent } from "../src/store.ts";
import { $, h, type Child } from "./dom.ts";

/**
 * The Cockpit: where the organism is, where it should be, what the envelope allows,
 * which candidates exist, why each one was decided — and a human hand on acceptance.
 */

type State = Awaited<ReturnType<typeof import("../src/api.ts").snapshot>>;
type CandidateDetail = {
  candidate: Candidate;
  assessment: CandidateAssessment;
  changes: FileChange[];
  evaluations: EvaluationResult[];
  baselineEvaluations: EvaluationResult[];
  decision: Decision | null;
  diff: string | null;
  environment: Record<string, unknown> | null;
  evidence: CandidateEvidence | undefined;
  events: HabitatEvent[];
};

const VERDICT_HELP: Record<string, string> = {
  INELIGIBLE: "saiu do envelope (HARD falhou ou não rodou)",
  STALE: "a evidência não descreve mais o presente — reavalie",
  REGRESSED: "piorou uma métrica protegida ou um objetivo",
  TRADEOFF: "melhora e piora ao mesmo tempo — decisão humana explícita",
  NEUTRAL: "nada melhorou",
  PROXY_IMPROVED: "proxies melhoraram, mas com avisos ou lacunas",
  EXPERIMENT_READY: "proxies melhoraram dentro do envelope; só uso real pode confirmar a missão",
  OUTCOME_IMPROVED: "outcomes melhoraram com amostra suficiente",
  MISSION_MET: "todo o estado desejado atingido com dados suficientes",
};
const ACCEPTABLE = new Set(["EXPERIMENT_READY", "OUTCOME_IMPROVED", "MISSION_MET"]);

let state: State | null = null;
let selected: string | null = null;
let message = "";

async function api<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const response = await fetch(path, init ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
  const body = (await response.json()) as T & { error?: { message: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body;
}

const badge = (status: string, label = status) => h("span", { class: `badge s-${status}`, title: VERDICT_HELP[status] }, label);
const fmt = (m: Pick<Measurement, "value" | "unit"> | undefined) => (m?.value === null || m?.value === undefined ? "—" : `${m.value}${m.unit ? ` ${m.unit}` : ""}`);
const time = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR");
const short = (sha: string) => sha.slice(0, 10);

async function refresh(): Promise<void> {
  try {
    state = await api<State>("/api/state");
    render();
    if (selected) await renderCandidate(selected);
    const events = await api<{ events: HabitatEvent[] }>("/api/events");
    renderRecorder(events.events);
  } catch (error) {
    message = `Falha ao ler o estado: ${String(error)}`;
    render();
  }
}

async function act(run: () => Promise<unknown>): Promise<void> {
  message = "";
  try {
    await run();
  } catch (error) {
    message = String(error instanceof Error ? error.message : error);
  }
  await refresh();
}

function render(): void {
  if (!state) return;
  const s = state;
  const runner = s.environment?.["runner"] as { kind?: string } | undefined;
  $("#organism").textContent = `${s.organism.name} (${s.organism.repositoryPath} @ ${s.organism.baselineRef} = ${short(s.context.baselineRevision)}) · missão ${s.mission.id} (revisão ${s.context.missionRevision}) · runner ${runner?.kind ?? "?"}`;
  const running = $("#running");
  running.hidden = !s.running;
  running.textContent = s.running ? `executando ${s.running}…` : "";

  const baselineMeasurements = new Map((s.baseline?.evaluations ?? []).flatMap((e) => e.measurements).map((m) => [m.metric, m]));
  const objectives = (kind: "proxy" | "outcome") => s.mission.fitness.objectives.filter((o) => o.kind === kind);

  $("#mission").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Missão"),
      h("p", {}, s.mission.objective),
      h("p", { class: "muted" }, s.mission.reached ? "Estado desejado alcançado." : "Estado desejado ainda não alcançado — nunca declarado sem dados suficientes."),
      h(
        "table",
        {},
        h("tr", {}, h("th", {}, "Estado desejado"), h("th", {}, "Atual"), h("th", {}, "Alvo"), h("th", {}, "")),
        s.progress.map((p) =>
          h(
            "tr",
            {},
            h("td", {}, p.label),
            h("td", { class: "num" }, p.value === null ? "—" : `${p.value}${p.unit ? ` ${p.unit}` : ""}`, p.sampleSize === undefined ? "" : h("div", { class: "muted" }, `n=${p.sampleSize}${p.minSampleSize ? `/${p.minSampleSize}` : ""}`)),
            h("td", { class: "num" }, `${p.operator} ${p.target}`),
            h("td", {}, badge(p.status)),
          ),
        ),
      ),
      h("h3", {}, "Fitness (vetor, sem score único)"),
      h("p", { class: "muted" }, "Proxies — medidos em cada candidate, hipóteses sobre a missão:"),
      h("ul", {}, objectives("proxy").map((o) => h("li", {}, `${o.direction === "minimize" ? "↓" : "↑"} ${o.label} — baseline ${fmt(baselineMeasurements.get(o.metric))}`))),
      h("p", { class: "muted" }, "Outcomes — só em uso real, com amostra mínima:"),
      h("ul", {}, objectives("outcome").map((o) => h("li", {}, `${o.direction === "minimize" ? "↓" : "↑"} ${o.label} — baseline ${fmt(baselineMeasurements.get(o.metric))} (n ≥ ${o.minSampleSize ?? "—"})`))),
      h("p", { class: "muted" }, "Métricas protegidas (anti-Goodhart):"),
      h("ul", {}, s.mission.fitness.guards.map((g) => h("li", {}, `${g.label} ${g.operator} ${g.threshold} — ${g.reason}`))),
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Baseline"),
      s.baseline
        ? h("p", {}, h("span", { class: "mono" }, short(s.baseline.revision)), ` observada às ${time(s.baseline.createdAt)} `, s.baseline.current ? badge("PASS", "atual") : badge("STALE", "desatualizada"))
        : h("p", { class: "muted" }, "Ainda não observada."),
      s.baseline ? h("div", { class: "row" }, s.baseline.evaluations.map((e) => badge(e.status, `${e.evaluatorId} ${e.status}`))) : null,
      h("p", {}, h("button", { disabled: Boolean(s.running), onclick: () => act(() => api("/api/baseline/observe", { method: "POST", body: {} })) }, "Observar baseline atual")),
    ),
  );

  const baselineEvaluations = new Map((s.baseline?.evaluations ?? []).map((e) => [e.evaluatorId, e]));
  $("#envelope").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, `Envelope · ${s.mission.envelope.id}`),
      h(
        "table",
        {},
        h("tr", {}, h("th", {}, ""), h("th", {}, "Restrição"), h("th", {}, "Baseline")),
        s.mission.envelope.constraints.map((c) =>
          h("tr", {}, h("td", {}, badge(c.severity, c.severity.toUpperCase())), h("td", {}, c.name, c.metric ? h("div", { class: "muted mono" }, `${c.metric} ${c.operator} ${c.threshold}`) : null), h("td", {}, badge(baselineEvaluations.get(c.evaluatorId)?.status ?? "NOT_RUN"))),
        ),
        s.mission.envelope.uncovered.map((u) => h("tr", {}, h("td", {}, badge("NOT_RUN")), h("td", {}, u.name, h("div", { class: "muted" }, u.reason)), h("td", {}, badge("NOT_RUN")))),
      ),
      h("p", { class: "muted" }, "SOFT é aviso: nunca torna um candidate melhor. Candidates só podem alterar: ", h("span", { class: "mono" }, s.organism.allowedPaths.join(", "))),
    ),
  );

  // Lineage: each observed baseline, the candidates evaluated against it, and the one accepted as the next.
  const parents = [...new Set([...s.baselines.map((b) => b.revision), ...s.candidates.map((c) => c.parentRevision)])];
  $("#evolution").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Evolução"),
      h(
        "ul",
        { class: "tree" },
        parents.map((revision) => {
          const baseline = s.baselines.find((b) => b.revision === revision);
          return h(
            "li",
            {},
            h(
              "span",
              { class: "mono" },
              `baseline ${short(revision)}`,
              revision === s.context.baselineRevision ? " (atual)" : "",
              baseline?.acceptedCandidate ? ` ← ${baseline.acceptedCandidate}` : "",
              baseline?.assessment ? " · experimento: " : "",
            ),
            baseline?.assessment ? badge(baseline.assessment) : null,
            baseline ? null : h("span", { class: "muted" }, " não observada"),
            h(
              "ul",
              {},
              s.candidates
                .filter((c) => c.parentRevision === revision)
                .map((c) =>
                  h(
                    "li",
                    {},
                    h(
                      "button",
                      { class: "node", "aria-current": String(c.id === selected), onclick: () => select(c.id) },
                      h("span", { class: "mono" }, `g${c.generation} ${c.id}`),
                      h("span", {}, c.proposalId),
                      c.verdict ? badge(c.verdict) : badge(c.status, c.status),
                      c.status === "accepted" ? badge("accepted", "aceito → baseline") : null,
                      c.reevaluationOf ? h("span", { class: "muted" }, `reavalia ${c.reevaluationOf}`) : null,
                    ),
                  ),
                ),
            ),
          );
        }),
      ),
      h("h3", {}, "Propostas"),
      h(
        "table",
        {},
        s.proposals.map((p) =>
          h(
            "tr",
            {},
            h("td", {}, h("strong", {}, p.id), h("div", { class: "muted" }, p.hypothesis), h("div", { class: "muted" }, `origem: ${p.source.kind} · ${p.source.author} · ${p.patchLines} linhas de patch`)),
            h(
              "td",
              {},
              h("button", { disabled: Boolean(s.running) || !s.baseline?.current, onclick: () => act(() => api(`/api/proposals/${encodeURIComponent(p.id)}/candidate`, { method: "POST", body: {} })) }, "Avaliar"),
            ),
          ),
        ),
      ),
      message ? h("p", { class: "error", role: "alert" }, message) : null,
    ),
  );
}

async function select(id: string): Promise<void> {
  selected = id;
  render();
  await renderCandidate(id);
}

const BASIS_LABEL: Record<Basis, string> = { evidence: "EVIDÊNCIA", heuristic: "HEURÍSTICA", claim: "ALEGAÇÃO" };
const statements = (items: Statement[]) =>
  h(
    "ul",
    { class: "statements" },
    items.map((s) => h("li", {}, h("span", { class: `basis b-${s.basis}` }, BASIS_LABEL[s.basis]), " ", s.text, s.detail ? h("div", { class: "muted pre-line" }, s.detail) : null)),
  );
const section = (title: string, ...body: Child[]) => h("section", { class: "ce-section" }, h("h3", {}, title), ...body);

/** Three rungs, each needing strictly more evidence than the previous one. Only the one reached is filled. */
function ladder(level: EvidenceLevel) {
  const rungs: { level: EvidenceLevel; title: string; verdicts: string; needs: string }[] = [
    { level: "proxy", title: "Proxy melhorou", verdicts: "PROXY_IMPROVED / EXPERIMENT_READY", needs: "medido no candidate, antes de qualquer uso — é hipótese" },
    { level: "outcome", title: "Outcome melhorou", verdicts: "OUTCOME_IMPROVED", needs: "medido em uso real da baseline, amostra suficiente, instrumento idêntico" },
    { level: "mission", title: "Missão cumprida", verdicts: "MISSION_MET", needs: "todo o estado desejado atingido com dados suficientes" },
  ];
  return h(
    "div",
    { class: "ladder", role: "list", "aria-label": "Nível de evidência" },
    rungs.map((r, i) => [
      i > 0 ? h("span", { class: "neq", "aria-hidden": "true" }, "≠") : null,
      h(
        "div",
        { class: `rung ${r.level === level ? "reached" : "not-reached"}`, role: "listitem", "aria-current": String(r.level === level) },
        h("strong", {}, r.title),
        h("div", { class: "mono" }, r.verdicts),
        h("div", { class: "muted" }, r.level === level ? `este candidate: ${r.needs}` : `não comprovado — exige: ${r.needs}`),
      ),
    ]),
  );
}

function comparisonTable(rows: MetricComparison[]) {
  return rows.length
    ? h("table", {}, rows.map((m) => h("tr", {}, h("td", {}, m.label), h("td", { class: "num" }, `${m.baseline ?? "—"} → ${m.candidate ?? "—"}`), h("td", {}, badge(m.outcome)))))
    : h("p", { class: "muted" }, "Nenhuma.");
}

function constraintTable(rows: ConstraintResult[]) {
  return rows.length ? h("table", {}, rows.map((k) => h("tr", {}, h("td", {}, k.name), h("td", {}, badge(k.status)), h("td", { class: "muted" }, k.detail)))) : h("p", { class: "muted" }, "Sem resultado.");
}

async function renderCandidate(id: string): Promise<void> {
  const d = await api<CandidateDetail>(`/api/candidates/${encodeURIComponent(id)}`);
  const c = d.candidate;
  const e = d.evidence;
  const { verdict, recordedVerdict, stale } = d.assessment;
  const who = h("input", { "aria-label": "Quem aceita", placeholder: "seu nome", size: 14 });
  const current = Boolean(state?.baseline?.current);
  $("#candidate").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, `Candidate Evidence · ${c.id} · geração ${c.generation}`),
      h("p", { class: "muted" }, `baseline ${short(c.parentRevision)} → candidate ${c.revision ? short(c.revision) : "—"}`, c.reevaluationOf ? ` · reavaliação de ${c.reevaluationOf}` : ""),
      verdict
        ? h("div", { class: "verdict" }, badge(verdict), " ", h("span", { class: "muted" }, VERDICT_HELP[verdict] ?? ""), verdict === "STALE" && recordedVerdict ? h("span", { class: "muted" }, ` (registrado: ${recordedVerdict})`) : null)
        : h("p", { class: "muted" }, `Sem decisão (${c.status}).`),
      e ? ladder(e.level) : null,
      stale.length && c.revision ? h("p", {}, h("button", { disabled: Boolean(state?.running) || !current, onclick: () => act(() => api(`/api/candidates/${encodeURIComponent(c.id)}/reevaluate`, { method: "POST", body: {} })) }, "Reavaliar contra a baseline atual")) : null,
      verdict && ACCEPTABLE.has(verdict) && c.status === "evaluated"
        ? h(
            "div",
            { class: "row" },
            h("span", {}, "Aceitar faz fast-forward da baseline até ", h("span", { class: "mono" }, c.revision ? short(c.revision) : ""), ". Sem push nem deploy; a próxima observação julga o experimento."),
            who,
            h("button", { class: "primary", onclick: () => act(() => api(`/api/candidates/${encodeURIComponent(c.id)}/accept`, { method: "POST", body: { by: who.value } })) }, "Aceitar como nova baseline"),
          )
        : null,
      e
        ? [
            h(
              "div",
              { class: "claims-box" },
              h("h3", {}, "Alegações do MutationProvider — não são evidência"),
              h("p", {}, h("span", { class: "basis b-claim" }, "ALEGAÇÃO"), " ", e.claims.hypothesis),
              e.claims.claims ? h("p", {}, h("span", { class: "basis b-claim" }, "ALEGAÇÃO"), " ", e.claims.claims) : null,
              h("p", { class: "muted" }, `origem: ${e.claims.source}. A decisão não usa nada deste quadro.`),
            ),
            h(
              "div",
              { class: "evidence-box" },
              h("h3", {}, "Evidência independente e análise"),
              section("Por que este veredito", statements(e.rationale)),
              section("Intent", statements(e.intent)),
              section("O que mudou", statements(e.changeSummary)),
              section("Hipótese da missão", statements(e.missionHypothesis)),
              section(
                "Arquivos e componentes",
                h(
                  "table",
                  {},
                  h("tr", {}, h("th", {}, "Arquivo"), h("th", {}, "Componente (heurística)"), h("th", {}, "±")),
                  e.affected.map((f) => h("tr", {}, h("td", { class: "mono" }, `${f.status} ${f.path}`), h("td", {}, f.component, h("div", { class: "muted" }, f.kind)), h("td", { class: "num" }, f.added === null ? "bin" : `+${f.added} −${f.removed}`))),
                ),
              ),
              section("Blast radius", statements(e.blastRadius)),
              section("Riscos e incertezas", statements(e.risks)),
              section("Envelope · HARD", constraintTable(e.envelope.hard)),
              section("Envelope · SOFT (aviso, nunca melhora o veredito)", constraintTable(e.envelope.soft)),
              section(
                "Evidência proxy (medida no candidate)",
                comparisonTable(e.proxies),
                h("table", {}, e.guards.map((g) => h("tr", {}, h("td", {}, `protegida: ${g.label}`), h("td", { class: "num" }, `${g.value ?? "—"} (${g.operator} ${g.threshold})`), h("td", {}, badge(g.status))))),
              ),
              section("Evidência outcome (só em uso real da baseline)", comparisonTable(e.outcomes), h("p", { class: "muted" }, "Candidates nunca são medidos por telemetria: outcomes aparecem aqui como sem dados até um experimento aceito rodar em uso real.")),
              section("Proveniência", statements(e.provenance)),
            ),
          ]
        : null,
      h(
        "details",
        {},
        h("summary", {}, "Detalhes brutos (avaliações, eventos, diff)"),
        d.evaluations.map((ev) =>
          h(
            "details",
            {},
            h("summary", {}, badge(ev.status), ` ${ev.evaluatorId} · ${ev.durationMs} ms`, ev.errors[0] ? h("span", { class: "muted" }, ` — ${ev.errors[0]}`) : null),
            ev.measurements.length ? h("table", {}, ev.measurements.map((m) => h("tr", {}, h("td", { class: "mono" }, m.metric), h("td", { class: "num" }, fmt(m)), h("td", {}, m.status === "MEASURED" ? "" : badge(m.status))))) : null,
            ev.evidence.map((x) => [h("p", {}, x.summary), x.detail ? h("pre", {}, x.detail) : null]),
          ),
        ),
        h("ul", { class: "events" }, d.events.map((ev) => h("li", {}, h("time", {}, time(ev.createdAt)), h("strong", {}, ev.kind)))),
        d.diff ? h("pre", {}, d.diff) : null,
      ),
    ),
  );
}

function renderRecorder(events: HabitatEvent[]): void {
  $("#recorder").replaceChildren(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Gravador de voo"),
      h(
        "ul",
        { class: "events" },
        events.map((e) =>
          h(
            "li",
            {},
            h("time", {}, time(e.createdAt)),
            h("strong", {}, e.kind),
            e.candidateId ? h("span", { class: "mono" }, ` ${e.candidateId}`) : null,
            e.data ? h("div", { class: "muted" }, summarize(e.data)) : null,
          ),
        ),
      ),
    ),
  );
}

function summarize(data: Record<string, unknown>): string {
  const text = Object.entries(data)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

await refresh();
// Jobs take seconds to minutes; poll gently, faster while one runs.
const tick = async (): Promise<void> => {
  await refresh();
  setTimeout(() => void tick(), state?.running ? 2000 : 10_000);
};
setTimeout(() => void tick(), 2000);
