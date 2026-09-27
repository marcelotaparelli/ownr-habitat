import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustedLocalRunner } from "../src/runner.ts";
import { DEFAULT_LIMITS, LinuxSandboxRunner } from "../src/sandbox.ts";

// Runs for real where the host allows it (root + namespaces + cgroup v2); reported as skipped elsewhere.
const unavailable = LinuxSandboxRunner.unavailable();

describe.skipIf(unavailable !== null)("linux sandbox", () => {
  let workspace = "";
  const small = { memoryMb: 128, pids: 32, cpus: 1, tmpMb: 16 };
  const runner = new LinuxSandboxRunner(process.execPath, null, small);
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

  test("its identity is derived from its limits and differs from trusted-local", () => {
    expect(runner.identity.kind).toBe("linux-sandbox");
    expect(new LinuxSandboxRunner(process.execPath, null, small).identity.version).toBe(runner.identity.version);
    expect(new LinuxSandboxRunner(process.execPath, null, DEFAULT_LIMITS).identity.version).not.toBe(runner.identity.version);
    expect(new TrustedLocalRunner().identity.kind).toBe("trusted-local");
  });
});

test("sandbox availability is reported, never assumed", () => {
  expect(unavailable === null || typeof unavailable === "string").toBe(true);
});
