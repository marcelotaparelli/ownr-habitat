import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  Mission,
  Operator,
  VERDICTS,
  type Candidate,
  type CandidateSource,
  type CandidateStatus,
  type Decision,
  type EvaluationResult,
  type FileChange,
} from "./domain.ts";
import { sha256 } from "./identity.ts";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id          TEXT PRIMARY KEY,
  organism_id TEXT NOT NULL,
  -- Snapshot of the current revision: envelope and fitness cannot drift mid-mission; only a human revises them.
  definition  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1,
  hash        TEXT
);
CREATE TABLE IF NOT EXISTS mission_revisions (
  mission_id TEXT NOT NULL REFERENCES missions(id),
  revision   INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  definition TEXT NOT NULL,
  revised_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mission_id, revision)
);
CREATE TABLE IF NOT EXISTS observations (
  id         TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  revision   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  proposal_id     TEXT NOT NULL,
  generation      INTEGER NOT NULL CHECK (generation >= 1),
  parent_revision TEXT NOT NULL,
  revision        TEXT,
  hypothesis      TEXT NOT NULL,
  source          TEXT NOT NULL,
  claims          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('proposed','prepared','evaluating','evaluated','failed','accepted')),
  reevaluation_of TEXT REFERENCES candidates(id),
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_changes (
  candidate_id TEXT NOT NULL REFERENCES candidates(id),
  path         TEXT NOT NULL,
  status       TEXT NOT NULL,
  old_mode     TEXT NOT NULL,
  new_mode     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('observation','candidate')),
  subject_id   TEXT NOT NULL,
  evaluator_id TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PASS','FAIL','NOT_RUN')),
  result       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  -- baseline SHA, subject SHA, mission + envelope hashes, evaluator fingerprint. NULL = legacy, never current.
  binding      TEXT
);
CREATE INDEX IF NOT EXISTS evaluations_by_subject ON evaluations (subject_kind, subject_id);
CREATE TABLE IF NOT EXISTS decisions (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
  verdict      TEXT NOT NULL,
  detail       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
-- The experiment's verdict: an accepted change, judged by the observation of the baseline it became.
CREATE TABLE IF NOT EXISTS assessments (
  observation_id TEXT PRIMARY KEY REFERENCES observations(id),
  candidate_id   TEXT NOT NULL REFERENCES candidates(id),
  verdict        TEXT NOT NULL,
  detail         TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
-- The flight recorder: append-only, one row per thing that happened.
CREATE TABLE IF NOT EXISTS habitat_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  mission_id   TEXT,
  candidate_id TEXT,
  data         TEXT,
  created_at   INTEGER NOT NULL
);
`;

/**
 * v1 (first Habitat slice) → v2: evidence binding, mission revisions, lifecycle statuses.
 * Old evaluations keep a NULL binding, so everything decided under v1 reads as STALE.
 */
const MIGRATE_V1 = `
ALTER TABLE missions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE missions ADD COLUMN hash TEXT;
ALTER TABLE evaluations ADD COLUMN binding TEXT;
CREATE TABLE candidates_v2 (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id),
  proposal_id     TEXT NOT NULL,
  generation      INTEGER NOT NULL CHECK (generation >= 1),
  parent_revision TEXT NOT NULL,
  revision        TEXT,
  hypothesis      TEXT NOT NULL,
  source          TEXT NOT NULL,
  claims          TEXT,
  status          TEXT NOT NULL CHECK (status IN ('proposed','prepared','evaluating','evaluated','failed','accepted')),
  reevaluation_of TEXT REFERENCES candidates(id),
  created_at      INTEGER NOT NULL
);
INSERT INTO candidates_v2 (id, mission_id, proposal_id, generation, parent_revision, revision, hypothesis, source, claims, status, reevaluation_of, created_at)
SELECT id, mission_id, proposal_id, generation, parent_revision, revision, hypothesis, source, claims,
       CASE WHEN status = 'promoted' THEN 'accepted'
            WHEN id IN (SELECT candidate_id FROM decisions) THEN 'evaluated'
            ELSE 'failed' END,
       NULL, created_at
FROM candidates;
DROP TABLE candidates;
ALTER TABLE candidates_v2 RENAME TO candidates;
`;


const MeasurementRow = z.object({
  metric: z.string(),
  value: z.number().nullable(),
  status: z.enum(["MEASURED", "INSUFFICIENT_DATA"]),
  unit: z.string().exactOptional(),
  sampleSize: z.number().exactOptional(),
  window: z.string().exactOptional(),
  note: z.string().exactOptional(),
});
const EvaluationRow = z.object({
  evaluatorId: z.string(),
  status: z.enum(["PASS", "FAIL", "NOT_RUN"]),
  measurements: z.array(MeasurementRow),
  evidence: z.array(z.object({ kind: z.enum(["command", "files", "report", "note"]), summary: z.string(), detail: z.string().exactOptional() })),
  durationMs: z.number(),
  errors: z.array(z.string()),
});
const BindingRow = z.object({
  baselineRevision: z.string(),
  subjectRevision: z.string(),
  missionId: z.string(),
  missionRevision: z.number(),
  missionHash: z.string(),
  envelopeHash: z.string(),
  evaluator: z.string(),
});
const Status = z.enum(["PASS", "FAIL", "NOT_RUN"]);
const ConstraintResultRow = z.object({ constraintId: z.string(), name: z.string(), severity: z.enum(["hard", "soft"]), status: Status, detail: z.string() });
const DecisionRow = z.object({
  verdict: z.enum(VERDICTS),
  constraints: z.array(ConstraintResultRow),
  comparisons: z.array(
    z.object({
      metric: z.string(),
      label: z.string(),
      kind: z.enum(["proxy", "outcome"]),
      direction: z.enum(["minimize", "maximize"]),
      baseline: z.number().nullable(),
      candidate: z.number().nullable(),
      outcome: z.enum(["improved", "worse", "unchanged", "unknown", "insufficient_data"]),
    }),
  ),
  guards: z.array(z.object({ metric: z.string(), label: z.string(), operator: Operator, threshold: z.number(), reason: z.string(), value: z.number().nullable(), status: Status })),
  warnings: z.array(z.string()),
  reasons: z.array(z.string()),
  binding: z
    .object({
      baselineRevision: z.string(),
      candidateRevision: z.string(),
      baselineObservationId: z.string(),
      missionId: z.string(),
      missionRevision: z.number(),
      missionHash: z.string(),
      envelopeHash: z.string(),
      evaluators: z.array(z.string()),
    })
    .nullable(),
});
/** Decisions written before evidence binding: only their constraints and reasons are still meaningful. */
const LegacyDecisionRow = z.object({ verdict: z.string(), constraints: z.array(ConstraintResultRow), reasons: z.array(z.string()) });

export type HabitatEvent = { id: number; kind: string; missionId: string | null; candidateId: string | null; data: Record<string, unknown> | null; createdAt: number };
export type Observation = { id: string; missionId: string; revision: string; createdAt: number };
export type MissionRecord = { mission: Mission; revision: number; hash: string };

export class MissionDriftError extends Error {
  override readonly name = "MissionDriftError";
}

type CandidateRow = {
  id: string;
  mission_id: string;
  proposal_id: string;
  generation: number;
  parent_revision: string;
  revision: string | null;
  hypothesis: string;
  source: string;
  claims: string | null;
  status: CandidateStatus;
  reevaluation_of: string | null;
  created_at: number;
};
type ObservationRow = { id: string; mission_id: string; revision: string; created_at: number };

export class HabitatStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version >= SCHEMA_VERSION) return;
    const legacy = this.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidates'").get() !== null;
    this.db.transaction(() => {
      if (legacy) this.db.exec(MIGRATE_V1);
      this.db.exec(SCHEMA);
      for (const m of this.db.query<{ id: string; definition: string; created_at: number }, []>("SELECT id, definition, created_at FROM missions WHERE hash IS NULL").all()) {
        const hash = sha256(m.definition);
        this.db.query("UPDATE missions SET hash = $hash WHERE id = $id").run({ hash, id: m.id });
        this.db
          .query("INSERT INTO mission_revisions (mission_id, revision, hash, definition, revised_by, created_at) VALUES ($id, 1, $hash, $definition, 'migração v1', $createdAt)")
          .run({ id: m.id, hash, definition: m.definition, createdAt: m.created_at });
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    })();
  }

  /**
   * Starts the mission, or returns its current snapshot. A definition that differs from the
   * snapshot is refused: the envelope never loosens silently, a human must revise the mission.
   */
  ensureMission(mission: Mission): MissionRecord {
    const definition = JSON.stringify(mission);
    const current = this.db.query<{ hash: string; revision: number; definition: string }, { id: string }>("SELECT hash, revision, definition FROM missions WHERE id = $id").get({ id: mission.id });
    if (current) {
      if (current.hash !== sha256(definition)) throw new MissionDriftError(`a definição da missão ${mission.id} mudou desde a revisão ${current.revision}; um humano precisa revisá-la (revise-mission --by <nome>)`);
      return { mission: Mission.parse(JSON.parse(current.definition)), revision: current.revision, hash: current.hash };
    }
    const hash = sha256(definition);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("INSERT INTO missions (id, organism_id, definition, created_at, revision, hash) VALUES ($id, $organism, $definition, $now, 1, $hash)").run({ id: mission.id, organism: mission.organismId, definition, now, hash });
      this.db.query("INSERT INTO mission_revisions (mission_id, revision, hash, definition, revised_by, created_at) VALUES ($id, 1, $hash, $definition, 'início da missão', $now)").run({ id: mission.id, hash, definition, now });
    })();
    this.record("mission_started", { missionId: mission.id, data: { objective: mission.objective, revision: 1, hash } });
    return { mission, revision: 1, hash };
  }

  /** A human act: the new definition becomes the snapshot; evidence bound to the old one goes stale. */
  reviseMission(mission: Mission, by: string): MissionRecord {
    const current = this.db.query<{ hash: string; revision: number }, { id: string }>("SELECT hash, revision FROM missions WHERE id = $id").get({ id: mission.id });
    if (!current) return this.ensureMission(mission);
    const definition = JSON.stringify(mission);
    const hash = sha256(definition);
    if (hash === current.hash) return { mission, revision: current.revision, hash };
    const revision = current.revision + 1;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.query("UPDATE missions SET definition = $definition, revision = $revision, hash = $hash WHERE id = $id").run({ id: mission.id, definition, revision, hash });
      this.db.query("INSERT INTO mission_revisions (mission_id, revision, hash, definition, revised_by, created_at) VALUES ($id, $revision, $hash, $definition, $by, $now)").run({ id: mission.id, revision, hash, definition, by, now });
    })();
    this.record("mission_revised", { missionId: mission.id, data: { by, from: { revision: current.revision, hash: current.hash }, to: { revision, hash } } });
    return { mission, revision, hash };
  }

  addObservation(missionId: string, revision: string): Observation {
    const observation = { id: `obs-${crypto.randomUUID().slice(0, 8)}`, missionId, revision, createdAt: Date.now() };
    this.db.query("INSERT INTO observations (id, mission_id, revision, created_at) VALUES ($id, $missionId, $revision, $createdAt)").run(observation);
    return observation;
  }

  latestObservation(missionId: string, revision?: string): Observation | undefined {
    const rows = revision
      ? this.db.query<ObservationRow, { missionId: string; revision: string }>("SELECT * FROM observations WHERE mission_id = $missionId AND revision = $revision ORDER BY created_at DESC, rowid DESC LIMIT 1").all({ missionId, revision })
      : this.db.query<ObservationRow, { missionId: string }>("SELECT * FROM observations WHERE mission_id = $missionId ORDER BY created_at DESC, rowid DESC LIMIT 1").all({ missionId });
    return rows.map(toObservation)[0];
  }

  observations(missionId: string): Observation[] {
    return this.db.query<ObservationRow, { missionId: string }>("SELECT * FROM observations WHERE mission_id = $missionId ORDER BY created_at, rowid").all({ missionId }).map(toObservation);
  }

  addCandidate(c: Omit<Candidate, "createdAt" | "status" | "revision">): Candidate {
    const candidate: Candidate = { ...c, revision: null, status: "proposed", createdAt: Date.now() };
    this.db
      .query(
        `INSERT INTO candidates (id, mission_id, proposal_id, generation, parent_revision, revision, hypothesis, source, claims, status, reevaluation_of, created_at)
         VALUES ($id, $missionId, $proposalId, $generation, $parentRevision, NULL, $hypothesis, $source, $claims, 'proposed', $reevaluationOf, $createdAt)`,
      )
      .run({ ...candidate, source: JSON.stringify(candidate.source) });
    return candidate;
  }

  updateCandidate(id: string, patch: { status?: CandidateStatus; revision?: string }): void {
    if (patch.revision !== undefined) this.db.query("UPDATE candidates SET revision = $revision WHERE id = $id").run({ id, revision: patch.revision });
    if (patch.status !== undefined) this.db.query("UPDATE candidates SET status = $status WHERE id = $id").run({ id, status: patch.status });
  }

  candidate(id: string): Candidate | undefined {
    const row = this.db.query<CandidateRow, { id: string }>("SELECT * FROM candidates WHERE id = $id").get({ id });
    return row ? toCandidate(row) : undefined;
  }

  candidates(missionId: string): Candidate[] {
    return this.db.query<CandidateRow, { missionId: string }>("SELECT * FROM candidates WHERE mission_id = $missionId ORDER BY created_at, rowid").all({ missionId }).map(toCandidate);
  }

  addChanges(candidateId: string, changes: FileChange[]): void {
    const insert = this.db.query("INSERT INTO candidate_changes (candidate_id, path, status, old_mode, new_mode) VALUES ($candidateId, $path, $status, $oldMode, $newMode)");
    this.db.transaction(() => changes.forEach((c) => insert.run({ candidateId, ...c })))();
  }

  changes(candidateId: string): FileChange[] {
    return this.db
      .query<{ path: string; status: string; old_mode: string; new_mode: string }, { candidateId: string }>("SELECT * FROM candidate_changes WHERE candidate_id = $candidateId")
      .all({ candidateId })
      .map((r) => ({ path: r.path, status: r.status, oldMode: r.old_mode, newMode: r.new_mode }));
  }

  addEvaluation(subjectKind: "observation" | "candidate", subjectId: string, result: EvaluationResult): void {
    const { binding, ...rest } = result;
    this.db
      .query("INSERT INTO evaluations (subject_kind, subject_id, evaluator_id, status, result, created_at, binding) VALUES ($kind, $subjectId, $evaluatorId, $status, $result, $now, $binding)")
      .run({ kind: subjectKind, subjectId, evaluatorId: result.evaluatorId, status: result.status, result: JSON.stringify(rest), now: Date.now(), binding: binding ? JSON.stringify(binding) : null });
  }

  evaluations(subjectKind: "observation" | "candidate", subjectId: string): EvaluationResult[] {
    return this.db
      .query<{ result: string; binding: string | null }, { kind: string; subjectId: string }>("SELECT result, binding FROM evaluations WHERE subject_kind = $kind AND subject_id = $subjectId ORDER BY id")
      .all({ kind: subjectKind, subjectId })
      .map((r) => {
        const result = EvaluationRow.parse(JSON.parse(r.result));
        return r.binding ? { ...result, binding: BindingRow.parse(JSON.parse(r.binding)) } : result;
      });
  }

  saveDecision(candidateId: string, decision: Decision): void {
    this.db
      .query("INSERT OR REPLACE INTO decisions (candidate_id, verdict, detail, created_at) VALUES ($candidateId, $verdict, $detail, $now)")
      .run({ candidateId, verdict: decision.verdict, detail: JSON.stringify(decision), now: Date.now() });
  }

  decision(candidateId: string): Decision | undefined {
    const row = this.db.query<{ detail: string }, { candidateId: string }>("SELECT detail FROM decisions WHERE candidate_id = $candidateId").get({ candidateId });
    return row ? parseDecision(row.detail) : undefined;
  }

  saveAssessment(observationId: string, candidateId: string, decision: Decision): void {
    this.db
      .query("INSERT OR REPLACE INTO assessments (observation_id, candidate_id, verdict, detail, created_at) VALUES ($observationId, $candidateId, $verdict, $detail, $now)")
      .run({ observationId, candidateId, verdict: decision.verdict, detail: JSON.stringify(decision), now: Date.now() });
  }

  assessment(observationId: string): { candidateId: string; decision: Decision } | undefined {
    const row = this.db.query<{ candidate_id: string; detail: string }, { observationId: string }>("SELECT candidate_id, detail FROM assessments WHERE observation_id = $observationId").get({ observationId });
    return row ? { candidateId: row.candidate_id, decision: parseDecision(row.detail) } : undefined;
  }

  record(kind: string, input: { missionId?: string; candidateId?: string; data?: Record<string, unknown> } = {}): void {
    this.db
      .query("INSERT INTO habitat_events (kind, mission_id, candidate_id, data, created_at) VALUES ($kind, $missionId, $candidateId, $data, $now)")
      .run({ kind, missionId: input.missionId ?? null, candidateId: input.candidateId ?? null, data: input.data ? JSON.stringify(input.data) : null, now: Date.now() });
  }

  events(limit = 200): HabitatEvent[] {
    return this.db
      .query<{ id: number; kind: string; mission_id: string | null; candidate_id: string | null; data: string | null; created_at: number }, { limit: number }>(
        "SELECT * FROM habitat_events ORDER BY id DESC LIMIT $limit",
      )
      .all({ limit })
      .map((r) => ({ id: r.id, kind: r.kind, missionId: r.mission_id, candidateId: r.candidate_id, data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null, createdAt: r.created_at }));
  }
}

function parseDecision(detail: string): Decision {
  const raw: unknown = JSON.parse(detail);
  const current = DecisionRow.safeParse(raw);
  if (current.success) return current.data;
  const legacy = LegacyDecisionRow.parse(raw);
  return {
    verdict: "STALE",
    constraints: legacy.constraints,
    comparisons: [],
    guards: [],
    warnings: [],
    reasons: [`decisão registrada com a semântica antiga (${legacy.verdict}) e sem vínculo de evidência`, ...legacy.reasons],
    binding: null,
  };
}

function toObservation(r: ObservationRow): Observation {
  return { id: r.id, missionId: r.mission_id, revision: r.revision, createdAt: r.created_at };
}

function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    missionId: row.mission_id,
    proposalId: row.proposal_id,
    generation: row.generation,
    parentRevision: row.parent_revision,
    revision: row.revision,
    hypothesis: row.hypothesis,
    source: JSON.parse(row.source) as CandidateSource,
    claims: row.claims,
    status: row.status,
    reevaluationOf: row.reevaluation_of,
    createdAt: row.created_at,
  };
}
