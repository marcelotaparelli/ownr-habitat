import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import type { HabitatStore } from "./store.ts";

/** Who holds a job lock: enough to tell, from another process, whether that exact process still exists. */
export const LockHolder = z.object({
  pid: z.number().int().positive(),
  /** Process start time (clock ticks since boot, /proc/<pid>/stat field 22): distinguishes a reused pid. */
  start: z.string(),
  host: z.string(),
  job: z.string(),
  /** Distinguishes two Habitat instances inside the same process. */
  nonce: z.string(),
});
export type LockHolder = z.infer<typeof LockHolder>;

export class HabitatBusyError extends Error {
  override readonly name = "HabitatBusyError";
}

/** /proc/<pid>/stat field 22; the command name (field 2) may contain spaces, so parse after its ")". */
function startTime(pid: number | "self"): string | null {
  const path = `/proc/${pid}/stat`;
  if (!existsSync(path)) return null;
  const stat = readFileSync(path, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
}

export type Staleness = { stale: false } | { stale: true; reason: string };

/**
 * Is this holder gone? On the same host the answer is exact: its pid must still exist with the same
 * start time (a crash frees the lock at once; a reused pid does not keep it). From another host only
 * the heartbeat can tell, so the lease expires after `ttlMs` without one.
 */
export function staleness(holder: LockHolder, heartbeatAt: number, now: number, ttlMs: number): Staleness {
  if (holder.host === hostname()) {
    const start = startTime(holder.pid);
    if (start === null) return { stale: true, reason: `processo ${holder.pid} não existe mais` };
    if (start !== holder.start) return { stale: true, reason: `pid ${holder.pid} foi reutilizado por outro processo` };
    return { stale: false };
  }
  return now - heartbeatAt > ttlMs ? { stale: true, reason: `sem heartbeat de ${holder.host} há ${Math.round((now - heartbeatAt) / 1000)} s` } : { stale: false };
}

/**
 * A lease in the shared recorder (habitat.sqlite): one evolution job per mission across every process
 * using it — CLI and server included. Acquisition is a single IMMEDIATE transaction; the holder
 * heartbeats while the job runs and deletes the lease when it ends.
 */
export class JobLock {
  private readonly nonce = crypto.randomUUID();

  constructor(
    private readonly store: HabitatStore,
    private readonly name: string,
    private readonly ttlMs = 30_000,
    private readonly heartbeatMs = 5_000,
  ) {}

  acquire(job: string, missionId: string): { release(): void } {
    const start = startTime("self");
    if (start === null) throw new Error("não foi possível identificar este processo (/proc/self/stat)");
    const me: LockHolder = { pid: process.pid, start, host: hostname(), job, nonce: this.nonce };
    const result = this.store.tryLock(this.name, me, Date.now(), (holder, heartbeatAt, now) => staleness(holder, heartbeatAt, now, this.ttlMs));
    if (!result.acquired) {
      const h = result.holder;
      throw new HabitatBusyError(`Habitat ocupado com ${h.job} (pid ${h.pid} em ${h.host}, desde ${new Date(result.acquiredAt).toISOString()})`);
    }
    if (result.recovered) {
      this.store.record("job_lock_recovered", { missionId, data: { previous: result.recovered.holder, reason: result.recovered.reason, job } });
    }
    const timer = setInterval(() => this.store.heartbeatLock(this.name, me, Date.now()), this.heartbeatMs);
    timer.unref();
    return {
      release: () => {
        clearInterval(timer);
        this.store.releaseLock(this.name, me);
      },
    };
  }

  /** The job some process (this one or another) is running now, if any. */
  current(): string | null {
    const lock = this.store.lock(this.name);
    if (!lock || staleness(lock.holder, lock.heartbeatAt, Date.now(), this.ttlMs).stale) return null;
    return lock.holder.nonce === this.nonce ? lock.holder.job : `${lock.holder.job} (outra instância ou processo: pid ${lock.holder.pid})`;
  }
}
