/**
 * `$D compare` image list input: --images-file and JSON arrays carry any path
 * losslessly; comma and glob input keep working.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveImagePaths } from "../src/image-args";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-image-args-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// Value: protects=a path containing a comma and a space reaches compare intact via --images-file; fails_when=the file is split on commas;
//   why_new=Lossless path handoff is new; seam=none
test("--images-file keeps a comma+space path and builds the board", () => {
  const odd = path.join(dir, "round 2, final");
  fs.mkdirSync(odd);
  const images = [path.join(odd, "variant-A-2.png"), path.join(odd, "variant-B.png")];
  for (const img of images) fs.writeFileSync(img, Buffer.from("iVBORw0KGgo=", "base64"));
  const list = path.join(odd, "board-images.json");
  fs.writeFileSync(list, JSON.stringify(images));
  const board = path.join(odd, "board.html");
  const r = spawnSync(process.execPath, ["--no-env-file", path.join(import.meta.dir, "..", "src", "cli.ts"),
    "compare", "--images-file", list, "--output", board], { encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH!, HOME: dir } });
  expect(r.status, r.stderr).toBe(0);
  const html = fs.readFileSync(board, "utf8");
  expect(html).toContain('data-variant="A"');
  expect(html).toContain('data-variant="B"');
  expect(html).not.toContain('data-variant="C"');
});

// Value: protects=JSON-array --images input and the unchanged comma form; fails_when=a `[`-prefixed literal path is misparsed or comma input changes;
//   why_new=new input form; seam=none
test("--images: JSON array only when it parses; otherwise comma and literal behavior is unchanged", async () => {
  expect(await resolveImagePaths('["/a, b/x.png","/c.png"]')).toEqual(["/a, b/x.png", "/c.png"]);
  expect(await resolveImagePaths("[draft]/x.png")).toEqual(["[draft]/x.png"]);
  expect(await resolveImagePaths("/a.png, /b.png")).toEqual(["/a.png", "/b.png"]);
  expect(await resolveImagePaths("[1,2]")).toEqual(["[1", "2]"]);
});

// Value: protects=a malformed --images-file fails loudly instead of building an empty board; fails_when=parse errors are swallowed;
//   why_new=new flag; seam=none
test("--images-file must hold a JSON array of strings", async () => {
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, '{"paths": []}');
  await expect(resolveImagePaths(undefined, bad)).rejects.toThrow("JSON array");
  await expect(resolveImagePaths(undefined, path.join(dir, "none.json"))).rejects.toThrow("cannot read --images-file");
});
