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
  baselineRevision: string;
  revision: string;
  changes: FileChange[];
};

/** `version` encodes the evaluator's rules and configuration: change either and old evidence goes stale. */
export interface Evaluator extends EvaluatorIdentity {
  evaluate(context: EvaluationContext): Promise<EvaluationResult>;
}

/** Measurements of the organism in real use (only ever of what is deployed: the baseline). */
export interface TelemetrySource extends EvaluatorIdentity {
  measure(): Promise<Measurement[]>;
}
