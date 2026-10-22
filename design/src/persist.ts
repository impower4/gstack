/**
 * Persistence for paid design images. Every image the API returns goes through
 * persistImage exactly once: mkdir, exclusive claim (never overwrite), write,
 * fsync, close. Any failure after the bytes arrived removes the claimed file and
 * leaves a private recovery copy in os.tmpdir(), so a paid image is never lost
 * or silently replaced.
 *
 * Every generating command prints the same accounting fields (see
 * commands.ts for the $D contract):
 *   requested  number of images the command set out to produce
 *   saved      every image path written, in order
 *   selected   outputPath (single-image commands) or paths (variants)
 *   failures   [{file, reason}] for every image that was not saved
 *   recovered  [{path, reason}] recovery copies written after a save failed
 * Exit 0 when a selected result exists, 2 when nothing was saved, 3 when the
 * run stopped after saving at least one image but before its selected result.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export const CLAIM_CAP = 999;

export interface PersistFs {
  mkdirSync(p: string, opts: { recursive: true }): unknown;
  openSync(p: string, flags: string, mode?: number): number;
  writeSync(fd: number, buf: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  unlinkSync(p: string): void;
}

export interface PersistDeps {
  fs?: PersistFs;
  tmpdir?: string;
}

export interface Failure { file: string; reason: string }
export interface Recovery { path: string; reason: string }

export type PersistOutcome =
  | { ok: true; path: string; bytes: number }
  | { ok: false; failure: Failure; recovered?: Recovery };

export interface RunAccounting {
  requested: number;
  saved: string[];
  failures: Failure[];
  recovered: Recovery[];
}

/** `x.png` -> `x-2.png`; `x-2.png` -> `x-2-2.png`. The suffix always appends to the requested stem. */
export function bumpedName(requested: string, n: number): string {
  const ext = path.extname(requested);
  return `${requested.slice(0, requested.length - ext.length)}-${n}${ext}`;
}

/**
 * Atomically create the first free name among requested, -2 ... -999 with an
 * exclusive `wx` open. Only EEXIST bumps; any other open error throws at once.
 */
export function claimOutputPath(requested: string, fsImpl: PersistFs = fs): { path: string; fd: number } {
  for (let n = 1; n <= CLAIM_CAP; n++) {
    const candidate = n === 1 ? requested : bumpedName(requested, n);
    try {
      return { path: candidate, fd: fsImpl.openSync(candidate, "wx") };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  const capErr = new Error(`${requested} and every name through ${path.basename(bumpedName(requested, CLAIM_CAP))} already exist`);
  throw Object.assign(capErr, { code: "EEXIST" });
}

function writeAll(fsImpl: PersistFs, fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    offset += fsImpl.writeSync(fd, buf, offset, buf.length - offset);
  }
}

function fixHint(code: string, dir: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return `make ${dir} writable or pass a writable --output/--output-dir`;
    case "ENOSPC":
    case "EDQUOT":
      return `free disk space on the volume holding ${dir}, then rerun`;
    case "EEXIST":
      return `choose a new --output name or move older images out of ${dir}`;
    case "ENOENT":
    case "ENOTDIR":
      return `check that the --output/--output-dir path is a directory you can create`;
    default:
      return `pass a writable --output/--output-dir`;
  }
}

function describeError(err: any): { code: string; cause: string } {
  return { code: err?.code || "ERROR", cause: err?.message || String(err) };
}

function writeRecoveryCopy(bytes: Buffer, fsImpl: PersistFs, tmp: string): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const recoveryPath = path.join(tmp, `gstack-design-unsaved-${stamp}-${crypto.randomBytes(4).toString("hex")}.png`);
  const fd = fsImpl.openSync(recoveryPath, "wx", 0o600);
  try {
    writeAll(fsImpl, fd, bytes);
    fsImpl.closeSync(fd);
  } catch (err) {
    try { fsImpl.closeSync(fd); } catch {}
    try { fsImpl.unlinkSync(recoveryPath); } catch {}
    throw err;
  }
  return recoveryPath;
}

/**
 * Save one received image under `requested` (or its first free -N name).
 * Empty image data is a generation failure: no claim, no file.
 */
export function persistImage(imageData: string, requested: string, deps: PersistDeps = {}): PersistOutcome {
  const fsImpl = deps.fs ?? fs;
  const bytes = Buffer.from(imageData || "", "base64");
  if (bytes.length === 0) {
    const reason = "API returned an empty image; nothing was saved";
    console.error(`  ✗ ${path.basename(requested)}: ${reason}`);
    return { ok: false, failure: { file: requested, reason } };
  }

  let claimed: { path: string; fd: number } | null = null;
  try {
    fsImpl.mkdirSync(path.dirname(requested), { recursive: true });
    claimed = claimOutputPath(requested, fsImpl);
    writeAll(fsImpl, claimed.fd, bytes);
    fsImpl.fsyncSync(claimed.fd);
    fsImpl.closeSync(claimed.fd);
    if (claimed.path !== requested) {
      console.error(`note: ${requested} exists; saved to ${claimed.path} (existing file kept)`);
    }
    return { ok: true, path: claimed.path, bytes: bytes.length };
  } catch (err) {
    const target = claimed?.path ?? requested;
    if (claimed) {
      try { fsImpl.closeSync(claimed.fd); } catch {}
      try { fsImpl.unlinkSync(claimed.path); } catch {}
    }
    const { code, cause } = describeError(err);
    const fix = fixHint(code, path.dirname(requested));
    const tmp = deps.tmpdir ?? os.tmpdir();
    let reason: string;
    let recovered: Recovery | undefined;
    try {
      const recoveryPath = writeRecoveryCopy(bytes, fsImpl, tmp);
      reason = `cannot save paid image to ${target}: ${code} (${cause}). Image bytes were received; saved a recovery copy to ${recoveryPath}. Fix: ${fix}.`;
      recovered = { path: recoveryPath, reason: `${code} (${cause})` };
    } catch (recoveryErr) {
      const second = describeError(recoveryErr);
      reason = `cannot save paid image to ${target}: ${code} (${cause}). Image bytes were received (${bytes.length} bytes) but the recovery copy in ${tmp} also failed: ${second.code} (${second.cause}). Fix: ${fix}.`;
    }
    console.error(reason);
    return { ok: false, failure: { file: requested, reason }, ...(recovered ? { recovered } : {}) };
  }
}

export function newAccounting(requested: number): RunAccounting {
  return { requested, saved: [], failures: [], recovered: [] };
}

/** Fold one persist outcome into the run's accounting; returns the saved path or null. */
export function recordOutcome(acct: RunAccounting, outcome: PersistOutcome): string | null {
  if (outcome.ok) {
    acct.saved.push(outcome.path);
    return outcome.path;
  }
  acct.failures.push(outcome.failure);
  if (outcome.recovered) acct.recovered.push(outcome.recovered);
  return null;
}

export function exitCodeFor(hasSelected: boolean, savedCount: number): ExitCode {
  if (hasSelected) return 0;
  return savedCount === 0 ? 2 : 3;
}

export type ExitCode = 0 | 2 | 3;

/** Print the command's JSON on stdout and return its exit code for the CLI. */
export function emitResult(result: Record<string, unknown>, exitCode: ExitCode): ExitCode {
  console.log(JSON.stringify(result, null, 2));
  return exitCode;
}
