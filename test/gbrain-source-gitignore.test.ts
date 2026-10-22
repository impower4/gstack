/**
 * Unit tests for the `.gbrain-source` gitignore append done by
 * `runCodeImport` after a successful `gbrain sources attach`.
 *
 * Covers #1384: v1.29.0.0 changelog promised the per-worktree pin would be
 * ignored in the consuming repo, but the change actually only added
 * `.gbrain-source` to gstack's own `.gitignore`. Without the consumer-side
 * entry, Conductor sibling worktrees commit the pin and clobber each other.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import { ensureGbrainSourceGitignored } from "../bin/gstack-gbrain-sync";

describe("ensureGbrainSourceGitignored", () => {
  let root: string;

  let home: string;
  const saved: Record<string, string | undefined> = {};
  const ISOLATED = ["HOME", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gstack-gbrain-gitignore-"));
    home = mkdtempSync(join(tmpdir(), "gstack-gbrain-gitignore-home-"));
    for (const key of ISOLATED) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    delete process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });

  afterEach(() => {
    for (const key of ISOLATED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf-8", timeout: 10_000 });
    expect(r.status).toBe(0);
    return r;
  };

  it("creates .gitignore with the pin entry when none exists", () => {
    const gitignorePath = join(root, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);

    ensureGbrainSourceGitignored(root);

    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toBe(".gbrain-source\n");
  });

  it("appends the pin entry to an existing .gitignore without trailing newline", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.env");

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe(
      "node_modules\n.env\n.gbrain-source\n",
    );
  });

  it("appends the pin entry to an existing .gitignore with trailing newline", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.env\n");

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe(
      "node_modules\n.env\n.gbrain-source\n",
    );
  });

  it("is idempotent: does not duplicate the pin entry on a second call", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n.gbrain-source\n.env\n");

    ensureGbrainSourceGitignored(root);
    ensureGbrainSourceGitignored(root);

    const lines = readFileSync(gitignorePath, "utf-8").split("\n");
    const hits = lines.filter((line) => line.trim() === ".gbrain-source");
    expect(hits.length).toBe(1);
  });

  it("recognizes the entry even when it has surrounding whitespace", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n  .gbrain-source  \n");

    ensureGbrainSourceGitignored(root);

    const lines = readFileSync(gitignorePath, "utf-8").split("\n");
    const hits = lines.filter((line) => line.trim() === ".gbrain-source");
    expect(hits.length).toBe(1);
  });

  it("does not append when git already ignores the pin", () => {
    const gitignorePath = join(root, ".gitignore");
    const canonical = "# gstack-artifacts sync: ignore-everything base.\n*\n";
    writeFileSync(gitignorePath, canonical);
    const init = spawnSync("git", ["init", "-q"], { cwd: root, timeout: 10_000 });
    expect(init.status).toBe(0);
    git("add", "-f", ".gitignore");

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe(canonical);
  });

  it("still appends in a git repo whose patterns do not ignore the pin", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    const init = spawnSync("git", ["init", "-q"], { cwd: root, timeout: 10_000 });
    expect(init.status).toBe(0);

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe("node_modules\n.gbrain-source\n");
  });

  it("still appends when only the user's global excludes ignore the pin", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    git("init", "-q");
    git("add", ".gitignore");
    const excludes = join(home, "global-excludes");
    writeFileSync(excludes, ".gbrain-source\n");
    writeFileSync(join(home, ".gitconfig"), `[core]\n\texcludesFile = ${JSON.stringify(excludes)}\n`);
    expect(spawnSync("git", ["check-ignore", "-q", ".gbrain-source"], { cwd: root, timeout: 10_000 }).status).toBe(0);

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe("node_modules\n.gbrain-source\n");
  });

  it("still appends when only .git/info/exclude ignores the pin", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    git("init", "-q");
    git("add", ".gitignore");
    writeFileSync(join(root, ".git", "info", "exclude"), ".gbrain-source\n");

    ensureGbrainSourceGitignored(root);

    expect(readFileSync(gitignorePath, "utf-8")).toBe("node_modules\n.gbrain-source\n");
  });

  it("still appends when the ignoring .gitignore is untracked, or re-includes the pin", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "*\n");
    git("init", "-q");

    ensureGbrainSourceGitignored(root);
    expect(readFileSync(gitignorePath, "utf-8")).toBe("*\n.gbrain-source\n");

    writeFileSync(gitignorePath, "*\n!.gbrain-source\n");
    git("add", "-f", ".gitignore");
    ensureGbrainSourceGitignored(root);
    expect(readFileSync(gitignorePath, "utf-8")).toBe("*\n!.gbrain-source\n.gbrain-source\n");
  });

  it("does not throw when the .gitignore is read-only", () => {
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\n");
    const originalMode = statSync(gitignorePath).mode;
    chmodSync(gitignorePath, 0o444);
    try {
      // Must not throw — sync stage continues on write failure.
      expect(() => ensureGbrainSourceGitignored(root)).not.toThrow();
    } finally {
      chmodSync(gitignorePath, originalMode);
    }
  });
});
