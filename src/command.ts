/**
 * Runs one command as structured argv — no shell, so nothing in an argument is ever
 * interpreted. Bounded in time and output; the environment is explicit (no inherited
 * secrets). NOT A SECURITY BOUNDARY: the command runs on the host with the user's rights.
 */

export type CommandResult = {
  argv: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
};

export type CommandOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  /** Called when the command is killed for time or output: lets a runner kill everything the command started. */
  onKill?: () => void;
};

const DEFAULT_MAX_OUTPUT = 256 * 1024;

/** Part of the identity of every command-based evaluator: how commands run is how evidence is produced. */
export const COMMAND_SOURCE = import.meta.path;

/** Only what a toolchain needs; notably no API keys or tokens from the parent environment. */
export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", NO_COLOR: "1", FORCE_COLOR: "0" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return { ...env, ...extra };
}

export async function runCommand(argv: string[], options: CommandOptions): Promise<CommandResult> {
  const started = performance.now();
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  let truncated = false;
  const proc = Bun.spawn(argv, { cwd: options.cwd, env: options.env ?? minimalEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    options.onKill?.();
  }, options.timeoutMs);
  const onOverflow = (): void => {
    truncated = true;
    proc.kill("SIGKILL");
    options.onKill?.();
  };
  const [stdout, stderr, exitCode] = await Promise.all([readBounded(proc.stdout, max, onOverflow), readBounded(proc.stderr, max, onOverflow), proc.exited]);
  clearTimeout(timer);
  return { argv, exitCode: timedOut || truncated ? null : exitCode, stdout, stderr, durationMs: Math.round(performance.now() - started), timedOut, truncated };
}

// Deliberately a local copy of the organism's helper: the control plane must not depend on organism modules.
async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      onOverflow();
      return text + "\n[saída truncada]";
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** The last lines of an output, enough to act as evidence without storing megabytes. */
export function tail(text: string, lines = 30): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}
