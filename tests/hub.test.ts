/**
 * Tests for src/shared/hub.ts — graph hub registry with per-worktree graphs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  addHubGraph,
  getHubGraph,
  gitGraphName,
  graphForCwd,
  importHubGraph,
  pruneHubGraphs,
  withBuildLock,
} from "../src/shared/hub.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

/** Pretend a graph has been built. */
const markBuilt = (name: string) => {
  const out = getHubGraph(name)!.outputDir;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "graph.json"), "{}");
};

describe("graph hub", () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  const prevHub = process.env["REPONOVA_HUB"];

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "rn-hub-")));
    process.env["REPONOVA_HUB"] = join(tmp, "hub");
    repo = join(tmp, "myrepo");
    wt = join(tmp, "wt-dir");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", wt);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (prevHub === undefined) delete process.env["REPONOVA_HUB"];
    else process.env["REPONOVA_HUB"] = prevHub;
  });

  it("names main checkout <repo> and linked worktree <repo>@<branch>", () => {
    expect(gitGraphName(repo)).toMatchObject({ name: "myrepo", base: "myrepo", root: repo });
    expect(gitGraphName(wt)).toMatchObject({ name: "myrepo@feat-x", base: "myrepo", root: wt });
    expect(gitGraphName(tmp)).toBeNull();
  });

  it("--if-registered is a no-op until the main checkout is in the hub", () => {
    expect(addHubGraph(wt, { ifRegistered: true })).toBeNull();
    writeFileSync(join(tmp, "base.yml"), "plugins:\n  go:\n    enabled: true\n");
    addHubGraph(repo, { from: join(tmp, "base.yml") });
    const g = addHubGraph(wt, { ifRegistered: true })!;
    expect(g.name).toBe("myrepo@feat-x");
    const cfg = parseYaml(readFileSync(g.configPath, "utf-8"));
    // Worktree inherits base settings; repo path + output rewritten.
    expect(cfg.plugins).toEqual({ go: { enabled: true } });
    expect(cfg.repos).toEqual([{ name: "myrepo", path: wt }]);
    expect(g.outputDir).toBe(join(tmp, "hub", "myrepo@feat-x", "reponova-out"));
  });

  it("worktrees: false keeps --if-registered from creating worktree graphs (manual add still works)", () => {
    writeFileSync(join(tmp, "base.yml"), "worktrees: false\n");
    addHubGraph(repo, { from: join(tmp, "base.yml") });
    expect(addHubGraph(repo, { ifRegistered: true })!.name).toBe("myrepo");
    expect(addHubGraph(wt, { ifRegistered: true })).toBeNull();
    expect(addHubGraph(wt)!.name).toBe("myrepo@feat-x");
  });

  it("build lock: skips while holder alive, reclaims a dead holder's lock", async () => {
    const g = addHubGraph(repo)!;
    const lock = join(g.dir, ".build.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    let ran = false;
    expect(await withBuildLock(g, async () => { ran = true; })).toBe(false);
    writeFileSync(join(lock, "pid"), "999999"); // no such process
    expect(await withBuildLock(g, async () => { ran = true; })).toBe(true);
    expect(ran).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("cwd default: worktree graph, falling back to the main checkout's graph", () => {
    addHubGraph(repo);
    addHubGraph(wt);
    expect(graphForCwd(wt)).toBeNull(); // nothing built
    markBuilt("myrepo");
    expect(graphForCwd(wt)!.name).toBe("myrepo");
    markBuilt("myrepo@feat-x");
    expect(graphForCwd(wt)!.name).toBe("myrepo@feat-x");
    expect(graphForCwd(repo)!.name).toBe("myrepo");
  });

  it("import keeps output in place with absolute paths; prune drops graphs with missing repos", () => {
    const ext = join(tmp, "ext");
    mkdirSync(join(ext, "reponova-out"), { recursive: true });
    writeFileSync(join(ext, "reponova-out", "graph.json"), "{}");
    writeFileSync(join(ext, "reponova.yml"), "output: reponova-out\nrepos:\n  - name: r\n    path: ../myrepo\n");
    const g = importHubGraph(join(ext, "reponova.yml"), "ext");
    expect(g).toMatchObject({ outputDir: join(ext, "reponova-out"), repos: [repo], built: true });
    expect(graphForCwd(join(tmp, "nowhere"))).toBeNull();

    addHubGraph(wt);
    git(repo, "worktree", "remove", wt);
    expect(pruneHubGraphs()).toEqual(["myrepo@feat-x"]);
    expect(getHubGraph("ext")).not.toBeNull();
  });
});
