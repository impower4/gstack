/**
 * persistImage / claimOutputPath: a paid image is never overwritten and never lost.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { CLAIM_CAP, bumpedName, claimOutputPath, persistImage, type PersistFs } from "../src/persist";

const PNG = Buffer.from("fake paid image bytes");
const B64 = PNG.toString("base64");

let dir: string;
let tmp: string;
let stderr: string[];
const savedError = console.error;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-persist-"));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "design-persist-tmp-"));
  stderr = [];
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(" ")); };
});

afterEach(() => {
  console.error = savedError;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

function failingFs(fail: { op: keyof PersistFs; code: string; when?: (p: unknown) => boolean }): PersistFs {
  const wrapped: any = {};
  for (const op of ["mkdirSync", "openSync", "writeSync", "fsyncSync", "closeSync", "unlinkSync"] as const) {
    wrapped[op] = (...args: any[]) => {
      if (op === fail.op && (!fail.when || fail.when(args[0]))) {
        throw Object.assign(new Error(`${fail.code}: simulated ${op} failure`), { code: fail.code });
      }
      return (fs as any)[op](...args);
    };
  }
  return wrapped;
}

describe("claimOutputPath", () => {
  // Value: protects=an existing image is never truncated and the next free -N name is claimed;
  //   fails_when=the claim opens with "w" instead of "wx" or the bump rule changes; why_new=no claim existed before; seam=none
  test("keeps existing files and bumps sequentially", () => {
    const requested = path.join(dir, "x.png");
    fs.writeFileSync(requested, "round one");
    const second = claimOutputPath(requested);
    fs.closeSync(second.fd);
    const third = claimOutputPath(requested);
    fs.closeSync(third.fd);
    expect([second.path, third.path]).toEqual([path.join(dir, "x-2.png"), path.join(dir, "x-3.png")]);
    expect(fs.readFileSync(requested, "utf8")).toBe("round one");
    expect(bumpedName(path.join(dir, "x-2.png"), 2)).toBe(path.join(dir, "x-2-2.png"));
  });

  // Value: protects=parallel writers (variants, shotgun subagents) each get their own file;
  //   fails_when=the claim is check-then-write instead of an exclusive create; why_new=concurrency was untested; seam=none
  test("N concurrent processes claim N distinct files", async () => {
    const requested = path.join(dir, "variant-A.png");
    const script = `import { claimOutputPath } from ${JSON.stringify(path.join(import.meta.dir, "../src/persist.ts"))};
const c = claimOutputPath(process.argv[2]); console.log(c.path);`;
    const scriptPath = path.join(tmp, "claim.ts");
    fs.writeFileSync(scriptPath, script);
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, scriptPath, requested], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()));
    await Promise.all(procs.map(p => p.exited));
    const claimed = outs.map(o => o.trim());
    expect(new Set(claimed).size).toBe(8);
    expect(fs.readdirSync(dir).length).toBe(8);
  });

  // Value: protects=a permission error fails at once instead of walking 999 names; fails_when=every open error is treated as EEXIST;
  //   why_new=new behavior; seam=PersistFs fault injection
  test("non-EEXIST open errors do not bump", () => {
    let opens = 0;
    const fsImpl = failingFs({ op: "openSync", code: "EACCES", when: () => { opens++; return true; } });
    expect(() => claimOutputPath(path.join(dir, "x.png"), fsImpl)).toThrow("EACCES");
    expect(opens).toBe(1);
  });

  // Value: protects=the claim stops at -999 with an error; fails_when=the cap is removed (unbounded loop) or off by one;
  //   why_new=new behavior; seam=PersistFs fault injection
  test("stops at the -999 cap", () => {
    const fsImpl = failingFs({ op: "openSync", code: "EEXIST" });
    expect(() => claimOutputPath(path.join(dir, "x.png"), fsImpl)).toThrow(`x-${CLAIM_CAP}.png already exist`);
  });
});

describe("persistImage", () => {
  // Value: protects=the exact bump notice and actual-path reporting scripts rely on; fails_when=the notice text or returned path drifts;
  //   why_new=bumping is new; seam=none
  test("bumps a taken name, prints the notice and leaves the old bytes untouched", () => {
    const requested = path.join(dir, "nested", "x.png");
    fs.mkdirSync(path.dirname(requested));
    fs.writeFileSync(requested, "old");
    const outcome = persistImage(B64, requested, { tmpdir: tmp });
    const actual = path.join(dir, "nested", "x-2.png");
    expect(outcome).toEqual({ ok: true, path: actual, bytes: PNG.length });
    expect(stderr).toContain(`note: ${requested} exists; saved to ${actual} (existing file kept)`);
    expect(fs.readFileSync(requested, "utf8")).toBe("old");
    expect(fs.readFileSync(actual)).toEqual(PNG);
  });

  // Value: protects=an empty API image is a failure, not a 0-byte PNG; fails_when=the empty-bytes guard is removed;
  //   why_new=closes the CEO empty-b64 warning; seam=none
  test("empty image data is a failure with no claim and no file", () => {
    const outcome = persistImage("", path.join(dir, "x.png"), { tmpdir: tmp });
    expect(outcome.ok).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  // Value: protects=a mid-write ENOSPC removes the partial claimed file and keeps a 0600 recovery copy; fails_when=cleanup or recovery is skipped;
  //   why_new=new behavior; seam=PersistFs fault injection
  test("post-claim write failure removes the claimed file and saves a private recovery copy", () => {
    const requested = path.join(dir, "x.png");
    let writes = 0;
    const fsImpl = failingFs({ op: "writeSync", code: "ENOSPC", when: () => writes++ === 0 });
    const outcome = persistImage(B64, requested, { tmpdir: tmp, fs: fsImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(fs.existsSync(requested)).toBe(false);
    const recovery = outcome.recovered!.path;
    expect(path.dirname(recovery)).toBe(tmp);
    expect(path.basename(recovery)).toMatch(/^gstack-design-unsaved-.*\.png$/);
    expect(fs.readFileSync(recovery)).toEqual(PNG);
    expect(fs.statSync(recovery).mode & 0o777).toBe(0o600);
    expect(outcome.failure.file).toBe(requested);
    expect(outcome.failure.reason).toContain(`cannot save paid image to ${requested}: ENOSPC`);
    expect(outcome.failure.reason).toContain(`saved a recovery copy to ${recovery}`);
    expect(outcome.failure.reason).toContain("Fix: free disk space");
  });

  // Value: protects=a mkdir/claim failure (EACCES) still recovers the bytes with problem, cause and fix; fails_when=recovery only covers write errors;
  //   why_new=new behavior; seam=PersistFs fault injection
  test("EACCES on the claim recovers the bytes and names the fix", () => {
    const requested = path.join(dir, "x.png");
    const fsImpl = failingFs({ op: "openSync", code: "EACCES", when: p => p === requested });
    const outcome = persistImage(B64, requested, { tmpdir: tmp, fs: fsImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.reason).toMatch(/cannot save paid image to .*x\.png: EACCES \(.*\)\. Image bytes were received; saved a recovery copy to .*\. Fix: make .* writable/);
    expect(fs.readFileSync(outcome.recovered!.path)).toEqual(PNG);
  });

  // Value: protects=when the recovery copy also fails both errors and the byte count are reported and no recovery is claimed;
  //   fails_when=the message claims a recovery copy that does not exist; why_new=new behavior; seam=PersistFs fault injection
  test("recovery failure reports both errors and the byte count", () => {
    const requested = path.join(dir, "x.png");
    const fsImpl = failingFs({ op: "openSync", code: "EROFS" });
    const outcome = persistImage(B64, requested, { tmpdir: tmp, fs: fsImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.recovered).toBeUndefined();
    expect(outcome.failure.reason).toContain(`(${PNG.length} bytes)`);
    expect(outcome.failure.reason).toContain("recovery copy");
    expect(outcome.failure.reason.match(/EROFS/g)!.length).toBeGreaterThanOrEqual(2);
    expect(outcome.failure.reason).not.toContain("saved a recovery copy");
  });
});
