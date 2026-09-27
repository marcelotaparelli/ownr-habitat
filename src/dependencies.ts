import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { minimalEnv, runCommand } from "./command.ts";
import type { DependencyProvider, DependencyTree, OrganismRepository } from "./ports.ts";

export class DependencyError extends Error {
  override readonly name = "DependencyError";
}

const Manifest = z.object({ lockfile: z.string(), tree: z.string(), createdAt: z.number() });

export type HermeticOptions = {
  /** Files that determine the tree, read from the evaluated revision (never from a working copy). */
  manifests: string[];
  /** Installs from those files into the current directory, offline-reproducible and without lifecycle scripts. */
  install: string[];
  installTimeoutMs: number;
};

export const BUN_FROZEN_INSTALL: HermeticOptions = {
  manifests: ["package.json", "bun.lock"],
  install: [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
  installTimeoutMs: 300_000,
};

/**
 * Dependency trees keyed by the content of the revision's manifests (package.json + lockfile).
 * A tree is built once from those files alone, hashed (every path, mode, file content and symlink
 * target), made read-only and recorded. Every use re-verifies it: a tree that changed on disk is
 * quarantined and rebuilt, and must reproduce the recorded hash — otherwise evaluation is refused.
 * The organism's own node_modules is never used.
 */
export class HermeticDependencies implements DependencyProvider {
  constructor(
    private readonly repository: Pick<OrganismRepository, "contentHash" | "readFile">,
    private readonly root: string,
    private readonly options: HermeticOptions = BUN_FROZEN_INSTALL,
  ) {}

  async identify(revision: string): Promise<{ lockfile: string; tree: string | null; dir: string | null }> {
    const lockfile = await this.repository.contentHash(revision, this.options.manifests);
    const manifest = this.manifest(lockfile);
    return { lockfile, tree: manifest?.tree ?? null, dir: manifest ? this.modules(lockfile) : null };
  }

  async ensure(revision: string): Promise<DependencyTree & { rebuilt: "fresh" | "tampered" | null }> {
    const lockfile = await this.repository.contentHash(revision, this.options.manifests);
    const recorded = this.manifest(lockfile);
    if (recorded && existsSync(this.modules(lockfile))) {
      const tree = treeHash(this.modules(lockfile));
      if (tree === recorded.tree) return { dir: this.modules(lockfile), lockfile, tree, rebuilt: null };
      // Someone changed a tree that evidence depends on: keep it for inspection, rebuild from the lockfile.
      renameSync(join(this.root, lockfile), join(this.root, `${lockfile}.tampered-${Date.now()}`));
    }
    const built = await this.build(revision, lockfile);
    if (recorded && built !== recorded.tree) {
      throw new DependencyError(`árvore de dependências não reproduzível para o lockfile ${lockfile}: registrada ${recorded.tree}, reconstruída ${built}`);
    }
    if (!recorded) writeFileSync(join(this.root, `${lockfile}.json`), JSON.stringify({ lockfile, tree: built, createdAt: Date.now() }));
    return { dir: this.modules(lockfile), lockfile, tree: built, rebuilt: recorded ? "tampered" : "fresh" };
  }

  async verify(tree: DependencyTree): Promise<void> {
    const now = existsSync(tree.dir) ? treeHash(tree.dir) : "ausente";
    if (now !== tree.tree) throw new DependencyError(`a árvore de dependências mudou durante a avaliação (${tree.tree} → ${now})`);
  }

  private async build(revision: string, lockfile: string): Promise<string> {
    mkdirSync(this.root, { recursive: true });
    const staging = join(this.root, `${lockfile}.tmp-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(staging);
    try {
      for (const path of this.options.manifests) {
        const content = await this.repository.readFile(revision, path);
        if (content === null) throw new DependencyError(`${path} ausente na revisão ${revision.slice(0, 10)}: árvore não determinável`);
        writeFileSync(join(staging, path), content);
      }
      const result = await runCommand(this.options.install, { cwd: staging, timeoutMs: this.options.installTimeoutMs, env: minimalEnv() });
      if (result.exitCode !== 0) throw new DependencyError(`instalação a partir do lockfile falhou: ${(result.stderr || result.stdout).trim().slice(-500)}`);
      const modules = join(staging, "node_modules");
      if (!existsSync(modules)) mkdirSync(modules);
      const tree = treeHash(modules);
      makeReadOnly(staging);
      renameSync(staging, join(this.root, lockfile));
      return tree;
    } catch (error) {
      if (existsSync(staging)) {
        makeWritable(staging);
        rmSync(staging, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private modules(lockfile: string): string {
    return join(this.root, lockfile, "node_modules");
  }

  private manifest(lockfile: string): z.infer<typeof Manifest> | undefined {
    const path = join(this.root, `${lockfile}.json`);
    return existsSync(path) ? Manifest.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
  }
}

/** Content identity of a directory tree: relative paths, types, executable bits, file bytes, link targets. */
export function treeHash(dir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(dir, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const full = join(dir, path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) hasher.update(`l ${path} ${readlinkSync(full)}\n`);
      else if (stat.isDirectory()) {
        hasher.update(`d ${path}\n`);
        walk(path);
      } else hasher.update(`f ${path} ${stat.mode & 0o111 ? "x" : "-"} ${new Bun.CryptoHasher("sha256").update(readFileSync(full)).digest("hex")}\n`);
    }
  };
  walk("");
  return hasher.digest("hex").slice(0, 16);
}

function makeReadOnly(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) makeReadOnly(full);
    chmodSync(full, lstatSync(full).mode & ~0o222);
  }
  chmodSync(dir, lstatSync(dir).mode & ~0o222);
}

function makeWritable(dir: string): void {
  chmodSync(dir, lstatSync(dir).mode | 0o200);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(join(dir, entry.name));
  }
}
