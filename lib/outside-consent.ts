/**
 * outside-consent — the one TS reader of the outside-review consent switch
 * (`codex_reviews`) for every binary that sends repository content to an
 * outside model: bin/gstack-claude-code, bin/gstack-outside-voice and the
 * unattended runner (lib/autoplan-run.ts). Its bash twin is
 * `gstack-config get --stored codex_reviews`, which gstack-codex-probe's
 * run-with-timeout reads; test/outside-consent.test.ts keeps the two equal.
 *
 * Stored value, most restrictive across the merged state roots:
 *   enabled | unset (the default, enabled)  → allowed
 *   disabled                                 → refused, consent_missing
 *   unreadable config or an unknown value    → refused, consent_missing
 * A review the user asked for by name (/codex, /claude-code) passes
 * `userInvoked` and is allowed regardless.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gateOutcomeLine } from './gate-outcomes';
import { mergedStateRoots, type StateRootEnv } from './state-root';

export type StoredCodexReviews =
  | { value: 'enabled' | 'disabled' | 'unset' }
  | { value: 'unreadable'; detail: string };

/** Marker line the skill blocks match to report `OUTSIDE_STATUS: not_run reason=consent_missing`. */
export const CONSENT_MARKER = 'OUTSIDE_CONSENT: consent_missing';

export function readStoredCodexReviews(env: StateRootEnv = process.env): StoredCodexReviews {
  let best: 'enabled' | 'disabled' | 'unset' = 'unset';
  for (const root of mergedStateRoots(env)) {
    const file = path.join(root, 'config.yaml');
    if (!fs.existsSync(file)) continue;
    let yaml: string;
    try {
      yaml = fs.readFileSync(file, 'utf8');
    } catch (error) {
      return { value: 'unreadable', detail: `cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
    }
    let value = '';
    for (const line of yaml.split('\n')) if (line.startsWith('codex_reviews:')) value = line.slice('codex_reviews:'.length).trim();
    if (!value) continue;
    if (value === 'disabled') best = 'disabled';
    else if (value === 'enabled') { if (best === 'unset') best = 'enabled'; }
    else return { value: 'unreadable', detail: `${file} sets codex_reviews to '${value}', which is neither enabled nor disabled` };
  }
  return { value: best };
}

export type OutsideConsent = { allowed: true; source: 'user-invoked' | 'enabled' | 'unset' } | { allowed: false; lines: string[] };

export function outsideConsent(opts: { userInvoked: boolean; env?: StateRootEnv }): OutsideConsent {
  if (opts.userInvoked) return { allowed: true, source: 'user-invoked' };
  const stored = readStoredCodexReviews(opts.env);
  if (stored.value === 'enabled' || stored.value === 'unset') return { allowed: true, source: stored.value };
  const detail = stored.value === 'unreadable' ? stored.detail : 'codex_reviews=disabled';
  return { allowed: false, lines: [gateOutcomeLine('outside review', 'consent_missing', detail), CONSENT_MARKER] };
}
