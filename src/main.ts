import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createHabitatApi, snapshot } from "./api.ts";
import type { Decision } from "./domain.ts";
import { createApp, type Asset } from "./http/app.ts";
import { logger } from "./logger.ts";
import { createReplayHabitat } from "./replay/compose.ts";

/**
 * OWNR Habitat — bun src/main.ts <command>
 *   serve | observe | status | evolve <proposal> | reevaluate <candidate>
 *   accept <candidate> --by <name>      (human act: the candidate becomes the organism's new baseline)
 *   revise-mission --by <name>          (human act: adopt a changed mission definition)
 * The organism lives in its own repository (configured by its adapter); Habitat never lives inside it.
 * The CLI and the server share habitat.sqlite; run one job at a time.
 */
const root = join(import.meta.dir, "..");
const Env = z.object({
  HABITAT_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  HABITAT_DB: z.string().min(1).default("habitat.sqlite"),
  /** Outside every repository, so no organism test run ever discovers candidate checkouts. */
  HABITAT_WORKTREES: z.string().min(1).default(join(homedir(), ".cache/ownr-habitat/worktrees")),
  /** Which organism adapter to load. Only one exists today. */
  HABITAT_ORGANISM: z.enum(["replay"]).default("replay"),
  /** sandbox: isolated execution (default). trusted-local: host execution, explicit opt-in, NOT a security boundary. */
  HABITAT_RUNNER: z.enum(["sandbox", "trusted-local"]).default("sandbox"),
});
const parsed = Env.safeParse(process.env);
if (!parsed.success) throw new Error("Invalid Habitat configuration: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
const config = parsed.data;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const [command = "serve", arg] = args;
const by = flag("--by");
if ((command === "accept" || command === "revise-mission") && (!by || by.trim().length < 2)) throw new Error(`${command} exige --by <nome de quem decide>`);

const paths = { root, database: resolve(root, config.HABITAT_DB), worktrees: resolve(root, config.HABITAT_WORKTREES) };
const deps = { ...(await createReplayHabitat(paths, config.HABITAT_RUNNER, logger, command === "revise-mission" && by ? { reviseMissionBy: by } : {})), logger };

async function cockpitAssets(): Promise<Map<string, Asset>> {
  const dir = join(root, "web");
  const result = await Bun.build({ entrypoints: [join(dir, "cockpit.ts")], target: "browser", minify: true });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error("Cockpit build failed:\n" + result.logs.map(String).join("\n"));
  return new Map([
    ["/cockpit.js", { body: await output.text(), type: "text/javascript; charset=utf-8" }],
    ["/index.html", { body: readFileSync(join(dir, "index.html"), "utf8"), type: "text/html; charset=utf-8" }],
    ["/cockpit.css", { body: readFileSync(join(dir, "cockpit.css"), "utf8"), type: "text/css; charset=utf-8" }],
  ]);
}

const printDecision = (id: string, decision: Decision): void => {
  console.log(`\n${id} → ${decision.verdict}`);
  for (const reason of decision.reasons) console.log(`  · ${reason}`);
  for (const warning of decision.warnings) console.log(`  ! ${warning}`);
};

switch (command) {
  case "serve": {
    // Loopback only: this server can start commands on the host and move the baseline branch.
    const server = Bun.serve({ hostname: "127.0.0.1", port: config.HABITAT_PORT, fetch: createApp(createHabitatApi(deps), await cockpitAssets(), logger) });
    logger.info("habitat_started", { url: server.url.toString(), organism: deps.organism.id, repository: deps.organism.repositoryPath, baselineRef: deps.organism.baselineRef, mission: deps.habitat.mission.id, runner: deps.runner.identity.kind });
    const shutdown = (): void => {
      server.stop();
      deps.store.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }
  case "observe": {
    const { observationId } = await deps.habitat.observeBaseline();
    console.log(`observação ${observationId}`);
    printStatus(await snapshot(deps));
    break;
  }
  case "evolve": {
    if (!arg) throw new Error("uso: evolve <proposal-id>");
    const { candidate, decision } = await deps.habitat.evolve(arg);
    printDecision(candidate.id, decision);
    break;
  }
  case "reevaluate": {
    if (!arg) throw new Error("uso: reevaluate <candidate-id>");
    const { candidate, decision } = await deps.habitat.reevaluate(arg);
    console.log(`${candidate.id} reavalia ${arg} contra ${candidate.parentRevision.slice(0, 10)}`);
    printDecision(candidate.id, decision);
    break;
  }
  case "accept": {
    if (!arg || !by) throw new Error("uso: accept <candidate-id> --by <nome>");
    const { from, to } = await deps.habitat.accept(arg, by);
    console.log(`baseline ${from.slice(0, 10)} → ${to.slice(0, 10)} (aceito por ${by}). Observe a nova baseline.`);
    break;
  }
  case "revise-mission":
    console.log(`missão ${deps.habitat.mission.id} na revisão atual; evidências de revisões anteriores ficam STALE.`);
    break;
  case "status":
    printStatus(await snapshot(deps));
    break;
  default:
    throw new Error(`comando desconhecido: ${command}`);
}

function printStatus(state: Awaited<ReturnType<typeof snapshot>>): void {
  console.log(`\n${state.organism.name} · missão ${state.mission.id} (revisão ${state.context.missionRevision}): ${state.mission.objective}`);
  for (const p of state.progress) console.log(`  ${p.status.padEnd(17)} ${p.label}: ${p.value ?? "—"} (alvo ${p.operator} ${p.target}${p.sampleSize === undefined ? "" : `, amostra ${p.sampleSize}`})`);
  console.log(`baseline atual: ${state.context.baselineRevision.slice(0, 10)} · observada: ${state.baseline ? `${state.baseline.revision.slice(0, 10)} (${state.baseline.id})${state.baseline.current ? "" : " — DESATUALIZADA"}` : "não"}`);
  for (const b of state.baselines) console.log(`  baseline ${b.revision.slice(0, 10)} ${b.acceptedCandidate ? `← ${b.acceptedCandidate} (${b.assessment})` : ""}`);
  for (const c of state.candidates) {
    console.log(`  g${c.generation} ${c.id} ${c.proposalId.padEnd(22)} ${c.status.padEnd(10)} ${(c.verdict ?? "").padEnd(17)}${c.verdict === "STALE" ? ` (${c.recordedVerdict === "STALE" ? "" : `era ${c.recordedVerdict}: `}${c.stale[0]})` : ""}${c.reevaluationOf ? ` reavalia ${c.reevaluationOf}` : ""}`);
  }
}
