import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Measurement } from "../domain.ts";
import { deriveVersion } from "../identity.ts";
import type { TelemetrySource } from "../ports.ts";

type EventRow = { learner_id: string; stage_id: string | null; type: string; data: string | null };

const MICRO = /^ops-triage-ai\.m1-(0[1-9]|1\d)$/;
const CHECKPOINT = "ops-triage-ai.m1-99";

/**
 * Turns the Replay's learning events into measurements. Read-only access to the organism's
 * data. Only events after `since` count: older ones belong to different stage contents.
 * No value is invented: without data a metric is INSUFFICIENT_DATA, with its sample size.
 */
export class ReplayTelemetrySource implements TelemetrySource {
  readonly id = "telemetry";
  /** Derived from this file and the rules below; the database location is not part of what is measured. */
  readonly version = deriveVersion([import.meta.path], { source: "replay-events", micro: MICRO.source, checkpoint: CHECKPOINT, window: "since-m1-content-change" });

  constructor(
    private readonly dbPath: string,
    /** Epoch ms of the last content change of Module 1 in the deployed revision. */
    private readonly since: () => Promise<number>,
  ) {}

  async measure(): Promise<Measurement[]> {
    const since = await this.since();
    const window = `desde ${new Date(since).toISOString().slice(0, 16).replace("T", " ")} UTC (conteúdo atual do Module 1)`;
    const events = this.events(since);
    const parse = (row: EventRow): Record<string, unknown> => (row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {});

    const completedTimes = events
      .filter((e) => e.type === "stage_status_changed" && e.stage_id && MICRO.test(e.stage_id) && parse(e).status === "completed")
      .map((e) => Number(parse(e).timeSpentMs))
      .filter((ms) => Number.isFinite(ms) && ms > 0);

    const checkpointLearners = new Set(events.filter((e) => e.type === "stage_opened" && e.stage_id === CHECKPOINT).map((e) => e.learner_id));
    const checkpointPassed = new Set(
      events
        .filter((e) => e.type === "stage_run" && e.stage_id === CHECKPOINT)
        .filter((e) => {
          const d = parse(e);
          return typeof d.total === "number" && d.total > 0 && d.passed === d.total;
        })
        .map((e) => e.learner_id),
    );

    const microOpened = events.filter((e) => e.type === "stage_opened" && e.stage_id && MICRO.test(e.stage_id)).length;
    const reveals = events.filter((e) => e.type === "solution_revealed" && e.stage_id && MICRO.test(e.stage_id)).length;

    const runsPerPair = new Map<string, number>();
    for (const e of events.filter((x) => x.type === "stage_run" && x.stage_id && MICRO.test(x.stage_id))) {
      const key = `${e.learner_id}:${e.stage_id}`;
      runsPerPair.set(key, (runsPerPair.get(key) ?? 0) + 1);
    }
    const retries = [...runsPerPair.values()].map((n) => n - 1);

    const statusChanges = events.filter((e) => e.type === "stage_status_changed" && e.stage_id && MICRO.test(e.stage_id));
    const skippedKnown = statusChanges.filter((e) => parse(e).status === "skipped_known").length;
    const finished = statusChanges.filter((e) => ["completed", "skipped_known", "skipped"].includes(String(parse(e).status))).length;

    return [
      measured("replay.median_microstage_seconds", completedTimes.length ? Math.round(median(completedTimes) / 1000) : null, completedTimes.length, window, "s"),
      measured("replay.checkpoint_success_rate", checkpointLearners.size ? ratio(checkpointPassed.size, checkpointLearners.size) : null, checkpointLearners.size, window),
      measured("replay.solution_reveal_rate", microOpened ? ratio(reveals, microOpened) : null, microOpened, window),
      measured("replay.retry_rate", retries.length ? ratio(retries.reduce((a, b) => a + b, 0), retries.length) : null, retries.length, window),
      measured("replay.skipped_known_rate", finished ? ratio(skippedKnown, finished) : null, finished, window),
      { metric: "replay.novel_change_success_rate", value: null, status: "INSUFFICIENT_DATA", sampleSize: 0, window, note: "não instrumentado: o Replay ainda não tem etapas de mudança inédita" },
      { metric: "replay.external_escape_rate", value: null, status: "INSUFFICIENT_DATA", sampleSize: 0, window, note: "não instrumentado: saídas para fora do OWNR não são observáveis hoje" },
    ];
  }

  private events(since: number): EventRow[] {
    if (!existsSync(this.dbPath)) return [];
    const db = new Database(this.dbPath, { readonly: true, strict: true });
    try {
      return db.query<EventRow, { since: number }>("SELECT learner_id, stage_id, type, data FROM events WHERE created_at >= $since").all({ since });
    } finally {
      db.close();
    }
  }
}

function measured(metric: string, value: number | null, sampleSize: number, window: string, unit?: string): Measurement {
  return { metric, value, status: value === null ? "INSUFFICIENT_DATA" : "MEASURED", sampleSize, window, ...(unit ? { unit } : {}) };
}

const ratio = (a: number, b: number): number => Math.round((a / b) * 1000) / 1000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
