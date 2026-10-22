/**
 * The brain-sync stage of gstack-gbrain-sync skips with a one-line summary
 * when Windows has no bash. That line must name the canonical override
 * GSTACK_GIT_BASH (GSTACK_BASH is the deprecated alias) and say how to set it
 * so Claude Code sees it: a Git Bash `export` reaches only that shell.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { NO_BASH_SUMMARY } from "../bin/gstack-gbrain-sync";

describe("gstack-gbrain-sync no-bash summary", () => {
  test("names GSTACK_GIT_BASH first and GSTACK_BASH as the old alias", () => {
    expect(NO_BASH_SUMMARY).toContain("GSTACK_GIT_BASH");
    expect(NO_BASH_SUMMARY).toContain("GSTACK_BASH");
    expect(NO_BASH_SUMMARY.indexOf("GSTACK_GIT_BASH")).toBeLessThan(NO_BASH_SUMMARY.indexOf("old name: GSTACK_BASH"));
  });

  test("gives the PowerShell user-variable and settings.json recipes", () => {
    expect(NO_BASH_SUMMARY).toContain("[Environment]::SetEnvironmentVariable('GSTACK_GIT_BASH'");
    expect(NO_BASH_SUMMARY).toContain("'User')");
    expect(NO_BASH_SUMMARY).toContain("restart Claude Code");
    expect(NO_BASH_SUMMARY).toContain('"env" block of ~/.claude/settings.json');
  });

  test("the brain-sync stage reports exactly this summary when bash is missing", () => {
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts"), "utf8");
    const stage = src.slice(src.indexOf("function runBrainSyncPush("), src.indexOf("function runBrainSyncPush(") + 3000);
    expect(stage).toMatch(/if \(!discover \|\| !once\) \{[\s\S]{0,200}summary: NO_BASH_SUMMARY/);
    expect(src).not.toContain("set GSTACK_BASH to your Git bash.exe");
  });
});
