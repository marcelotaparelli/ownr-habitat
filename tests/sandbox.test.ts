import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeHash } from "../src/dependencies.ts";
import { CommandEvaluator } from "../src/evaluators.ts";
import { TrustedLocalRunner } from "../src/runner.ts";
import { DEFAULT_LIMITS, LinuxSandboxRunner } from "../src/sandbox.ts";

// Runs for real where the host allows it (root + namespaces + cgroup v2); reported as skipped elsewhere.
const unavailable = LinuxSandboxRunner.unavailable();

describe.skipIf(unavailable !== null)("linux sandbox", () => {
  let workspace = "";
  const small = { memoryMb: 128, pids: 32, cpus: 1, tmpMb: 16 };
  const runner = new LinuxSandboxRunner(process.execPath, small);
  const sh = (script: string, timeoutMs = 10_000) => runner.run(["/bin/sh", "-c", script], { workspace, timeoutMs });

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "habitat-sandbox-test-"));
    writeFileSync(join(workspace, "input.txt"), "hello");
  });
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  test("runs as an unprivileged user, as PID 1 of its own namespace, in /work", async () => {
    const result = await sh("id -u; echo $$; pwd; cat input.txt");
    expect(result.stdout.trim().split("\n")).toEqual(["65534", "1", "/work", "hello"]);
  });

  test("has no network: only a loopback interface and no outbound sockets", async () => {
    const interfaces = await sh("tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '");
    expect(interfaces.stdout.trim()).toBe("lo");
    const fetch = await runner.run(["bun", "-e", "await fetch('http://1.1.1.1').then(() => console.log('reached'), () => console.log('blocked'))"], { workspace, timeoutMs: 10_000 });
    expect(fetch.stdout.trim()).toBe("blocked");
  });

  test("sees neither Habitat, nor other repositories, nor host data", async () => {
    const result = await sh(`ls ${JSON.stringify(import.meta.dir)} /root /home /workspace /etc/passwd /sys 2>&1; echo done`);
    expect(result.stdout).not.toContain("sandbox.test.ts");
    expect(result.stdout.match(/No such file or directory/g)?.length).toBe(6);
  });

  test("gets only the allowlisted environment, never Habitat's", async () => {
    process.env.HABITAT_SECRET_TOKEN = "sk-must-not-leak";
    try {
      const result = await sh("env | cut -d= -f1 | sort");
      expect(result.stdout.trim().split("\n")).toEqual(["FORCE_COLOR", "HOME", "LANG", "NO_COLOR", "PATH", "PWD", "TMPDIR"]);
    } finally {
      delete process.env.HABITAT_SECRET_TOKEN;
    }
  });

  test("can write only its workspace and a private /tmp", async () => {
    const result = await sh("touch /work/out && echo work; touch /tmp/out && echo tmp; touch /usr/out 2>/dev/null || echo usr-denied; touch /out 2>/dev/null || echo root-denied");
    expect(result.stdout.trim().split("\n")).toEqual(["work", "tmp", "usr-denied", "root-denied"]);
    expect(existsSync(join(workspace, "out"))).toBe(true);
  });

  test("memory limit: the command is killed and the limit is reported", async () => {
    const result = await runner.run(["bun", "-e", "const a = []; for (;;) a.push(new Uint8Array(1 << 24).fill(1))"], { workspace, timeoutMs: 20_000 });
    expect(result).toMatchObject({ limit: "memory", exitCode: null });
  });

  test("PID limit: a fork bomb is contained and reported", async () => {
    const result = await sh("for i in $(seq 1 100); do sleep 2 & done; wait", 20_000);
    expect(result.limit).toBe("pids");
  });

  test("timeout kills the whole tree and leaves no cgroup behind", async () => {
    const result = await sh("sleep 30 & sleep 30", 500);
    expect(result.timedOut).toBe(true);
    expect(readdirSync("/sys/fs/cgroup/ownr-habitat").filter((name) => name.startsWith("run-"))).toEqual([]);
  });

  // Raw syscalls through bun:ffi, as a hostile candidate would issue them (no helper binary needs to exist).
  const rawSyscall = (nr: number, arg0 = "0n") =>
    runner.run(["bun", "-e", `import { dlopen, FFIType } from "bun:ffi"; const libc = dlopen("libc.so.6", { syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 } }); const r = libc.symbols.syscall(${nr}n, ${arg0}, 0n, 0n); console.log("survived", r);`], { workspace, timeoutMs: 20_000 });

  test("seccomp: forbidden syscalls kill the process and are reported as a sandbox violation", async () => {
    const forbidden = { mount: 165, umount2: 166, pivot_root: 155, chroot: 161, ptrace: 101, unshare: 272, setns: 308, bpf: 321, perf_event_open: 298, keyctl: 250, userfaultfd: 323, kexec_load: 246, init_module: 175, process_vm_readv: 310 };
    for (const [name, nr] of Object.entries(forbidden)) {
      const result = await rawSyscall(nr);
      expect({ name, limit: result.limit, exitCode: result.exitCode, survived: result.stdout.includes("survived") }).toEqual({ name, limit: "seccomp", exitCode: null, survived: false });
    }
  });

  test("seccomp: clone may create threads and processes but never namespaces", async () => {
    const newUserNamespace = await rawSyscall(56, "0x10000011n");
    expect(newUserNamespace.limit).toBe("seccomp");
    const plain = await sh("true & wait; echo forked");
    expect(plain.stdout.trim()).toBe("forked");
    const tool = await runner.run(["unshare", "-U", "true"], { workspace, timeoutMs: 10_000 });
    expect(tool.limit).toBe("seccomp");
  });

  test("seccomp: optional features answer like an unsupported or unprivileged kernel instead of killing", async () => {
    const ioUring = await rawSyscall(425);
    expect(ioUring.stdout).toContain("survived -1");
    const fanotify = await rawSyscall(300);
    expect(fanotify.stdout).toContain("survived -1");
    expect(ioUring.limit).toBeNull();
  });

  test("seccomp: the filter is active on the command itself", async () => {
    const result = await sh("grep -E '^Seccomp(_filters)?:' /proc/self/status | tr -s '\t ' ' '");
    expect(result.stdout.trim().split("\n")).toEqual(["Seccomp: 2", "Seccomp_filters: 1"]);
  });

  test("a sandbox violation fails the evaluation with an explicit reason", async () => {
    const evaluator = new CommandEvaluator("hostile", ["unshare", "-U", "true"], { timeoutMs: 10_000, output: "exit-code" }, runner);
    const result = await evaluator.evaluate({ dir: workspace, baselineRevision: "a", revision: "b", changes: [] });
    expect(result.status).toBe("FAIL");
    expect(result.errors).toEqual(["violação do sandbox: syscall proibida pelo seccomp (processo morto por SIGSYS)"]);
    expect(result.provenance?.commands[0]?.limit).toBe("seccomp");
  });

  test("dependencies are mounted read-only: the command cannot change the tree it runs with", async () => {
    const deps = mkdtempSync(join(tmpdir(), "habitat-deps-"));
    chmodSync(deps, 0o755);
    mkdirSync(join(deps, "dep"));
    writeFileSync(join(deps, "dep", "index.js"), "module.exports = 1;");
    const work = mkdtempSync(join(tmpdir(), "habitat-work-"));
    try {
      const before = treeHash(deps);
      const result = await runner.run(["/bin/sh", "-c", "cat node_modules/dep/index.js; echo pwned > node_modules/dep/index.js 2>&1 || echo write-denied; rm -rf node_modules/dep 2>/dev/null || echo rm-denied"], { workspace: work, timeoutMs: 10_000, dependencies: deps });
      expect(result.stdout).toContain("module.exports = 1;");
      expect(result.stdout).toContain("write-denied");
      expect(result.stdout).toContain("rm-denied");
      expect(treeHash(deps)).toBe(before);
    } finally {
      rmSync(deps, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("its identity is derived from its limits and differs from trusted-local", () => {
    expect(runner.identity.kind).toBe("linux-sandbox");
    expect(new LinuxSandboxRunner(process.execPath, small).identity.version).toBe(runner.identity.version);
    expect(new LinuxSandboxRunner(process.execPath, DEFAULT_LIMITS).identity.version).not.toBe(runner.identity.version);
    expect(new TrustedLocalRunner().identity.kind).toBe("trusted-local");
  });
});

test("sandbox availability is reported, never assumed", () => {
  expect(unavailable === null || typeof unavailable === "string").toBe(true);
});
