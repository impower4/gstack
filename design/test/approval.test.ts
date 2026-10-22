/**
 * approved.json readers: approved_path (relative to approved.json) wins, legacy
 * letter-only records still resolve, and a missing approved image is an error,
 * never a substitute.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveApprovedImage } from "../src/approval";

const BIN = path.join(import.meta.dir, "..", "..", "bin", "gstack-design-approved");
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-approval-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function record(sessionDir: string, data: object): string {
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "approved.json");
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

describe("resolveApprovedImage", () => {
  // Value: protects=pre-upgrade letter-only records keep resolving to variant-<L>.png; fails_when=the legacy fallback is removed;
  //   why_new=approved_path is new and legacy records exist on disk; seam=none
  test("legacy letter-only record resolves by letter", () => {
    const file = record(dir, { approved_variant: "B" });
    fs.writeFileSync(path.join(dir, "variant-B.png"), "b");
    expect(resolveApprovedImage(file)).toEqual({ ok: true, path: path.join(dir, "variant-B.png"), legacy: true });
  });

  // Value: protects=a present-but-missing approved_path errors instead of resolving variant-A.png; fails_when=readers fall back to the letter;
  //   why_new=eng approval-fallback precedence; seam=none
  test("missing approved_path errors and never substitutes the letter's image", () => {
    const file = record(dir, { approved_variant: "A", approved_path: "variant-A-2.png" });
    fs.writeFileSync(path.join(dir, "variant-A.png"), "round one");
    const r = resolveApprovedImage(file);
    expect(r).toEqual({ ok: false, error: `approved image ${path.join(dir, "variant-A-2.png")} is missing; reselect from the board` });
    const cli = spawnSync(process.execPath, [BIN, file], { encoding: "utf8", timeout: 30_000 });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("reselect from the board");
  });

  // Value: protects=approved_path is relative, so a copied or relocated designs directory still resolves; fails_when=an absolute path is stored or resolved against cwd;
  //   why_new=DX relocation requirement; seam=none
  test("relocated designs directory still resolves the approved image", () => {
    const original = path.join(dir, "state", "designs", "home-20261003");
    record(original, { approved_variant: "A", approved_path: "variant-A-2.png" });
    fs.writeFileSync(path.join(original, "variant-A-2.png"), "round two");
    const moved = path.join(dir, "elsewhere", "home-20261003");
    fs.cpSync(original, moved, { recursive: true });
    fs.rmSync(path.join(dir, "state"), { recursive: true });
    const cli = spawnSync(process.execPath, [BIN, path.join(moved, "approved.json")], { encoding: "utf8", timeout: 30_000, cwd: os.tmpdir() });
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.trim()).toBe(path.join(moved, "variant-A-2.png"));
  });
});
