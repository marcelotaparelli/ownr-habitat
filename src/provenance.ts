import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { canonical, sha256 } from "./identity.ts";
import type { OrganismRepository } from "./ports.ts";
import type { CommandRunner, RunnerIdentity } from "./runner.ts";

/** Everything about how evidence was produced that is not the evaluator itself nor the evaluated code. */
export type EnvironmentDetail = {
  /** Reported by the runtime from inside the runner, not assumed from the host. */
  runtime: { bun: string };
  runner: RunnerIdentity;
  dependencies: {
    /** Content identity of the organism's lockfile(s) at the evaluated revision. */
    lockfile: string;
    /** Identity of the installed dependency tree the commands actually used (name@version of every package). */
    installed: string;
    /** Versions of the tools that matter for the evidence (e.g. typescript), as installed. */
    tools: Record<string, string>;
  };
};

export type Environment = { hash: string; detail: EnvironmentDetail };

export type EnvironmentOptions = {
  /** Host directory with the organism's installed dependencies (null when it has none). */
  dependencies: string | null;
  lockfiles: string[];
  tools: string[];
};

const PackageJson = z.object({ name: z.string(), version: z.string() });

/**
 * Identifies the execution environment of each revision. Two pieces of evidence are comparable only
 * when their environments hash the same; when the environment changes, older evidence goes STALE.
 */
export class ExecutionEnvironment {
  private constructor(
    private readonly runner: CommandRunner,
    private readonly runtime: { bun: string },
    private readonly options: EnvironmentOptions,
    private readonly repository: OrganismRepository,
  ) {}

  /** Asks the runtime, through the runner itself, which version it is. */
  static async probe(runner: CommandRunner, options: EnvironmentOptions, repository: OrganismRepository): Promise<ExecutionEnvironment> {
    const empty = mkdtempSync(join(tmpdir(), "habitat-probe-"));
    try {
      const result = await runner.run(["bun", "--revision"], { workspace: empty, timeoutMs: 30_000 });
      const bun = result.stdout.trim();
      if (result.exitCode !== 0 || !/^\d+\.\d+\.\d+/.test(bun)) throw new Error(`não foi possível identificar o runtime no runner ${runner.identity.kind}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
      return new ExecutionEnvironment(runner, { bun }, options, repository);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }

  async at(revision: string): Promise<Environment> {
    const installed = this.options.dependencies ? installedPackages(this.options.dependencies) : new Map<string, string>();
    const detail: EnvironmentDetail = {
      runtime: this.runtime,
      runner: this.runner.identity,
      dependencies: {
        lockfile: await this.repository.contentHash(revision, this.options.lockfiles),
        installed: sha256(canonical([...installed].sort(([a], [b]) => (a < b ? -1 : 1)))).slice(0, 16),
        tools: Object.fromEntries(this.options.tools.map((tool) => [tool, installed.get(tool) ?? "ausente"])),
      },
    };
    return { hash: sha256(canonical(detail)).slice(0, 16), detail };
  }
}

/** name → version of every top-level (and scoped) package in a node_modules directory. */
function installedPackages(dir: string): Map<string, string> {
  const packages = new Map<string, string>();
  if (!existsSync(dir)) return packages;
  const read = (path: string): void => {
    const manifest = join(path, "package.json");
    if (!existsSync(manifest)) return;
    const parsed = PackageJson.safeParse(JSON.parse(readFileSync(manifest, "utf8")));
    if (parsed.success) packages.set(parsed.data.name, parsed.data.version);
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) for (const scoped of readdirSync(join(dir, entry.name))) read(join(dir, entry.name, scoped));
    else read(join(dir, entry.name));
  }
  return packages;
}
