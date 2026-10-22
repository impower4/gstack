/**
 * Image list parsing for `$D compare`. Accepted forms, in order:
 *   --images-file <path>   JSON array of path strings (lossless; skills use this)
 *   --images '[...]'       JSON array string, only when it starts with `[` and parses as string[]
 *   --images 'dir/*.png'   glob (sorted)
 *   --images 'a.png,b.png' comma-separated list, or a single path
 */

import fs from "fs";

function parseStringArray(text: string): string[] | null {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
  } catch {}
  return null;
}

export async function resolveImagePaths(input: string | undefined, imagesFile?: string): Promise<string[]> {
  if (imagesFile) {
    let text: string;
    try {
      text = fs.readFileSync(imagesFile, "utf-8");
    } catch (err: any) {
      throw new Error(`cannot read --images-file ${imagesFile}: ${err.code || err.message}`);
    }
    const list = parseStringArray(text);
    if (!list) throw new Error(`--images-file ${imagesFile} must contain a JSON array of image path strings`);
    return list;
  }

  if (!input) {
    throw new Error("--images or --images-file is required. Provide a JSON array file, glob pattern or comma-separated paths.");
  }

  if (input.trimStart().startsWith("[")) {
    const list = parseStringArray(input);
    if (list) return list;
  }

  if (input.includes("*")) {
    const glob = new Bun.Glob(input);
    const paths: string[] = [];
    for await (const match of glob.scan({ absolute: true })) {
      if (match.endsWith(".png") || match.endsWith(".jpg") || match.endsWith(".jpeg")) {
        paths.push(match);
      }
    }
    return paths.sort();
  }

  return input.split(",").map(p => p.trim());
}
