/**
 * autoplan-migrate — forward migrations a run directory gets when a newer
 * gstack opens it (plan B1a amendment). Called under the run lock before
 * every mutating verb: `run.json.gstack_version` older than this gstack (or
 * absent, a run written before 1.91.96) prints GSTACK_VERSION_CHANGED once
 * and journals `gstack_version_changed`; a run written by a newer gstack
 * refuses. Decision ids minted before 1.91.95 (`<run>-<label>` at gate_rev > 1,
 * which collide with gate_rev 1) are rewritten through `decisionId` once,
 * journaled as `decision_ids_migrated`. Safe: such runs never validated and
 * `gstack-artifact ack` refuses invalid runs, so no consumer holds the old ids.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decisionId } from './gate-list';
import { resolveSourceRoot } from './source-root';
import { RunError, journal, readDecisions, writeDecisions, type RunState } from './autoplan-state';

function readVersion(): string {
  for (const root of [path.join(import.meta.dir, '..'), resolveSourceRoot(path.join(import.meta.dir, '..'))]) {
    try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); } catch { /* try the recorded source checkout */ }
  }
  return 'unknown';
}
export const GSTACK_VERSION = readVersion();

/** Numeric compare of dotted versions (1.91.95.0); missing parts are 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Rewrite `<run>-<label>` ids at gate_rev > 1 to `<run>-r<rev>-<label>`; returns how many rows changed. Idempotent. */
export function migrateLegacyDecisionIds(state: RunState): number {
  const rows = readDecisions(state.out);
  let n = 0;
  const next = rows.map(row => {
    if (row.gate_rev <= 1 || !row.label || row.id !== `${state.run}-${row.label.toLowerCase()}`) return row;
    n++;
    return { ...row, id: decisionId(state.run, row.gate_rev, row.label.toLowerCase()) };
  });
  if (!n) return 0;
  writeDecisions(state.out, next);
  journal(state.out, { event: 'decision_ids_migrated', n });
  (state.deviations ??= []).push(`legacy decision ids rewritten (${n})`);
  return n;
}

/** Bring a run directory forward to this gstack; returns the notice lines and whether run.json must be written. */
export function migrateRun(state: RunState): { lines: string[]; changed: boolean } {
  const from = state.gstack_version;
  if (from && compareVersions(from, GSTACK_VERSION) > 0) {
    throw new RunError('GSTACK_VERSION_CHANGED', `run ${state.run} was written by gstack ${from}; this is ${GSTACK_VERSION}, which cannot read newer state`, 3);
  }
  const lines: string[] = [];
  const migrated = migrateLegacyDecisionIds(state);
  if (from === GSTACK_VERSION) return { lines, changed: migrated > 0 };
  const migrations = migrated ? [`decision ids rewritten (${migrated})`] : [];
  journal(state.out, { event: 'gstack_version_changed', from: from ?? null, to: GSTACK_VERSION, migrations });
  lines.push(`GSTACK_VERSION_CHANGED: run ${from ?? 'unknown'} -> ${GSTACK_VERSION}; forward migrations: ${migrations.length ? migrations.join(', ') : 'none needed'}`);
  state.gstack_version = GSTACK_VERSION;
  return { lines, changed: true };
}
