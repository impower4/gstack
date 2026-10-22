/**
 * autoplan-admission — who may run `gstack-autoplan`'s mutating verbs. The
 * decision is lib/install-verdict.ts `checkInstallAdmission` (the same one
 * `gstack-skill-start` makes): on a Capy host (GSTACK_CAPY=1) the install
 * verdict the Capy wrapper wrote must pass for this checkout, HEAD and
 * workflow; any unattended session also needs the PATH Bun (the one every
 * `#!/usr/bin/env bun` child runs) at gstack's supported minimum. GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 admits anyway and the
 * caller records the returned deviation. Interactive sessions, and other
 * hosts' ambient spawned sessions (a warning line), are not refused.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunError } from './autoplan-state';
import { checkInstallAdmission } from './install-verdict';

const ROOT = path.resolve(import.meta.dir, '..');

export interface Admission { lines: string[]; deviation?: string }

/**
 * A workflow lease on the shared installation (bin/gstack-lease): the upgrader
 * refuses UPGRADE_BUSY while a live lease it does not own exists, so a
 * session-start fast-forward cannot move the checkout under a running
 * autoplan driver. Fail-open: a missing or failing bin never blocks the run.
 */
export function touchInstallLease(env: NodeJS.ProcessEnv = process.env): void {
  const bin = path.join(ROOT, 'bin', 'gstack-lease');
  if (process.platform === 'win32' || !fs.existsSync(bin)) return;
  try { spawnSync(bin, ['touch', '--root', ROOT, '--from', String(process.ppid)], { encoding: 'utf8', timeout: 10_000, env, stdio: 'ignore' }); } catch { /* fail-open */ }
}

/** Throws RunError (exit 3) unless the session may write; an override or a warning returns the line to print. */
export function admit(env: NodeJS.ProcessEnv = process.env): Admission {
  const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 30_000, env }).stdout?.trim() || '0.0.0';
  const a = checkInstallAdmission({ skill: 'autoplan', gstackRoot: ROOT, env, bunVersion });
  if (a.overridden) return { lines: [`ADMISSION: override GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 (${a.detail})`], deviation: `GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1: admitted despite ${a.detail}` };
  if (a.refuse) throw new RunError(a.code ?? 'INSTALL_UNVERIFIED', a.detail, 3);
  return { lines: a.warn ? [a.line] : [] };
}
