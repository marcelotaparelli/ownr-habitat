import { readFileSync } from "node:fs";

export const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** JSON with sorted keys: the same configuration always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * An evaluator's version is derived, never declared: a hash of the source files that implement it
 * and a hash of its configuration (argv, timeouts, parser, parameters). Edit either and evidence
 * produced by the old evaluator stops matching — it becomes STALE without anyone bumping a number.
 * Only content counts, so moving a file or changing unrelated Habitat code changes nothing.
 */
export function deriveVersion(implementation: string[], config: unknown): string {
  const source = implementation.map((path) => sha256(readFileSync(path, "utf8"))).join(":");
  return `impl:${sha256(source).slice(0, 12)};cfg:${sha256(canonical(config)).slice(0, 12)}`;
}
