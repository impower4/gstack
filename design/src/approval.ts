/**
 * Resolve the image an approval record names. `approved_path` is stored
 * relative to the directory holding approved.json, so a copied or relocated
 * designs directory still resolves. Records without `approved_path` (written
 * before never-overwrite) fall back to `variant-<approved_variant>.png`. A
 * present `approved_path` whose file is missing is an error: another image is
 * never substituted.
 */

import fs from "fs";
import path from "path";

export type ApprovedImage = { ok: true; path: string; legacy: boolean } | { ok: false; error: string };

export interface ApprovalRecord {
  approved_variant?: unknown;
  approved_path?: unknown;
}

function missing(imagePath: string): ApprovedImage {
  return { ok: false, error: `approved image ${imagePath} is missing; reselect from the board` };
}

function readable(imagePath: string): boolean {
  try {
    fs.accessSync(imagePath, fs.constants.R_OK);
    return fs.statSync(imagePath).isFile();
  } catch {
    return false;
  }
}

/** The image path a record names, without checking that it exists. */
export function approvedImagePath(record: ApprovalRecord, recordDir: string): { path: string; legacy: boolean } | null {
  if (typeof record.approved_path === "string" && record.approved_path !== "") {
    return { path: path.resolve(recordDir, record.approved_path), legacy: false };
  }
  if (typeof record.approved_variant === "string" && record.approved_variant !== "") {
    return { path: path.join(recordDir, `variant-${record.approved_variant}.png`), legacy: true };
  }
  return null;
}

export function resolveApprovedImage(approvedJsonPath: string): ApprovedImage {
  let record: ApprovalRecord;
  try {
    record = JSON.parse(fs.readFileSync(approvedJsonPath, "utf-8"));
  } catch (err: any) {
    return { ok: false, error: `cannot read ${approvedJsonPath}: ${err.code || err.message}` };
  }
  const named = approvedImagePath(record ?? {}, path.dirname(path.resolve(approvedJsonPath)));
  if (!named) {
    return { ok: false, error: `${approvedJsonPath} names no approved image; reselect from the board` };
  }
  return readable(named.path) ? { ok: true, ...named } : missing(named.path);
}
