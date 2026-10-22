/**
 * hook-log — the one hook-errors.log writer for the Claude Code hooks in this
 * directory. Root from resolveStateRoot() (lib/state-root.ts), mode 0600 on
 * every append (an existing 0644 log is tightened), best-effort: logging never
 * blocks a hook. Add a hook: `logHookError('my-hook', msg)`; pass
 * `{ rateLimit: { nowMs, key } }` to drop repeats within LOG_RATE_LIMIT_MS
 * (only memorable-user-prompt uses it). Moved from the five hooks' private
 * copies; test/hook-log.test.ts pins the shared root and the mode.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { resolveStateRoot } from '../../../lib/state-root';

export const LOG_RATE_LIMIT_MS = 10 * 60 * 1000;
/** Distinct rate-limit keys remembered at once (the marker file is rewritten on every log line). */
const RATE_LIMIT_KEYS = 32;

export interface HookLogOptions {
  /** Drop a repeat of `key` logged by this hook within LOG_RATE_LIMIT_MS of `nowMs`. */
  rateLimit?: { nowMs: number; key: string };
}

export function hookErrorLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateRoot(env), 'hook-errors.log');
}

/**
 * Append one line to <state root>/hook-errors.log. With `rateLimit`, a
 * per-hook marker (`hook-errors.<hook>.last`, up to RATE_LIMIT_KEYS live
 * `digest:ts` lines) suppresses repeats, so hooks never contend on it.
 */
export function logHookError(hook: string, msg: string, opts: HookLogOptions = {}): void {
  try {
    const root = resolveStateRoot();
    fs.mkdirSync(root, { recursive: true });
    const nowMs = opts.rateLimit?.nowMs ?? Date.now();
    if (opts.rateLimit) {
      const marker = path.join(root, `hook-errors.${hook}.last`);
      const digest = createHash('sha256').update(opts.rateLimit.key).digest('hex').slice(0, 16);
      const live: string[] = [];
      try {
        for (const line of fs.readFileSync(marker, 'utf8').split('\n')) {
          const [d, ts] = line.trim().split(':');
          if (!d || !ts || nowMs - Number(ts) >= LOG_RATE_LIMIT_MS) continue;
          if (d === digest) return;
          live.push(line.trim());
        }
      } catch { /* no marker yet */ }
      live.push(`${digest}:${nowMs}`);
      fs.writeFileSync(marker, `${live.slice(-RATE_LIMIT_KEYS).join('\n')}\n`, { mode: 0o600 });
    }
    const log = path.join(root, 'hook-errors.log');
    fs.appendFileSync(log, `${new Date(nowMs).toISOString()} ${hook}: ${msg}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(log, 0o600); } catch { /* not ours to tighten */ } }
  } catch {
    // best-effort; never block the session because logging failed
  }
}
