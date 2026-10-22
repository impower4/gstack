/**
 * Regression pin for #2091: /codex was broken on every macOS install because
 * its mktemp templates carried a suffix after the X's ("codex-err-XXXXXX.txt").
 * BSD mktemp (macOS) requires the X's to be the trailing characters of the
 * template; with a suffix it fails ("mkstemp failed ... File exists"), the
 * temp file never exists, and the skill dies before Codex ever runs.
 *
 * GNU mktemp accepts a --suffix flag but ALSO rejects inline suffixes in the
 * template argument on BusyBox, so the portable form is: X's last, no suffix.
 *
 * This scans every .tmpl (the sources of truth — generated SKILL.md files
 * follow at regen time) for the broken shape.
 */

import { describe, it, expect } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function trackedTmplFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.tmpl", "**/*.tmpl"], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return [...new Set(out.split("\n").filter(Boolean))].filter(rel => existsSync(join(ROOT, rel)));
}

describe("mktemp portability (#2091)", () => {
  it("no .tmpl file uses a mktemp template with characters after XXXXXX", () => {
    const offenders: string[] = [];
    for (const rel of trackedTmplFiles()) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      src.split("\n").forEach((line, i) => {
        // Broken shape: the X-run followed by a non-quote, non-whitespace,
        // non-closing character inside a mktemp invocation. X{6,} is greedy,
        // so longer X-runs (spec's XXXXXXXX) stay valid — only a genuine
        // suffix after the final X trips it.
        if (/mktemp[^\n]*X{6,}[^"'\s)X]/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("BSD-portable form actually works on this platform", () => {
    // Live sanity: the exact template shape the skills now emit.
    const tmp = process.env.TMPDIR || "/tmp";
    const created = execFileSync("mktemp", [`${tmp.replace(/\/$/, "")}/gstack-portability-XXXXXX`], {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();
    expect(created.length).toBeGreaterThan(0);
    execFileSync("rm", ["-f", created], { timeout: 30_000 });
  });

  // #2881: a failed mktemp left TMPERR empty, so `2>"$TMPERR"` failed before
  // codex started and read as a Codex error ("no stderr captured").
  it("every /codex and outside-voice mktemp assignment fails closed", () => {
    const sources = [
      ...readdirSync(join(ROOT, "codex/sections")).filter(f => f.endsWith(".md.tmpl")).map(f => `codex/sections/${f}`),
      "scripts/resolvers/outside-voice.ts",
      "scripts/resolvers/outside-voice-steps.ts",
    ];
    const unguarded: string[] = [];
    for (const rel of sources) {
      readFileSync(join(ROOT, rel), "utf-8").split("\n").forEach((line, i) => {
        if (/=\$\(mktemp\b/.test(line) && !/\)\s*\|\|/.test(line)) unguarded.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(unguarded).toEqual([]);

    const rendered = readdirSync(join(ROOT, "codex/sections")).filter(f => f.endsWith(".md") && !f.endsWith(".tmpl"))
      .flatMap(f => readFileSync(join(ROOT, "codex/sections", f), "utf-8").split("\n").filter(line => /^\S.*=\$\(mktemp\b/.test(line)));
    expect(rendered.length).toBeGreaterThanOrEqual(5);
    for (const line of rendered) {
      const r = spawnSync("bash", ["-c", `TMP_ROOT=/nonexistent/gstack-2881\n${line}\necho REACHED`], { encoding: "utf-8", timeout: 30_000 });
      expect(r.status, line).toBe(1);
      expect(r.stdout, line).not.toContain("REACHED");
      expect(r.stderr, line).toContain("mktemp failed");
    }
  });
});
