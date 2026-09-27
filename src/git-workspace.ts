import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { FileChange } from "./domain.ts";
import { minimalEnv, runCommand } from "./command.ts";
import { canonical, sha256 } from "./identity.ts";
import type { CandidateWorkspace, OrganismRepository, Workspace } from "./ports.ts";

const GIT_TIMEOUT_MS = 60_000;

/**
 * Candidates live in their own `git worktree`, detached at the baseline revision.
 * The baseline checkout is never touched; candidate revisions are kept under
 * refs/habitat/candidates/* so failed candidates remain inspectable.
 * Isolation of files, not of processes: NOT A SECURITY BOUNDARY.
 */
export class GitWorktreeWorkspace implements CandidateWorkspace {
  constructor(
    private readonly repository: string,
    private readonly root: string,
    /** Shared read-only toolchain (node_modules) linked into each worktree; never installed per candidate. */
    private readonly linkDirs: string[] = ["node_modules"],
  ) {}

  async prepare(id: string, revision: string): Promise<Workspace> {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`invalid workspace id ${id}`);
    mkdirSync(this.root, { recursive: true });
    const dir = join(this.root, id);
    if (existsSync(dir)) await this.remove(dir);
    await this.git(["worktree", "add", "--detach", dir, revision]);
    for (const name of this.linkDirs) {
      const source = join(this.repository, name);
      if (existsSync(source)) symlinkSync(source, join(dir, name), "dir");
    }
    return { id, dir, revision };
  }

  async mutate(workspace: Workspace, patch: string, message: string): Promise<{ revision: string; changes: FileChange[] }> {
    const patchFile = join(this.root, `${workspace.id}.patch`);
    await Bun.write(patchFile, patch);
    try {
      await this.git(["apply", "--index", "--whitespace=nowarn", patchFile], workspace.dir);
    } finally {
      rmSync(patchFile, { force: true });
    }
    await this.git(["-c", "user.name=OWNR Habitat", "-c", "user.email=habitat@ownr.local", "commit", "--no-verify", "--quiet", "-m", message], workspace.dir);
    const revision = (await this.git(["rev-parse", "HEAD"], workspace.dir)).trim();
    return { revision, changes: await this.changes(workspace.revision, revision) };
  }

  async retain(id: string, revision: string): Promise<void> {
    await this.git(["update-ref", `refs/habitat/candidates/${id}`, revision]);
  }

  async dispose(workspace: Workspace): Promise<void> {
    await this.remove(workspace.dir);
  }

  async changes(from: string, to: string): Promise<FileChange[]> {
    // --raw exposes file modes, so a symlink (120000) cannot hide behind an ordinary path.
    const raw = await this.git(["diff", "--raw", "--no-renames", "-z", from, to]);
    const fields = raw.split("\0").filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const meta = fields[i] ?? "";
      const path = fields[i + 1] ?? "";
      const [oldMode = "", newMode = "", , , status = ""] = meta.replace(/^:/, "").split(" ");
      changes.push({ path, status, oldMode, newMode });
    }
    return changes;
  }

  async patchBetween(from: string, to: string): Promise<string> {
    return this.git(["diff", "--binary", "--no-renames", from, to]);
  }

  async isAncestor(ancestor: string, revision: string): Promise<boolean> {
    // Exit 0 = ancestor, 1 = not; anything else is a real failure.
    const result = await runCommand(["git", "merge-base", "--is-ancestor", ancestor, revision], { cwd: this.repository, timeoutMs: GIT_TIMEOUT_MS, env: minimalEnv() });
    if (result.exitCode === 0 || result.exitCode === 1) return result.exitCode === 0;
    throw new Error(`git merge-base falhou: ${result.stderr.trim().slice(0, 300)}`);
  }

  async diff(from: string, to: string): Promise<string> {
    return this.git(["diff", "--stat", "--patch", from, to]);
  }

  private async remove(dir: string): Promise<void> {
    // git may already have forgotten the worktree (e.g. a crash mid-prepare): the rm below is the real cleanup.
    await this.git(["worktree", "remove", "--force", dir]).catch(() => "already gone");
    rmSync(dir, { recursive: true, force: true });
    await this.git(["worktree", "prune"]);
  }

  private async git(args: string[], cwd = this.repository): Promise<string> {
    const result = await runCommand(["git", ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS, env: minimalEnv() });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} falhou: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return result.stdout;
  }
}

/**
 * The organism as Habitat sees it: a git repository and the ref that names its baseline.
 * The baseline revision is always read from the organism (`rev-parse <baselineRef>`), never from Habitat.
 */
export class GitOrganism implements OrganismRepository {
  readonly ref: string;

  constructor(
    readonly repository: string,
    baselineRef: string,
  ) {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baselineRef) || baselineRef.includes("..")) throw new Error(`invalid baseline ref ${baselineRef}`);
    this.ref = baselineRef.startsWith("refs/") ? baselineRef : `refs/heads/${baselineRef}`;
  }

  async baselineRevision(): Promise<string> {
    return (await this.git(["rev-parse", "--verify", "--quiet", `${this.ref}^{commit}`])).stdout.trim();
  }

  /**
   * Moves the baseline ref from `from` to `to`, fast-forward only. If the ref is checked out in the
   * organism's working tree, the checkout follows (git merge --ff-only refuses to clobber local edits);
   * otherwise the ref is compare-and-swapped, so a concurrent move makes this fail instead of overwrite.
   */
  async advanceBaseline(from: string, to: string): Promise<void> {
    if ((await this.baselineRevision()) !== from) throw new Error(`a baseline não é mais ${from.slice(0, 10)}`);
    const ancestor = await this.git(["merge-base", "--is-ancestor", from, to], [0, 1]);
    if (ancestor.exitCode !== 0) throw new Error(`${to.slice(0, 10)} não descende de ${from.slice(0, 10)}: não é fast-forward`);
    const head = await this.git(["symbolic-ref", "--quiet", "HEAD"], [0, 1]);
    if (head.exitCode === 0 && head.stdout.trim() === this.ref) await this.git(["merge", "--ff-only", "--quiet", to]);
    else await this.git(["update-ref", this.ref, to, from]);
  }

  /** Git blob ids are content hashes: the tree listing of these paths at a revision identifies their content. */
  async contentHash(revision: string, paths: string[]): Promise<string> {
    if (paths.length === 0) return sha256("[]").slice(0, 16);
    const listing = await this.git(["ls-tree", "-r", "--full-tree", revision, "--", ...paths]);
    const present = listing.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta = "", path = ""] = line.split("\t");
        return [path, meta.split(" ")[2] ?? ""];
      });
    const found = new Set(present.map(([path]) => path));
    const absent = paths.filter((p) => !found.has(p) && !present.some(([path]) => path?.startsWith(`${p}/`))).map((p) => [p, "absent"]);
    return sha256(canonical([...present, ...absent].sort(([a], [b]) => ((a ?? "") < (b ?? "") ? -1 : 1)))).slice(0, 16);
  }

  private async git(args: string[], accept: number[] = [0]): Promise<{ exitCode: number; stdout: string }> {
    const result = await runCommand(["git", ...args], { cwd: this.repository, timeoutMs: GIT_TIMEOUT_MS, env: minimalEnv() });
    if (result.exitCode === null || !accept.includes(result.exitCode)) throw new Error(`git ${args[0]} falhou: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    return { exitCode: result.exitCode, stdout: result.stdout };
  }
}
