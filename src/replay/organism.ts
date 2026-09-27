import type { Mission, Organism } from "../domain.ts";
import { CommandEvaluator, PathPolicyEvaluator } from "../evaluators.ts";
import type { Evaluator } from "../ports.ts";
import type { CommandRunner } from "../runner.ts";

/**
 * OWNR Replay as the first Organism, referenced by its repository and baseline ref. This adapter is
 * control plane: it lives in Habitat, and what it allows candidates to touch excludes the Replay's
 * tests, sources and instruments (scripts/measure.ts).
 */
export function replayOrganism(repositoryPath: string, baselineRef: string): Organism {
  return {
    id: "ownr-replay",
    name: "OWNR Replay",
    repositoryPath,
    baselineRef,
    allowedPaths: ["data/golden/ops-triage-ai/stages/**", "data/golden/ops-triage-ai/journey.json", "scripts/author-golden-m1.ts"],
  };
}

export const REPLAY_TTVO_MISSION: Mission = {
  id: "replay-ttvo-m1",
  organismId: "ownr-replay",
  objective: "Reduzir o Time To Verified Ownership do Module 1 sem reduzir corretude nem retenção.",
  status: "active",
  desiredState: [
    { metric: "m1.max_new_lines", label: "Maior novidade por micro etapa", operator: "<=", target: 5, unit: "linhas" },
    { metric: "m1.stages_above_5", label: "Micro etapas acima de 5 linhas novas", operator: "<=", target: 3 },
    { metric: "replay.median_microstage_seconds", label: "Tempo mediano por micro etapa", operator: "<=", target: 120, unit: "s", minSampleSize: 30 },
    { metric: "replay.checkpoint_success_rate", label: "Sucesso no checkpoint do módulo", operator: ">=", target: 0.9, minSampleSize: 10 },
    { metric: "replay.novel_change_success_rate", label: "Sucesso em mudança inédita (prova de ownership)", operator: ">=", target: 0.8, minSampleSize: 10 },
  ],
  fitness: {
    // Proxies are measured on each candidate; they are hypotheses about the outcomes, which only real use can show.
    objectives: [
      { metric: "m1.stages_above_5", label: "Micro etapas acima de 5 linhas novas", direction: "minimize", kind: "proxy" },
      { metric: "m1.max_new_lines", label: "Maior novidade por micro etapa", direction: "minimize", kind: "proxy" },
      { metric: "m1.mean_new_lines", label: "Novidade média por micro etapa", direction: "minimize", kind: "proxy" },
      { metric: "replay.median_microstage_seconds", label: "Tempo mediano por micro etapa (TTVO)", direction: "minimize", kind: "outcome", minSampleSize: 30 },
      { metric: "replay.checkpoint_success_rate", label: "Sucesso no checkpoint do módulo", direction: "maximize", kind: "outcome", minSampleSize: 10 },
      { metric: "replay.novel_change_success_rate", label: "Sucesso em mudança inédita", direction: "maximize", kind: "outcome", minSampleSize: 10 },
    ],
    guards: [
      { metric: "m1.concepts_introduced", label: "Conceitos ensinados no Module 1", operator: ">=", threshold: 15, reason: "menos novidade não pode vir de ensinar menos" },
      { metric: "m1.checkpoint_present", label: "Checkpoint do módulo", operator: "==", threshold: 1, reason: "a reconstrução do zero é a prova de retenção" },
      { metric: "m1.micro_stages", label: "Micro etapas no Module 1", operator: "<=", threshold: 22, reason: "fatiar demais troca carga cognitiva por fricção de navegação" },
      { metric: "m1.max_line_length", label: "Maior linha de código mostrada", operator: "<=", threshold: 100, reason: "empacotar código em linhas longas reduz a contagem sem reduzir a novidade" },
    ],
  },
  envelope: {
    id: "replay-envelope-v1",
    constraints: [
      { id: "paths", name: "Só caminhos permitidos (sem tocar testes, avaliadores ou o Habitat)", severity: "hard", evaluatorId: "path-policy" },
      { id: "typecheck", name: "Typecheck (tsc --noEmit)", severity: "hard", evaluatorId: "typecheck" },
      { id: "tests", name: "Suíte de testes (bun test)", severity: "hard", evaluatorId: "tests" },
      { id: "curriculum", name: "Currículo válido (validador do plano de controle)", severity: "hard", evaluatorId: "replay-curriculum" },
      {
        id: "novelty-justified",
        name: "Etapa com 8+ linhas novas exige justificativa",
        severity: "hard",
        evaluatorId: "replay-curriculum",
        metric: "m1.unjustified_large_stages",
        operator: "==",
        threshold: 0,
      },
      { id: "bundle", name: "Frontend ≤ 60 KB gzip", severity: "soft", evaluatorId: "replay-bundle", metric: "web.bundle_gzip_kb", operator: "<=", threshold: 60 },
      { id: "max-novelty", name: "Nenhuma micro etapa acima de 8 linhas novas", severity: "soft", evaluatorId: "replay-curriculum", metric: "m1.max_new_lines", operator: "<=", threshold: 8 },
    ],
    uncovered: [
      { name: "Segurança (varredura de dependências e segredos)", reason: "nenhum avaliador de segurança instalado" },
      { name: "E2E em navegador (Chromium e Firefox)", reason: "rodado manualmente fora do Habitat; não automatizado aqui" },
      { name: "Performance p95 da API", reason: "sem carga sintética nem telemetria de latência por versão" },
      { name: "Acessibilidade", reason: "nenhum avaliador de acessibilidade instalado" },
    ],
  },
  // Raw telemetry is not evidence. Each metric is trusted only from its source, and values are compared
  // only while the organism code that produces them (the instrument) is byte-identical on both sides.
  evidence: {
    sources: {
      "m1.max_new_lines": "replay-curriculum",
      "m1.stages_above_5": "replay-curriculum",
      "m1.mean_new_lines": "replay-curriculum",
      "m1.unjustified_large_stages": "replay-curriculum",
      "m1.concepts_introduced": "replay-curriculum",
      "m1.checkpoint_present": "replay-curriculum",
      "m1.micro_stages": "replay-curriculum",
      "m1.max_line_length": "replay-curriculum",
      "web.bundle_gzip_kb": "replay-bundle",
      "replay.median_microstage_seconds": "telemetry",
      "replay.checkpoint_success_rate": "telemetry",
      "replay.novel_change_success_rate": "telemetry",
    },
    instruments: {
      "replay-curriculum": ["scripts/measure.ts", "src/services/curriculum.ts", "src/services/curriculum-check.ts", "src/domain/line-diff.ts", "src/domain/stage.ts", "src/domain/journey.ts"],
      "replay-bundle": ["scripts/measure.ts", "src/web-assets.ts"],
      // Everything that decides what a learning event means: emitted in the browser, recorded by the API.
      telemetry: ["web/app.ts", "web/store.ts", "web/stage-view.ts", "web/api.ts", "src/http/api.ts", "src/db/repository.ts", "src/db/schema.sql", "src/domain/progress.ts"],
    },
  },
};

/**
 * Evaluators run in this order after the path policy, in the evaluated checkout. The curriculum and
 * bundle measurements come from the organism's own instrument, protected from candidates by the path policy.
 */
export function replayEvaluators(organism: Organism, runner: CommandRunner): { pathPolicy: Evaluator; evaluators: Evaluator[] } {
  return {
    pathPolicy: new PathPolicyEvaluator(organism.allowedPaths),
    evaluators: [
      new CommandEvaluator("replay-curriculum", ["bun", "scripts/measure.ts", "curriculum"], { timeoutMs: 60_000, output: "probe" }, runner),
      new CommandEvaluator("replay-bundle", ["bun", "scripts/measure.ts", "bundle"], { timeoutMs: 60_000, output: "probe" }, runner),
      new CommandEvaluator("typecheck", ["bunx", "tsc", "--noEmit"], { timeoutMs: 180_000, output: "exit-code" }, runner),
      new CommandEvaluator("tests", ["bun", "test"], { timeoutMs: 600_000, output: "bun-test" }, runner),
    ],
  };
}
