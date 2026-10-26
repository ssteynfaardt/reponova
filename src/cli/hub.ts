import { build } from "../pipeline/build.js";
import {
  addHubGraph,
  getHubGraph,
  hubDir,
  importHubGraph,
  listHubGraphs,
  pruneHubGraphs,
  removeHubGraph,
  withBuildLock,
  type HubGraph,
} from "../shared/hub.js";
import { errorMessage, log } from "../shared/utils.js";

async function buildGraph(g: HubGraph, force: boolean): Promise<void> {
  const ran = await withBuildLock(g, async () => {
    await build(g.configPath, { force });
  });
  if (!ran) log.warn(`Build already running for "${g.name}" — skipped.`);
}

export async function hubHandler(argv: Record<string, unknown>): Promise<void> {
  const action = argv.action as string;
  const target = argv.target as string | undefined;
  try {
    switch (action) {
      case "add": {
        const g = addHubGraph(target ?? process.cwd(), {
          name: argv.name as string | undefined,
          from: argv.from as string | undefined,
          ifRegistered: argv["if-registered"] as boolean | undefined,
        });
        if (!g) return; // --if-registered and repo not in hub: silent no-op (hook-friendly)
        console.log(`${g.name} → ${g.configPath}`);
        if (argv.build !== false) await buildGraph(g, Boolean(argv.force));
        return;
      }
      case "import": {
        if (!target || !argv.name) throw new Error("Usage: reponova hub import <reponova.yml> --name <name>");
        const g = importHubGraph(target, argv.name as string);
        console.log(`${g.name} → ${g.configPath} (output ${g.outputDir}${g.built ? "" : ", not built"})`);
        return;
      }
      case "build": {
        const g = target ? getHubGraph(target) : null;
        if (!g) throw new Error(`Unknown graph: ${target ?? "(none)"}`);
        await buildGraph(g, Boolean(argv.force));
        return;
      }
      case "list": {
        const graphs = listHubGraphs();
        if (graphs.length === 0) console.log(`No graphs in ${hubDir()}`);
        for (const g of graphs) console.log(`${g.built ? "✓" : "·"} ${g.name}\t${g.repos.join(", ")}`);
        return;
      }
      case "remove": {
        if (!target || !removeHubGraph(target)) throw new Error(`Unknown graph: ${target ?? "(none)"}`);
        console.log(`Removed ${target}`);
        return;
      }
      case "prune": {
        const removed = pruneHubGraphs();
        console.log(removed.length ? `Pruned: ${removed.join(", ")}` : "Nothing to prune");
        return;
      }
    }
  } catch (err) {
    log.error(errorMessage(err));
    process.exit(1);
  }
}
