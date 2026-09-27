import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_SOURCE, runCommand } from "./command.ts";
import { deriveVersion } from "./identity.ts";
import type { CommandRunner, RunOptions, RunResult, RunnerIdentity } from "./runner.ts";

export type SandboxLimits = {
  memoryMb: number;
  pids: number;
  /** CPU quota in cores (cgroup cpu.max). */
  cpus: number;
  /** Size of the private /tmp (counts against memory). */
  tmpMb: number;
};

export const DEFAULT_LIMITS: SandboxLimits = { memoryMb: 2048, pids: 512, cpus: 2, tmpMb: 512 };

/** The only environment a sandboxed command gets. Nothing is inherited from Habitat. */
const ENV_ALLOWLIST = ["PATH=/opt/bun/bin:/usr/bin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "NO_COLOR=1", "FORCE_COLOR=0", "LANG=C.UTF-8"];
const NOBODY = "65534";
const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_PARENT = join(CGROUP_ROOT, "ownr-habitat");
/** Installs the seccomp filter and execs the command; mounted read-only at /opt/habitat inside the sandbox. */
const SECCOMP_EXEC = fileURLToPath(new URL("./seccomp-exec.ts", import.meta.url));
/** Exit status of a process killed by SIGSYS: what a seccomp KILL_PROCESS looks like from outside. */
const SIGSYS_STATUS = 128 + 31;

/**
 * Runs as root on the host, only to put itself in the run's cgroup and enter fresh namespaces.
 * Arguments are passed positionally, never interpolated into the script.
 */
const ENTER = `set -eu
echo $$ > "$1/cgroup.procs"
init=$2
shift 2
exec unshare --net --pid --fork --mount --ipc --uts --cgroup --kill-child /bin/sh -c "$init" habitat-sandbox "$@"`;

/**
 * PID 1 of the sandbox, still root but only inside its namespaces: builds a minimal read-only root
 * (host /usr, the bun binary, the dependencies), a writable /work (the checkout) and private /tmp,
 * /dev and /proc, pivots into it, drops to nobody without capabilities and execs the command with
 * the allowlisted environment. Host paths other than those bound are unreachable.
 */
const INIT = `set -eu
root=$1 work=$2 deps=$3 bun=$4 tmpmb=$5 seccomp=$6
shift 6
mount --make-rprivate /
mount -t tmpfs -o mode=755,size=8m habitat-root "$root"
mkdir -p "$root/usr" "$root/proc" "$root/dev" "$root/tmp" "$root/work" "$root/opt/bun/bin" "$root/opt/habitat" "$root/.old"
ln -s usr/bin "$root/bin"; ln -s usr/lib "$root/lib"; ln -s usr/lib64 "$root/lib64"; ln -s usr/sbin "$root/sbin"
ro() { mount --bind "$1" "$2"; mount -o remount,bind,ro,nosuid,nodev "$2"; }
ro /usr "$root/usr"
touch "$root/opt/bun/bin/bun" "$root/opt/bun/bin/bunx"
ro "$bun" "$root/opt/bun/bin/bun"
ro "$bun" "$root/opt/bun/bin/bunx"
touch "$root/opt/habitat/seccomp-exec.ts"
ro "$seccomp" "$root/opt/habitat/seccomp-exec.ts"
chown -R ${NOBODY}:${NOBODY} "$work"
mount --bind "$work" "$root/work"
mount -o remount,bind,nosuid,nodev "$root/work"
if [ -n "$deps" ]; then mkdir -p "$root/work/node_modules"; ro "$deps" "$root/work/node_modules"; fi
mount -t tmpfs -o mode=1777,size=\${tmpmb}m,nosuid,nodev habitat-tmp "$root/tmp"
mount -t tmpfs -o mode=755,size=1m,nosuid habitat-dev "$root/dev"
for n in null zero random urandom; do touch "$root/dev/$n"; mount --bind "/dev/$n" "$root/dev/$n"; done
mkdir "$root/dev/shm"; mount -t tmpfs -o mode=1777,size=64m,nosuid,nodev habitat-shm "$root/dev/shm"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
cd "$root"
pivot_root . .old
umount -l /.old
rmdir /.old
mount -o remount,ro,bind /
cd /work
exec setpriv --reuid=${NOBODY} --regid=${NOBODY} --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- /usr/bin/env -i ${ENV_ALLOWLIST.join(" ")} /opt/bun/bin/bun /opt/habitat/seccomp-exec.ts "$@"`;

/**
 * Real isolation from Linux primitives (the same ones container runtimes use), for hosts without
 * Docker: network, PID, mount, IPC, UTS and cgroup namespaces; a minimal read-only root; the
 * checkout as the only writable path; cgroup v2 memory/PID/CPU limits; wall-clock timeout that
 * kills the whole cgroup; unprivileged user with no capabilities and no_new_privs; a default-deny
 * seccomp filter (see seccomp-exec.ts) on the command and everything it starts.
 * Not covered: a separate kernel (a VM/gVisor would add it).
 */
export class LinuxSandboxRunner implements CommandRunner {
  readonly identity: RunnerIdentity;

  constructor(
    /** The bun executable to expose inside the sandbox (as /opt/bun/bin/bun and bunx). */
    private readonly bunExecutable: string,
    private readonly limits: SandboxLimits = DEFAULT_LIMITS,
  ) {
    this.identity = {
      kind: "linux-sandbox",
      version: deriveVersion([import.meta.path, COMMAND_SOURCE, SECCOMP_EXEC], { limits, env: ENV_ALLOWLIST, user: NOBODY }),
      description: `linux-sandbox: sem rede, raiz read-only, /work gravável, ${limits.memoryMb} MB, ${limits.pids} PIDs, ${limits.cpus} CPUs, /tmp ${limits.tmpMb} MB, usuário nobody sem capabilities, seccomp default-deny`,
    };
  }

  /** Why this host cannot run the sandbox, or null. Habitat refuses to start rather than silently run unsandboxed. */
  static unavailable(): string | null {
    if (process.getuid?.() !== 0) return "precisa de root para criar namespaces e cgroups";
    if (process.platform !== "linux" || process.arch !== "x64") return "o filtro seccomp só está definido para linux x86_64";
    for (const tool of ["/usr/bin/unshare", "/usr/bin/setpriv", "/usr/sbin/pivot_root", "/usr/bin/mount"]) if (!existsSync(tool)) return `ferramenta ausente: ${tool}`;
    const controllers = existsSync(join(CGROUP_ROOT, "cgroup.controllers")) ? readFileSync(join(CGROUP_ROOT, "cgroup.controllers"), "utf8") : "";
    for (const c of ["memory", "pids", "cpu"]) if (!controllers.split(/\s+/).includes(c)) return `cgroup v2 sem o controlador ${c}`;
    try {
      accessSync(CGROUP_ROOT, constants.W_OK);
    } catch (error) {
      return `cgroup v2 não gravável: ${String(error)}`;
    }
    return null;
  }

  async run(argv: string[], options: RunOptions): Promise<RunResult> {
    const id = `run-${crypto.randomUUID().slice(0, 12)}`;
    const cgroup = this.createCgroup(id);
    const root = mkdtempSync(join(tmpdir(), "habitat-sandbox-"));
    const kill = (): void => writeFileSync(join(cgroup, "cgroup.kill"), "1");
    try {
      const result = await runCommand(
        ["/bin/sh", "-c", ENTER, "habitat-sandbox", cgroup, INIT, root, options.workspace, options.dependencies ?? "", this.bunExecutable, String(this.limits.tmpMb), SECCOMP_EXEC, ...argv],
        { cwd: "/", timeoutMs: options.timeoutMs, env: {}, onKill: kill },
      );
      const limit = this.limitHit(cgroup) ?? (result.exitCode === SIGSYS_STATUS ? "seccomp" : null);
      return { ...result, argv, exitCode: limit ? null : result.exitCode, limit };
    } finally {
      await this.destroyCgroup(cgroup);
      rmSync(root, { recursive: true, force: true });
    }
  }

  private createCgroup(id: string): string {
    // Controllers must be delegated down the tree before a child can use them.
    const enable = (dir: string): void => writeFileSync(join(dir, "cgroup.subtree_control"), "+memory +pids +cpu");
    enable(CGROUP_ROOT);
    mkdirSync(CGROUP_PARENT, { recursive: true });
    enable(CGROUP_PARENT);
    const dir = join(CGROUP_PARENT, id);
    mkdirSync(dir);
    writeFileSync(join(dir, "memory.max"), String(this.limits.memoryMb * 1024 * 1024));
    writeFileSync(join(dir, "pids.max"), String(this.limits.pids));
    writeFileSync(join(dir, "cpu.max"), `${Math.round(this.limits.cpus * 100_000)} 100000`);
    return dir;
  }

  private limitHit(cgroup: string): "memory" | "pids" | null {
    const events = (file: string): Map<string, number> =>
      new Map(readFileSync(join(cgroup, file), "utf8").trim().split("\n").map((line) => {
        const [key = "", value = "0"] = line.split(" ");
        return [key, Number(value)];
      }));
    if ((events("memory.events").get("oom_kill") ?? 0) > 0) return "memory";
    if ((events("pids.events").get("max") ?? 0) > 0) return "pids";
    return null;
  }

  /** Kills anything left (daemonized children included) and removes the cgroup. */
  private async destroyCgroup(cgroup: string): Promise<void> {
    writeFileSync(join(cgroup, "cgroup.kill"), "1");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (readFileSync(join(cgroup, "cgroup.procs"), "utf8").trim() === "") break;
      await Bun.sleep(20);
    }
    rmdirSync(cgroup);
    if (existsSync(cgroup)) throw new Error(`cgroup ${cgroup} não pôde ser removido`);
  }
}
