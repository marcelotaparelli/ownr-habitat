import { z } from "zod";
import { COMMAND_SOURCE, tail } from "./command.ts";
import type { EvaluationResult, Evidence, Measurement } from "./domain.ts";
import { deriveVersion } from "./identity.ts";
import type { EvaluationContext, Evaluator } from "./ports.ts";
import type { CommandRunner } from "./runner.ts";

const SYMLINK_MODE = "120000";
/** This file implements every evaluator below: its content is part of their identity. */
const SOURCE = import.meta.path;

/**
 * Candidates may only change the organism's allowed paths. This runs before anything
 * executes: a candidate that touches tests or instruments never gets to run code.
 */
export class PathPolicyEvaluator implements Evaluator {
  readonly id = "path-policy";
  readonly version: string;

  constructor(private readonly allowed: string[]) {
    this.version = deriveVersion([SOURCE], { allowed });
  }

  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const started = performance.now();
    const outside = context.changes.filter((c) => !pathAllowed(this.allowed, c.path));
    const symlinks = context.changes.filter((c) => c.newMode === SYMLINK_MODE);
    const errors = [
      ...outside.map((c) => `fora dos caminhos permitidos: ${c.path}`),
      ...symlinks.map((c) => `symlink não permitido: ${c.path}`),
    ];
    return {
      evaluatorId: this.id,
      status: context.changes.length > 0 && errors.length === 0 ? "PASS" : "FAIL",
      measurements: [{ metric: "candidate.changed_files", value: context.changes.length, status: "MEASURED" }],
      evidence: [{ kind: "files", summary: `${context.changes.length} arquivo(s) alterado(s)`, detail: context.changes.map((c) => `${c.status} ${c.path}`).join("\n") }],
      durationMs: Math.round(performance.now() - started),
      errors: context.changes.length === 0 ? ["o candidate não altera nada"] : errors,
    };
  }
}

/** Glob subset: "dir/**" (anything below) or an exact path. Paths with ".." or empty segments never match. */
export function pathAllowed(patterns: string[], path: string): boolean {
  if (path.split("/").some((part) => part === ".." || part === "")) return false;
  return patterns.some((pattern) => (pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern));
}

/**
 * How a command's output becomes evidence:
 * - exit-code: PASS iff exit 0.
 * - bun-test: exit code, plus pass/fail counts.
 * - probe: an organism instrument printing `{ measurements, evidence, problems }` as JSON on stdout;
 *   PASS iff exit 0, valid output and no problems.
 */
export type CommandOutput = "exit-code" | "bun-test" | "probe";

export type CommandEvaluatorConfig = { timeoutMs: number; output: CommandOutput };

/**
 * Runs a command in the evaluated checkout (argv, no shell) through a runner — the sandbox, unless the
 * organism was explicitly configured trusted-local — and judges only what it can verify. The runner is
 * not part of the evaluator's identity: it is part of the execution environment bound to the evidence.
 */
export class CommandEvaluator implements Evaluator {
  readonly version: string;

  constructor(
    readonly id: string,
    private readonly argv: string[],
    private readonly config: CommandEvaluatorConfig,
    private readonly runner: CommandRunner,
  ) {
    this.version = deriveVersion([SOURCE, COMMAND_SOURCE], { argv, ...config });
  }

  async evaluate(context: EvaluationContext): Promise<EvaluationResult> {
    const result = await this.runner.run(this.argv, { workspace: context.dir, timeoutMs: this.config.timeoutMs });
    const failure = result.limit
      ? `limite de ${result.limit === "memory" ? "memória" : "processos"} do sandbox atingido`
      : result.timedOut
        ? `excedeu ${this.config.timeoutMs} ms`
        : result.truncated
          ? "saída excedeu o limite"
          : result.exitCode === 0
            ? null
            : `código de saída ${result.exitCode}`;
    const provenance = { commands: [{ argv: this.argv, runner: this.runner.identity.kind, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, limit: result.limit }] };
    const command: Evidence = { kind: "command", summary: `${this.argv.join(" ")} → exit ${result.exitCode ?? "—"} em ${result.durationMs} ms`, detail: tail(`${result.stdout}\n${result.stderr}`, 40) };
    const duration: Measurement = { metric: `${this.id}.duration_ms`, value: result.durationMs, status: "MEASURED", unit: "ms" };
    const base = { evaluatorId: this.id, durationMs: result.durationMs, provenance };

    if (this.config.output === "probe") {
      const report = failure ? null : parseProbe(result.stdout);
      const errors = failure ? [failure] : report ? report.problems : ["saída do instrumento não é o JSON esperado"];
      return {
        ...base,
        status: errors.length === 0 ? "PASS" : "FAIL",
        measurements: [duration, ...(report?.measurements ?? [])],
        evidence: [{ ...command, detail: tail(result.stderr, 40) }, ...(report?.evidence ?? [])],
        errors,
      };
    }
    const counts = this.config.output === "bun-test" ? bunTestCounts(`${result.stdout}\n${result.stderr}`) : [];
    return { ...base, status: failure ? "FAIL" : "PASS", measurements: [duration, ...counts], evidence: [command], errors: failure ? [failure] : [] };
  }
}

const ProbeReport = z.object({
  measurements: z.array(z.object({ metric: z.string().min(1), value: z.number().nullable(), unit: z.string().exactOptional() })),
  evidence: z.array(z.object({ summary: z.string(), detail: z.string().exactOptional() })),
  problems: z.array(z.string()),
});

/** Instrument output is untrusted input: validated, never evaluated. */
function parseProbe(stdout: string): { measurements: Measurement[]; evidence: Evidence[]; problems: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    return null;
  }
  const parsed = ProbeReport.safeParse(raw);
  if (!parsed.success) return null;
  return {
    measurements: parsed.data.measurements.map((m) => ({ ...m, status: m.value === null ? "INSUFFICIENT_DATA" : "MEASURED" })),
    evidence: parsed.data.evidence.map((e) => ({ kind: "report", ...e })),
    problems: parsed.data.problems,
  };
}

/** "169 pass / 0 fail" from bun test output. */
export function bunTestCounts(output: string): Measurement[] {
  const pass = /^\s*(\d+) pass$/m.exec(output)?.[1];
  const fail = /^\s*(\d+) fail$/m.exec(output)?.[1];
  const out: Measurement[] = [];
  if (pass !== undefined) out.push({ metric: "tests.pass", value: Number(pass), status: "MEASURED" });
  if (fail !== undefined) out.push({ metric: "tests.fail", value: Number(fail), status: "MEASURED" });
  return out;
}

/** An evaluator that did not run must say so — it never counts as passing. */
export function notRun(evaluatorId: string, reason: string): EvaluationResult {
  return { evaluatorId, status: "NOT_RUN", measurements: [], evidence: [{ kind: "note", summary: reason }], durationMs: 0, errors: [reason] };
}
