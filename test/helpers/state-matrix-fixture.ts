/**
 * The #6792-shaped state-machine fixture (field list 2, W3): a take-proposal
 * store whose PR adds `takes_deactivate` and `takes_replace` kinds and lets a
 * deactivate or a same-claim replace fall through to the remove path, with
 * tests that cover only add, remove and a new-claim replace. Sources live as
 * `.txt` under test/fixtures/state-matrix-6792/{base,head} so the suite and the
 * type checker never pick them up. Every git spawn carries a timeout.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const STATE_MATRIX_FIXTURE = path.resolve(import.meta.dir, '..', 'fixtures', 'state-matrix-6792');
export const STATE_MACHINES_CHECKLIST = path.resolve(import.meta.dir, '..', '..', 'review', 'specialists', 'state-machines.md');

export interface StateMatrixRepo { root: string; work: string; git: (...args: string[]) => string }

function copyTree(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    if (entry.isDirectory()) { copyTree(src, path.join(to, entry.name)); continue; }
    const dest = path.join(to, entry.name.replace(/\.txt$/, ''));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** origin/main holds the base; branch `trust-guard` holds the #6792-shaped change, committed. */
export function makeStateMatrixRepo(prefix = 'state-matrix-'): StateMatrixRepo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const work = path.join(root, 'work');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(work, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8', timeout: 30_000, env });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  spawnSync('git', ['init', '-q', '--bare', origin], { timeout: 30_000, env });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'takes', private: true, scripts: { test: 'bun test' } }, null, 2) + '\n');
  copyTree(path.join(STATE_MATRIX_FIXTURE, 'base'), work);
  git('add', '-A');
  git('commit', '-qm', 'takes: add and remove proposals');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'trust-guard');
  copyTree(path.join(STATE_MATRIX_FIXTURE, 'head'), work);
  git('add', '-A');
  git('commit', '-qm', 'takes: trust guard — every take change is a proposal (deactivate, replace)');
  return { root, work, git };
}
