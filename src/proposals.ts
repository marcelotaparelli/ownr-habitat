import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { MutationProposal, MutationProvider } from "./ports.ts";

const ProposalFile = z.strictObject({
  hypothesis: z.string().min(10).max(500),
  source: z.strictObject({ kind: z.enum(["manual", "llm", "rule", "search"]), author: z.string().min(1).max(120) }),
  claims: z.string().max(500).optional(),
});

/**
 * Deterministic mutation provider: proposals are directories with a proposal.json
 * (hypothesis, source, optional claims) and a change.patch against the baseline.
 * Humans, agents or scripts can all write one; Habitat does not care who did.
 */
export class DirectoryMutationProvider implements MutationProvider {
  constructor(private readonly root: string) {}

  async propose(): Promise<MutationProposal[]> {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9-]{1,64}$/.test(entry.name))
      .map((entry) => {
        const dir = join(this.root, entry.name);
        const meta = ProposalFile.parse(JSON.parse(readFileSync(join(dir, "proposal.json"), "utf8")));
        const { claims, ...rest } = meta;
        return { id: entry.name, ...rest, ...(claims === undefined ? {} : { claims }), patch: readFileSync(join(dir, "change.patch"), "utf8") };
      });
  }
}
