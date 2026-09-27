import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonical, sha256 } from "./identity.ts";
import type { DependencyProvider } from "./ports.ts";
import type { CommandRunner, RunnerIdentity } from "./runner.ts";

/** Everything about how evidence was produced that is not the evaluator itself nor the evaluated code. */
export type EnvironmentDetail = {
  /** Reported by the runtime from inside the runner, not assumed from the host. */
  runtime: { bun: string };
  runner: RunnerIdentity;
  dependencies: {
    /** Content identity of the manifests (package.json + lockfile) at the evaluated revision. */
    lockfile: string;
    /** Content identity of the hermetic tree built from them ("não construída" before the first build). */
    tree: string;
    /** Versions of the tools that matter for the evidence (e.g. typescript), read from that tree. */
    tools: Record<string, string>;
  };
};

export type Environment = { hash: string; detail: EnvironmentDetail };

export type EnvironmentOptions = { tools: string[] };

const PackageJson = z.object({ version: z.string() });

/**
 * Identifies the execution environment of each revision. Two pieces of evidence are comparable only
 * when their environments hash the same; when the environment changes, older evidence goes STALE.
 */
export class ExecutionEnvironment {
  private constructor(
    private readonly runner: CommandRunner,
    private readonly runtime: { bun: string },
    private readonly options: EnvironmentOptions,
    private readonly dependencies: DependencyProvider | null,
  ) {}

  /** Asks the runtime, through the runner itself, which version it is. */
  static async probe(runner: CommandRunner, options: EnvironmentOptions, dependencies: DependencyProvider | null): Promise<ExecutionEnvironment> {
    const empty = mkdtempSync(join(tmpdir(), "habitat-probe-"));
    try {
      const result = await runner.run(["bun", "--revision"], { workspace: empty, timeoutMs: 30_000 });
      const bun = result.stdout.trim();
      if (result.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(bun)) throw new Error(`não foi possível identificar o runtime no runner ${runner.identity.kind}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
      return new ExecutionEnvironment(runner, { bun }, options, dependencies);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  async at(revision: string): Promise<Environment> {
    const deps = this.dependencies ? await this.dependencies.identify(revision) : null;
    const detail: EnvironmentDetail = {
      runtime: this.runtime,
      runner: this.runner.identity,
      dependencies: {
        lockfile: deps?.lockfile ?? "sem dependências",
        tree: deps?.tree ?? (deps ? "não construída" : "sem dependências"),
        tools: Object.fromEntries(this.options.tools.map((tool) => [tool, deps?.dir ? versionOf(deps.dir, tool) : "ausente"])),
      },
    };
    return { hash: sha256(canonical(detail)).slice(0, 16), detail };
  }
}

function versionOf(modules: string, tool: string): string {
  const manifest = join(modules, tool, "package.json");
  if (!existsSync(manifest)) return "ausente";
  const parsed = PackageJson.safeParse(JSON.parse(readFileSync(manifest, "utf8")));
  return parsed.success ? parsed.data.version : "ilegível";
}
