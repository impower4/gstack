/**
 * A4 (#2140): transcripts import into their originating repository's own
 * gbrain source, registered machine-local and non-federated before the first
 * import; transcripts with no repository never reach the default or a
 * federated source, and stay on the machine when the brain is remote.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { installFakeBrain } from "./helpers/fake-gbrain-brain";
import { transcriptCheckoutPath, transcriptSourceId } from "../bin/gstack-memory-ingest";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

describe("memory ingest: per-repository transcript sources (A4)", () => {
  let home = "";
  let gstackHome = "";
  let env: Record<string, string> = {};
  let brain: ReturnType<typeof installFakeBrain>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gstack-tx-sources-"));
    gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    brain = installFakeBrain(home);
    env = {
      HOME: home, GSTACK_HOME: gstackHome, PATH: `${brain.binDir}:/usr/bin:/bin`, TMPDIR: home,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    };
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function repo(name: string): string {
    const dir = join(home, "repos", name);
    mkdirSync(dir, { recursive: true });
    for (const args of [["init", "-q", dir], ["-C", dir, "remote", "add", "origin", `https://github.com/acme/${name}.git`]]) {
      expect(spawnSync("git", args, { env, timeout: 10_000 }).status).toBe(0);
    }
    return dir;
  }
  function session(id: string, cwd: string): string {
    const dir = join(home, ".claude", "projects", "p");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const ts = new Date().toISOString();
    writeFileSync(path,
      JSON.stringify({ type: "user", message: { role: "user", content: `hello from ${id}` }, timestamp: ts, cwd }) + "\n" +
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: ts }) + "\n");
    return path;
  }
  function run(args: string[]) {
    const r = spawnSync(process.execPath, [SCRIPT, "--sources", "transcript", ...args], { env, cwd: home, encoding: "utf-8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }
  const sessions = () => JSON.parse(readFileSync(join(gstackHome, ".transcript-ingest-state.json"), "utf8")).sessions;
  const calls = (): string[][] => existsSync(brain.callLog) ? readFileSync(brain.callLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const fakeBrain = () => JSON.parse(readFileSync(brain.brainFile, "utf8"));

  it("a bulk run across three repositories registers three non-federated sources and imports each one sequentially", () => {
    const paths = ["alpha", "beta", "gamma"].map((n) => session(`${n}00000000001`, repo(n)));
    const r = run(["--bulk", "--quiet"]);
    expect(r.status).toBe(0);
    const ids = ["alpha", "beta", "gamma"].map((n) => transcriptSourceId(`github.com/acme/${n}`));
    expect(new Set(ids).size).toBe(3);
    const log = calls();
    for (const id of ids) {
      const add = log.findIndex((c) => c[0] === "sources" && c[1] === "add" && c[2] === id);
      const imp = log.findIndex((c) => c[0] === "import" && c.includes("--source-id") && c[c.indexOf("--source-id") + 1] === id);
      expect(add).toBeGreaterThan(-1);
      expect(log[add]).toContain("--no-federated");
      expect(imp).toBeGreaterThan(add);
      expect(fakeBrain().sources[id].federated).toBe(false);
    }
    expect(log.filter((c) => c[0] === "import")).toHaveLength(3);
    expect(log.some((c) => c[0] === "import" && !c.includes("--source-id"))).toBe(false);
    const s = sessions();
    paths.forEach((p, i) => expect(s[p]).toMatchObject({ status: "ingested", source_id: ids[i] }));
    expect(Object.keys(fakeBrain().pages.default ?? {})).toEqual([]);
    // Registration is cached: a second run with new pages adds no source.
    session("alpha00000000002", join(home, "repos", "alpha"));
    rmSync(brain.callLog);
    expect(run(["--incremental", "--quiet"]).status).toBe(0);
    expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
  });

  it("--include-unattributed sends repo-less transcripts only to the machine-local unattributed source", () => {
    const loose = session("loose0000001", join(home, "not-a-repo"));
    expect(run(["--bulk", "--quiet"]).status).toBe(0);
    expect(calls().some((c) => c[0] === "import")).toBe(false);
    expect(run(["--bulk", "--quiet", "--include-unattributed"]).status).toBe(0);
    expect(sessions()[loose]).toMatchObject({ status: "ingested", source_id: "gstack-transcripts-unattributed" });
    expect(fakeBrain().sources["gstack-transcripts-unattributed"].federated).toBe(false);
    expect(Object.keys(fakeBrain().pages.default ?? {})).toEqual([]);
  });

  it("refuses unattributed transcripts for a remote (Postgres) brain while attributed ones import", () => {
    mkdirSync(join(home, ".gbrain"), { recursive: true });
    writeFileSync(join(home, ".gbrain", "config.json"), JSON.stringify({ engine: "postgres", database_url: ["postgresql://u", "p@db.example.com/brain"].join(":") }));
    const loose = session("loose0000001", join(home, "not-a-repo"));
    const kept = session("alpha0000001", repo("alpha"));
    const r = run(["--bulk", "--quiet", "--include-unattributed"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("kept 1 unattributed transcript(s) on this machine: the brain is remote");
    expect(sessions()[loose]).toBeUndefined();
    expect(sessions()[kept].status).toBe("ingested");
    expect(fakeBrain().sources["gstack-transcripts-unattributed"]).toBeUndefined();
  });

  it("a transcript stamped before this release keeps its default source when it changes, so no duplicate appears", () => {
    const path = session("legacy000001", repo("alpha"));
    writeFileSync(join(gstackHome, ".transcript-ingest-state.json"), JSON.stringify({
      schema_version: 1, last_writer: "gstack-memory-ingest",
      sessions: { [path]: { mtime_ns: 1, sha256: "old", ingested_at: "2026-09-01T00:00:00Z", page_slug: "transcripts/claude-code/acme-alpha/old" } },
    }));
    expect(run(["--incremental", "--quiet"]).status).toBe(0);
    const imports = calls().filter((c) => c[0] === "import");
    expect(imports).toHaveLength(1);
    expect(imports[0]).not.toContain("--source-id");
    expect(sessions()[path]).toMatchObject({ status: "ingested", source_id: "default" });
    expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
  });

  it("when gbrain cannot register sources the partition stays local, unstamped, and the run says why", () => {
    const path = session("alpha0000001", repo("alpha"));
    const r = spawnSync(process.execPath, [SCRIPT, "--sources", "transcript", "--bulk", "--quiet"], {
      env: { ...env, FAKE_NO_SOURCES: "1" }, cwd: home, encoding: "utf-8", timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/kept 1 transcript page\(s\) for github\.com\/acme\/alpha on this machine: could not register gbrain source gstack-transcripts-\S+/);
    expect(calls().some((c) => c[0] === "import")).toBe(false);
    expect(sessions()[path]).toBeUndefined();
  });

  describe("managed gbrain 0.60: each transcript source is bound to its own checkout (#3097)", () => {
    const managed = (extra: Record<string, string> = {}) => ({ FAKE_MANAGED: "1", ...extra });
    function runWith(args: string[], extra: Record<string, string>) {
      const r = spawnSync(process.execPath, [SCRIPT, "--sources", "transcript", ...args], { env: { ...env, ...extra }, cwd: home, encoding: "utf-8", timeout: 60_000 });
      return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    }
    const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf-8", timeout: 10_000 });
    const pageFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
    const alpha = transcriptSourceId("github.com/acme/alpha");
    const checkout = () => transcriptCheckoutPath(alpha, join(gstackHome, "gbrain-transcript-sources"));
    const seedBrain = (sources: Record<string, unknown>, pages: Record<string, unknown> = {}) =>
      writeFileSync(brain.brainFile, JSON.stringify({ sources: { default: { federated: true }, ...sources }, pages }));

    it("a fresh source is bound to a checkout under the state root, imports, and keeps one snapshot commit across runs", () => {
      const first = session("alpha00000000001", repo("alpha"));
      const r = runWith(["--bulk", "--quiet"], managed());
      expect(r.status).toBe(0);
      const add = calls().find((c) => c[0] === "sources" && c[1] === "add" && c[2] === alpha)!;
      expect(add).toEqual(expect.arrayContaining(["--path", checkout(), "--no-federated"]));
      expect(fakeBrain().sources[alpha].binding).toMatchObject({ owner_host_id: "host-local", local_path: checkout(), state: "active" });
      expect(sessions()[first]).toMatchObject({ status: "ingested", source_id: alpha });
      expect(pageFiles(checkout())).toHaveLength(1);
      expect(git(checkout(), "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
      expect(git(checkout(), "status", "--porcelain").stdout.trim()).toBe("");

      // Second run: a new session lands, the source is not added again, and
      // the checkout still holds exactly one commit with both pages.
      session("alpha00000000002", join(home, "repos", "alpha"));
      rmSync(brain.callLog);
      expect(runWith(["--incremental", "--quiet"], managed()).status).toBe(0);
      expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
      expect(pageFiles(checkout())).toHaveLength(2);
      expect(git(checkout(), "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
      expect(git(checkout(), "ls-files").stdout.trim().split("\n").filter((f) => f.endsWith(".md"))).toHaveLength(2);
      expect(git(checkout(), "reflog").stdout.trim()).toBe("");
    });

    it("an existing path-less source registered by an earlier run is migrated on the next run and its imports land", () => {
      const path = session("alpha00000000001", repo("alpha"));
      seedBrain({ [alpha]: { federated: false } });
      writeFileSync(join(gstackHome, ".transcript-ingest-state.json"), JSON.stringify({
        schema_version: 2, last_writer: "gstack-memory-ingest", sessions: {},
        sources: { [alpha]: { repo: "github.com/acme/alpha", registered_at: "2026-10-01T00:00:00Z" } },
      }));
      const r = runWith(["--bulk", "--quiet"], managed());
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`bound gbrain source ${alpha} to ${checkout()}: it had no checkout`);
      expect(fakeBrain().sources[alpha]).toMatchObject({ local_path: checkout(), binding: { owner_host_id: "host-local" } });
      expect(sessions()[path]).toMatchObject({ status: "ingested", source_id: alpha });
      expect(git(checkout(), "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
    });

    it("a migrated source whose pages predate the binding stays uncommitted until they re-import, then snapshots", () => {
      const path = session("alpha00000000001", repo("alpha"));
      // Imported before managed persistence: the page is in the brain, with no file.
      expect(runWith(["--bulk", "--quiet"], {}).status).toBe(0);
      expect(sessions()[path]).toMatchObject({ status: "ingested", source_id: alpha });
      session("alpha00000000002", join(home, "repos", "alpha"));
      const r = runWith(["--incremental", "--quiet"], managed());
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("1 page(s) imported before the binding are re-imported on the next run");
      expect(r.stderr).toContain(`left the checkout of ${alpha} uncommitted: gbrain holds 2 page(s) for it and 1 have a file`);
      expect(git(checkout(), "rev-parse", "--verify", "-q", "HEAD").status).not.toBe(0);
      expect(sessions()[path].status).toBe("refused");
      expect(runWith(["--incremental", "--quiet"], managed()).status).toBe(0);
      expect(sessions()[path]).toMatchObject({ status: "ingested", source_id: alpha });
      expect(pageFiles(checkout())).toHaveLength(2);
      expect(git(checkout(), "rev-list", "--count", "HEAD").stdout.trim()).toBe("1");
    });

    it("a resumed timeout checkpoint staged before the upgrade is admitted and migrated before it imports", () => {
      const path = session("alpha00000000001", repo("alpha"));
      const stage = join(gstackHome, `.staging-ingest-1-2-src-${alpha}`);
      // Before the upgrade: a path-less source, and a stage left behind by an import that never landed.
      runWith(["--bulk", "--quiet"], { FAKE_FAIL: "transcripts", FAKE_COPY_STAGE: stage });
      expect(fakeBrain().sources[alpha].local_path).toBeUndefined();
      expect(sessions()[path]).toBeUndefined();
      expect(existsSync(stage)).toBe(true);
      rmSync(brain.callLog);
      const r = runWith(["--bulk", "--quiet"], managed({ GSTACK_INGEST_RESUME_DIR: stage }));
      expect(r.status).toBe(0);
      const log = calls();
      const add = log.findIndex((c) => c[0] === "sources" && c[1] === "add" && c.includes("--path"));
      const imp = log.findIndex((c) => c[0] === "import" && c[1] === stage);
      expect(add).toBeGreaterThan(-1);
      expect(imp).toBeGreaterThan(add);
      expect(sessions()[path]).toMatchObject({ status: "ingested", source_id: alpha });
      expect(existsSync(stage)).toBe(false);
    });

    it("a source held by another owner is left alone, with a message naming the owner and the commands", () => {
      const path = session("alpha00000000001", repo("alpha"));
      seedBrain({ [alpha]: { federated: false, binding: { owner_host_id: "host-other", local_path: "/srv/other/alpha", state: "active" } } });
      const r = runWith(["--bulk", "--quiet"], managed());
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`gbrain source ${alpha} is held by another owner (host host-other, checkout (none on this host))`);
      expect(r.stderr).toContain(`gbrain sources writer status --source ${alpha} --json`);
      expect(r.stderr).toContain(`gbrain sources set-path ${alpha} ${checkout()}`);
      expect(r.stderr).toContain("docs/troubleshooting.md#memory-ingest-transcript-checkout");
      expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
      expect(calls().some((c) => c[0] === "import")).toBe(false);
      expect(fakeBrain().sources[alpha].binding.owner_host_id).toBe("host-other");
      expect(sessions()[path]).toBeUndefined();
      expect(existsSync(checkout())).toBe(false);
    });

    it("a source this host bound to a different directory is not taken over either", () => {
      session("alpha00000000001", repo("alpha"));
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere);
      seedBrain({ [alpha]: { federated: false, local_path: elsewhere, binding: { owner_host_id: "host-local", local_path: elsewhere, state: "active" } } });
      const r = runWith(["--bulk", "--quiet"], managed());
      expect(r.stderr).toContain(`is held by another owner (this host, checkout ${elsewhere})`);
      expect(calls().some((c) => c[0] === "import")).toBe(false);
      expect(fakeBrain().sources[alpha].binding.local_path).toBe(elsewhere);
    });

    it("binding is refused under an ephemeral state root; an already-bound source still imports there", () => {
      const path = session("alpha00000000001", repo("alpha"));
      const r = runWith(["--bulk", "--quiet"], managed({ GSTACK_EPHEMERAL: "1" }));
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("this state root");
      expect(r.stderr).toContain("is ephemeral (GSTACK_EPHEMERAL=1), so gstack does not bind one");
      expect(r.stderr).toContain("GSTACK_STATE_ROOT=<durable directory> gstack-memory-ingest --bulk");
      expect(calls().some((c) => c[0] === "sources" && c[1] === "add")).toBe(false);
      expect(sessions()[path]).toBeUndefined();
      // Bound on a durable run, then ingesting again on an ephemeral one.
      expect(runWith(["--bulk", "--quiet"], managed()).status).toBe(0);
      session("alpha00000000002", join(home, "repos", "alpha"));
      expect(runWith(["--incremental", "--quiet"], managed({ GSTACK_EPHEMERAL: "1" })).status).toBe(0);
      expect(pageFiles(checkout())).toHaveLength(2);
    });
  });
});
