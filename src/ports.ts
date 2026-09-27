import type { CandidateSource, EvaluationResult, EvaluatorIdentity, FileChange, Measurement } from "./domain.ts";

/**
 * The only real boundaries of Habitat. Everything behind them is replaceable:
 * where candidates come from, where they run, how they are judged, what production says.
 */

/** A proposed change. Any source can produce one: a human, an LLM, a rule, a search. */
export type MutationProposal = {
  id: string;
  hypothesis: string;
  source: CandidateSource;
  /** Unified diff against the baseline revision. */
  patch: string;
  /** What the producer claims ("tests pass"…). Recorded as information, never as evidence. */
  claims?: string;
};

export interface MutationProvider {
  propose(): Promise<MutationProposal[]>;
}

/** An isolated checkout of one revision. Never the baseline checkout itself. */
export type Workspace = { id: string; dir: string; revision: string };

export interface CandidateWorkspace {
  prepare(id: string, revision: string): Promise<Workspace>;
  /** Applies the patch and records it as a new revision; returns it and what changed. */
  mutate(workspace: Workspace, patch: string, message: string): Promise<{ revision: string; changes: FileChange[] }>;
  /** Keeps the revision reachable so a candidate stays inspectable after its workspace is gone. */
  retain(id: string, revision: string): Promise<void>;
  dispose(workspace: Workspace): Promise<void>;
  /** The change between two retained revisions, replayable onto a newer baseline. */
  patchBetween(from: string, to: string): Promise<string>;
  /** Whether `ancestor` is in the history of `revision` (lineage survives commits made on top of a baseline). */
  isAncestor(ancestor: string, revision: string): Promise<boolean>;
}

export type EvaluationContext = {
  dir: string;
  /** Hermetic dependency tree the commands must use (read-only), when the organism has one. */
  dependencies?: string | null;
  baselineRevision: string;
  revision: string;
  changes: FileChange[];
};

/** `version` encodes the evaluator's rules and configuration: change either and old evidence goes stale. */
export interface Evaluator extends EvaluatorIdentity {
  evaluate(context: EvaluationContext): Promise<EvaluationResult>;
}

/** The organism's repository as the control plane sees it: its baseline, and read access to its content. */
export interface OrganismRepository {
  baselineRevision(): Promise<string>;
  /** Fast-forward only; refuses if the baseline is no longer `from`. */
  advanceBaseline(from: string, to: string): Promise<void>;
  /** Content identity of these paths (files or directories) at a revision; absent paths count as absent. */
  contentHash(revision: string, paths: string[]): Promise<string>;
  /** A file's content at a revision, or null when it does not exist there. */
  readFile(revision: string, path: string): Promise<string | null>;
}

/** A dependency tree determined by a revision's manifests: where it is, what determined it, what it contains. */
export type DependencyTree = { dir: string; lockfile: string; tree: string };

/** Supplies the dependencies evaluations run with. Never the organism's own mutable working copy. */
export interface DependencyProvider {
  /** Builds, or reuses after re-verifying, the tree the revision's manifests determine. Refuses when it cannot. */
  ensure(revision: string): Promise<DependencyTree & { rebuilt: "fresh" | "tampered" | null }>;
  /** Throws when the tree on disk no longer matches what was recorded. */
  verify(tree: DependencyTree): Promise<void>;
  /** Identity without building: manifests hash, and the recorded tree when one exists. */
  identify(revision: string): Promise<{ lockfile: string; tree: string | null; dir: string | null }>;
}

/** Measurements of the organism in real use (only ever of what is deployed: the baseline). */
export interface TelemetrySource extends EvaluatorIdentity {
  measure(): Promise<Measurement[]>;
}
