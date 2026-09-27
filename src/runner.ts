import { COMMAND_SOURCE, minimalEnv, runCommand, type CommandResult } from "./command.ts";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { deriveVersion } from "./identity.ts";

/** What produced a piece of evidence: part of the execution provenance bound to it. */
export type RunnerIdentity = {
  kind: "linux-sandbox" | "trusted-local";
  /** Derived from the runner's implementation and its limits/allowlists (see identity.ts). */
  version: string;
  /** Human-readable limits and isolation, recorded with the evidence. */
  description: string;
};

export type RunOptions = {
  /** The evaluated checkout. The only writable location a sandboxed command sees (as /work). */
  workspace: string;
  timeoutMs: number;
  /** Hermetic dependency tree for this run (read-only as <workspace>/node_modules), or null. */
  dependencies?: string | null;
};

export type RunResult = CommandResult & {
  /** What stopped the command, when something did: a cgroup limit, or seccomp (a forbidden syscall — a sandbox violation). */
  limit: "memory" | "pids" | "seccomp" | null;
};

/** How organism commands are executed. The only way evaluators run organism code. */
export interface CommandRunner {
  readonly identity: RunnerIdentity;
  run(argv: string[], options: RunOptions): Promise<RunResult>;
}

/**
 * Runs commands directly on the host, with the user's rights and a minimal environment.
 * NOT A SECURITY BOUNDARY: only for organisms whose every candidate is trusted (explicit opt-in).
 */
export class TrustedLocalRunner implements CommandRunner {
  readonly identity: RunnerIdentity = {
    kind: "trusted-local",
    version: deriveVersion([import.meta.path, COMMAND_SOURCE], { env: Object.keys(minimalEnv()).sort() }),
    description: "trusted-local: host, sem isolamento (NÃO é fronteira de segurança)",
  };

  async run(argv: string[], options: RunOptions): Promise<RunResult> {
    // Same layout as the sandbox; but on the host nothing stops the command from writing through the link.
    const link = join(options.workspace, "node_modules");
    if (options.dependencies && !existsSync(link)) symlinkSync(options.dependencies, link, "dir");
    return { ...(await runCommand(argv, { cwd: options.workspace, timeoutMs: options.timeoutMs, env: minimalEnv() })), limit: null };
  }
}
