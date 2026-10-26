/**
 * Graph hub — a registry of named graphs so one MCP server can serve many repos.
 *
 * Layout: <hub>/<name>/reponova.yml (+ reponova-out/ unless `output` points elsewhere).
 * Hub root: $REPONOVA_HUB or ~/.reponova/graphs.
 *
 * Names: the main checkout of a git repo is `<repo>`; a linked worktree is
 * `<repo>@<branch>`, so every worktree can carry its own graph.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface HubGraph {
  name: string;
  dir: string;
  configPath: string;
  outputDir: string;
  /** Absolute repo roots from the graph's config. */
  repos: string[];
  built: boolean;
}

export function hubDir(): string {
  return resolve(process.env["REPONOVA_HUB"] ?? join(homedir(), ".reponova", "graphs"));
}

function readConfig(configPath: string): Record<string, unknown> {
  return (parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> | null) ?? {};
}

export function getHubGraph(name: string): HubGraph | null {
  const dir = join(hubDir(), name);
  const configPath = join(dir, "reponova.yml");
  if (!existsSync(configPath)) return null;
  const config = readConfig(configPath);
  const outputDir = resolve(dir, (config.output as string | undefined) ?? "reponova-out");
  const repos = ((config.repos as Array<{ path: string }> | undefined) ?? []).map((r) => resolve(dir, r.path));
  return { name, dir, configPath, outputDir, repos, built: existsSync(join(outputDir, "graph.json")) };
}

export function listHubGraphs(): HubGraph[] {
  if (!existsSync(hubDir())) return [];
  return readdirSync(hubDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => getHubGraph(e.name))
    .filter((g): g is HubGraph => g !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");

/**
 * Derive hub names for a path inside a git checkout.
 * `name` is the graph for this checkout; `base` is the main checkout's graph.
 * Returns null outside git.
 */
export function gitGraphName(path: string): { name: string; base: string; root: string } | null {
  let out: string[];
  try {
    out = execFileSync(
      "git",
      ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split("\n");
  } catch {
    return null;
  }
  const [commonDir, gitDir, root, branch] = out as [string, string, string, string];
  const base = sanitize(basename(basename(commonDir) === ".git" ? dirname(commonDir) : commonDir).replace(/\.git$/, ""));
  if (commonDir === gitDir) return { name: base, base, root };
  // Detached worktrees fall back to the directory name.
  return { name: `${base}@${sanitize(branch === "HEAD" ? basename(root) : branch)}`, base, root };
}

/** Default graph for a working directory: its own worktree graph, else the main checkout's. */
export function graphForCwd(cwd: string): HubGraph | null {
  const names = gitGraphName(cwd);
  if (names) {
    const own = getHubGraph(names.name);
    if (own?.built) return own;
    const base = getHubGraph(names.base);
    if (base?.built) return base;
  }
  // Non-git (or unregistered) dirs: longest registered repo root containing cwd.
  const abs = resolve(cwd);
  let best: HubGraph | null = null;
  let bestLen = -1;
  for (const g of listHubGraphs()) {
    if (!g.built) continue;
    for (const r of g.repos) {
      if ((abs === r || abs.startsWith(r + "/")) && r.length > bestLen) {
        best = g;
        bestLen = r.length;
      }
    }
  }
  return best;
}

const FALLBACK_TEMPLATE = {
  exclude_common: true,
  exclude: ["**/.claude/worktrees/**", "**/.worktrees/**", "**/coverage/**", "**/*.min.js", "**/*.map"],
};

/**
 * Register a checkout in the hub (no build). Settings (plugins, excludes, ...) come from,
 * in order: `from` config, the main checkout's graph (for worktrees), <hub>/template.yml, defaults.
 * `repos` and `output` are always rewritten. Returns null when `ifRegistered` is set and
 * neither this graph nor its base graph exists.
 */
export function addHubGraph(
  repoPath: string,
  opts: { name?: string; from?: string; ifRegistered?: boolean } = {},
): HubGraph | null {
  const names = gitGraphName(repoPath);
  const root = names?.root ?? resolve(repoPath);
  const name = opts.name ?? names?.name ?? sanitize(basename(root));
  const existing = getHubGraph(name);
  if (existing) return existing;

  const base = names ? getHubGraph(names.base) : null;
  if (opts.ifRegistered && !base) return null;

  const templatePath = opts.from ? resolve(opts.from) : base?.configPath ?? join(hubDir(), "template.yml");
  const template = existsSync(templatePath) ? readConfig(templatePath) : FALLBACK_TEMPLATE;

  const dir = join(hubDir(), name);
  mkdirSync(dir, { recursive: true });
  const config = { ...template, output: "reponova-out", repos: [{ name: names?.base ?? name, path: root }] };
  writeFileSync(join(dir, "reponova.yml"), stringifyYaml(config));
  return getHubGraph(name);
}

/**
 * Register an existing config + output in place (no copy, no rebuild):
 * repo paths and output are rewritten to absolute paths.
 */
export function importHubGraph(configPath: string, name: string): HubGraph {
  const src = resolve(configPath);
  const srcDir = dirname(src);
  const config = readConfig(src);
  const repos = ((config.repos as Array<{ name: string; path: string }> | undefined) ?? [])
    .map((r) => ({ ...r, path: resolve(srcDir, r.path) }));
  const output = resolve(srcDir, (config.output as string | undefined) ?? "reponova-out");
  const dir = join(hubDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reponova.yml"), stringifyYaml({ ...config, output, repos }));
  return getHubGraph(name)!;
}

/** Remove a graph from the hub. Output outside the hub dir (imported graphs) is left alone. */
export function removeHubGraph(name: string): boolean {
  const g = getHubGraph(name);
  if (!g) return false;
  rmSync(g.dir, { recursive: true, force: true });
  return true;
}

/** Remove graphs whose repo roots no longer exist (e.g. deleted worktrees). */
export function pruneHubGraphs(): string[] {
  const gone = listHubGraphs().filter((g) => g.repos.some((r) => !existsSync(r)));
  for (const g of gone) removeHubGraph(g.name);
  return gone.map((g) => g.name);
}

// ponytail: mkdir lock, stale after 30 min; per-graph only — two different graphs build in parallel.
const LOCK_STALE_MS = 30 * 60 * 1000;

/** Run fn holding the graph's build lock. Returns false (without running) if another build holds it. */
export async function withBuildLock(g: HubGraph, fn: () => Promise<void>): Promise<boolean> {
  const lock = join(g.dir, ".build.lock");
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  } catch {
    return false;
  }
  try {
    await fn();
    return true;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
