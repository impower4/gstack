/**
 * bin/gstack-lease: the workflow lease on a shared gstack installation (field
 * wave residual R4). Eight Capy subagents share one checkout; each session
 * start touches `<git dir>/gstack-leases/<harness pid>` (install-scoped, like
 * gstack-upgrade.pending), and an updater refuses to move the checkout while
 * a lease whose pid is alive and not in its own ancestry exists. Pinned:
 * `touch` writes and prunes (older than 120 min), `live` lists live foreign
 * leases (exit 0) or nothing (exit 1), `list` shows every lease with its age
 * and alive|dead, and bin/gstack-skill-start touches the lease for the
 * harness pid it derives. Fixture: a throwaway git checkout, a sleeping child
 * process as the live pid, an exited process as the dead pid.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(import.meta.dir, '..');
const LEASE = path.join(REPO, 'bin/gstack-lease');
const START = path.join(REPO, 'bin/gstack-skill-start');
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function checkout() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-')));
  dirs.push(dir);
  const r = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return { dir, leases: path.join(dir, '.git/gstack-leases') };
}

// These cases assert the default lease location, <git dir>/gstack-leases of a
// temp checkout; the test preload's GSTACK_LEASE_DIR (which keeps every other
// suite out of this repo's .git) would override it, so strip it here.
const { GSTACK_LEASE_DIR: _preloadLeaseDir, ...baseEnv } = process.env as Record<string, string>;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [LEASE, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 30_000 });

/** A child that stays alive for the test: its pid is a live, foreign (non-ancestor) lease holder. */
function sleeper(): number {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(c);
  return c.pid!;
}

/** A pid that no longer exists: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync('true', [], { timeout: 30_000 });
  return r.pid!;
}

/** The same backend's identity for a different process start (what a reused pid shows). */
function otherStart(recorded: string): string {
  return recorded.startsWith('linux ') ? recorded.replace(/\d+$/, (n) => String(Number(n) + 1)) : 'ps Thu Jan  1 00:00:00 1970';
}

/** A BASH_ENV file whose functions shadow commands inside the lease script (fault injection). */
function bashEnv(dir: string, body: string): string {
  const file = path.join(dir, 'bash-env.sh');
  fs.writeFileSync(file, body);
  return file;
}

describe('gstack-lease', () => {
  test('bash -n passes and the bin is executable', () => {
    expect(fs.existsSync(LEASE), LEASE).toBe(true);
    expect(fs.statSync(LEASE).mode & 0o111).not.toBe(0);
    const r = spawnSync('bash', ['-n', LEASE], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
  });

  test('touch writes <git dir>/gstack-leases/<pid> for --pid and prunes leases older than 120 minutes', () => {
    const { dir, leases } = checkout();
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(path.join(leases, '99999991'), '');
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(path.join(leases, '99999991'), threeHoursAgo, threeHoursAgo);
    fs.writeFileSync(path.join(leases, '99999992'), '');
    const r = run(['touch', '--root', dir, '--pid', '4242']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases).sort()).toEqual(['4242', '99999992']);
  });

  test('live: a sleeping child is a live lease (exit 0, pid and age printed); a dead pid alone is none (exit 1)', () => {
    const { dir } = checkout();
    const dead = deadPid();
    expect(run(['touch', '--root', dir, '--pid', String(dead)]).status).toBe(0);
    const none = run(['live', '--root', dir]);
    expect(none.status, none.stdout + none.stderr).toBe(1);
    expect(none.stdout.trim()).toBe('');

    const live = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(live)]).status).toBe(0);
    const some = run(['live', '--root', dir]);
    expect(some.status, some.stdout + some.stderr).toBe(0);
    expect(some.stdout.trim().split('\n')).toEqual([expect.stringMatching(new RegExp(`^${live} \\d+m sleep$`))]);

    const list = run(['list', '--root', dir]);
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`^${live} \\d+m alive$`, 'm'));
    expect(list.stdout).toMatch(new RegExp(`^${dead} \\d+m dead$`, 'm'));
  });

  // GBRA-105 / GBRA-106: after a machine wake the recorded pid was dbus-daemon
  // and systemd-logind, and every upgrade refused with UPGRADE_BUSY.
  test('a reused pid is not a holder: a lease whose recorded start identity differs is reclaimed by live and listed stale', () => {
    const { dir, leases } = checkout();
    const reused = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(reused)]).status).toBe(0);
    const recorded = fs.readFileSync(path.join(leases, String(reused)), 'utf8').trim();
    expect(recorded).toMatch(/^(linux [0-9a-f-]+ \d+|ps .+)$/);
    fs.writeFileSync(path.join(leases, String(reused)), otherStart(recorded) + '\n');
    expect(run(['list', '--root', dir]).stdout).toMatch(new RegExp(`^${reused} \\d+m stale$`, 'm'));
    const live = run(['live', '--root', dir]);
    expect(live.status, live.stdout + live.stderr).toBe(1);
    expect(live.stdout.trim()).toBe('');
    expect(live.stderr).toMatch(new RegExp(`^gstack-lease: reclaimed stale lease ${reused} \\(\\d+m; recorded '.+', pid ${reused} is now sleep '.+'\\)$`, 'm'));
    expect(fs.existsSync(path.join(leases, String(reused)))).toBe(false);
  });

  test('missing evidence never reclaims a live lease: an unreadable current identity, a malformed record or another backend keeps it', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const file = path.join(leases, String(holder));
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const recorded = fs.readFileSync(file, 'utf8').trim();
    const blind = bashEnv(dir, 'cat() { case "$1" in /proc/*/stat) return 1 ;; esac; command cat "$@"; }\nps() { case "$*" in *lstart*) return 1 ;; esac; command ps "$@"; }\n');
    const unreadable = run(['live', '--root', dir], { BASH_ENV: blind });
    expect(unreadable.status, unreadable.stdout + unreadable.stderr).toBe(0);
    expect(unreadable.stderr).not.toContain('reclaimed');
    for (const record of ['linux not-a-boot-id 12', 'linux ' + '0'.repeat(36) + ' x1', recorded.startsWith('linux ') ? 'ps Thu Jan  1 00:00:00 1970' : 'linux ' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + ' 1']) {
      fs.writeFileSync(file, record + '\n');
      const r = run(['live', '--root', dir]);
      expect(r.status, record + ': ' + r.stderr).toBe(0);
      expect(fs.existsSync(file), record).toBe(true);
    }
  });

  test('the recorded identity does not depend on the caller\'s timezone or locale', () => {
    const { dir } = checkout();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(holder)], { TZ: 'UTC', LC_ALL: 'C' }).status).toBe(0);
    const r = run(['live', '--root', dir], { TZ: 'Pacific/Kiritimati', LC_ALL: 'C.UTF-8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reclaimed');
  });

  test('a renewal that lands between the stale verdict and the reclaim survives: reclaim rereads under the lock', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    const file = path.join(leases, String(holder));
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const fresh = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, otherStart(fresh.trim()) + '\n');
    const renewed = path.join(dir, 'renewed');
    fs.writeFileSync(renewed, fresh);
    // The holder renews just before reclaim takes the lock, as if touch ran after the stale verdict.
    const racing = bashEnv(dir, `ln() { case "$*" in *"/.lock") command cp "${renewed}" "${file}" ;; esac; command ln "$@"; }\n`);
    const r = run(['live', '--root', dir], { BASH_ENV: racing });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reclaimed');
    expect(fs.readFileSync(file, 'utf8')).toBe(fresh);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test('a lock whose holder died, or whose pid now belongs to another process, is broken at once', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    fs.mkdirSync(leases, { recursive: true });
    fs.symlinkSync(`${deadPid()} `, path.join(leases, '.lock'));
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, '.lock'))).toBe(false);
    const identity = fs.readFileSync(path.join(leases, String(holder)), 'utf8').trim();
    expect(identity).toMatch(/^(linux|ps) /);
    fs.symlinkSync(`${holder} ${otherStart(identity)}`, path.join(leases, '.lock'));
    const again = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, '.lock'))).toBe(false);
  });

  test('a live holder\'s lock is never broken, however old: touch exits 3 without writing and a reclaim keeps the lease', () => {
    const { dir, leases } = checkout();
    const owner = sleeper();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(owner)]).status).toBe(0);
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const ownerToken = `${owner} ${fs.readFileSync(path.join(leases, String(owner)), 'utf8').trim()}`;
    const lockPath = path.join(leases, '.lock');
    fs.symlinkSync(ownerToken, lockPath);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.lutimesSync(lockPath, old, old);
    const holderFile = path.join(leases, String(holder));
    const stale = otherStart(fs.readFileSync(holderFile, 'utf8').trim()) + '\n';
    fs.writeFileSync(holderFile, stale);
    const t = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(t.status, t.stdout + t.stderr).toBe(3);
    expect(t.stderr).toContain(`locked by live process ${owner}`);
    expect(fs.readFileSync(holderFile, 'utf8')).toBe(stale);
    const l = run(['live', '--root', dir], { GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(l.status, l.stdout + l.stderr).toBe(0);
    expect(l.stderr).not.toContain('reclaimed');
    expect(l.stdout).toContain(`${holder} `);
    expect(fs.existsSync(holderFile)).toBe(true);
    expect(fs.readlinkSync(lockPath)).toBe(ownerToken);
  });

  test('two breakers of one dead lock: the second rereads under .lock.break and leaves the lock the first one took', () => {
    const { dir, leases } = checkout();
    const owner = sleeper();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(owner)]).status).toBe(0);
    const ownerToken = `${owner} ${fs.readFileSync(path.join(leases, String(owner)), 'utf8').trim()}`;
    const lockPath = path.join(leases, '.lock');
    fs.symlinkSync(`${deadPid()} `, lockPath);
    // Between this breaker's dead verdict and its .lock.break, another breaker removes the dead lock and takes it.
    const first = bashEnv(dir, `ln() { case "$*" in *"/.lock.break") command rm -f "${lockPath}"; command ln -s "${ownerToken}" "${lockPath}" ;; esac; command ln "$@"; }\n`);
    const t = run(['touch', '--root', dir, '--pid', String(holder)], { BASH_ENV: first, GSTACK_LEASE_LOCK_TRIES: '3' });
    expect(t.status, t.stdout + t.stderr).toBe(3);
    expect(fs.readlinkSync(lockPath)).toBe(ownerToken);
    expect(fs.existsSync(path.join(leases, '.lock.break'))).toBe(false);
  });

  test('a .lock.break left by a dead breaker is cleared and the dead lock is still broken', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    fs.mkdirSync(leases, { recursive: true });
    fs.symlinkSync(`${deadPid()} `, path.join(leases, '.lock'));
    fs.symlinkSync(`${deadPid()} `, path.join(leases, '.lock.break'));
    const r = run(['touch', '--root', dir, '--pid', String(holder)], { GSTACK_LEASE_LOCK_TRIES: '5' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.existsSync(path.join(leases, String(holder)))).toBe(true);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  test('unlock removes only its own lock: a lock that changed hands during a reclaim stays', () => {
    const { dir, leases } = checkout();
    const owner = sleeper();
    const holder = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(owner)]).status).toBe(0);
    expect(run(['touch', '--root', dir, '--pid', String(holder)]).status).toBe(0);
    const ownerToken = `${owner} ${fs.readFileSync(path.join(leases, String(owner)), 'utf8').trim()}`;
    const holderFile = path.join(leases, String(holder));
    fs.writeFileSync(holderFile, otherStart(fs.readFileSync(holderFile, 'utf8').trim()) + '\n');
    const lockPath = path.join(leases, '.lock');
    // While reclaim deletes the stale lease under its lock, the lock changes hands.
    const swap = bashEnv(dir, `rm() { if [ "$*" = "-f ${holderFile}" ]; then command rm -f "${lockPath}"; command ln -s "${ownerToken}" "${lockPath}"; fi; command rm "$@"; }\n`);
    const r = run(['live', '--root', dir, '--exclude-ancestry-of', String(owner)], { BASH_ENV: swap });
    expect(r.stderr).toContain(`reclaimed stale lease ${holder}`);
    expect(fs.readlinkSync(lockPath)).toBe(ownerToken);
  });

  test('a lease without a recorded identity (older gstack) counts while fresh and is stale past the 120-minute window', () => {
    const { dir, leases } = checkout();
    const holder = sleeper();
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(path.join(leases, String(holder)), '');
    expect(run(['live', '--root', dir]).status).toBe(0);
    const old = new Date(Date.now() - 130 * 60_000);
    fs.utimesSync(path.join(leases, String(holder)), old, old);
    const r = run(['live', '--root', dir]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain(`reclaimed stale lease ${holder}`);
  });

  test('live --exclude-ancestry-of <pid> drops a lease held by that pid or one of its ancestors (this test process)', () => {
    const { dir } = checkout();
    expect(run(['touch', '--root', dir, '--pid', String(process.pid)]).status).toBe(0);
    const unfiltered = run(['live', '--root', dir]);
    expect(unfiltered.status, unfiltered.stdout + unfiltered.stderr).toBe(0);
    expect(unfiltered.stdout).toMatch(new RegExp(`^${process.pid} \\d+m \\S+$`, 'm'));
    // $$ inside the bin is a child of this bun process, so our own lease is ancestry.
    const own = spawnSync('bash', ['-c', `"$LEASE" live --root "$ROOT" --exclude-ancestry-of $$`], {
      encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir }, timeout: 30_000,
    });
    expect(own.status, own.stdout + own.stderr).toBe(1);
    expect(own.stdout.trim()).toBe('');
    const foreign = sleeper();
    expect(run(['touch', '--root', dir, '--pid', String(foreign)]).status).toBe(0);
    const mixed = spawnSync('bash', ['-c', `"$LEASE" live --root "$ROOT" --exclude-ancestry-of $$`], {
      encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir }, timeout: 30_000,
    });
    expect(mixed.status).toBe(0);
    expect(mixed.stdout.trim().split('\n')).toEqual([expect.stringMatching(new RegExp(`^${foreign} \\d+m sleep$`))]);
  });

  test('touch without --pid uses the same harness pid gstack-skill-start derives (this process past the tool-call shell)', () => {
    const { dir, leases } = checkout();
    const r = spawnSync('bash', ['-c', `"$LEASE" touch --root "$ROOT"; true`], {
      encoding: 'utf8', env: { ...baseEnv, LEASE, ROOT: dir }, timeout: 30_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(fs.readdirSync(leases)).toEqual([String(process.pid)]);
  });

  test('a directory that is not a git checkout fails closed for the caller (exit 2) and writes nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-plain-'));
    dirs.push(dir);
    const r = run(['touch', '--root', dir, '--pid', '1']);
    expect(r.status).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(run(['live', '--root', dir]).status).toBe(2);
  });

  test('gstack-skill-start touches the lease for its --parent-pid (GSTACK_LEASE_DIR hermetic), fail-open', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-home-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-state-'));
    dirs.push(home, state);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\n');
    const leaseDir = path.join(state, 'leases');
    const lease = path.join(leaseDir, '424243');
    try {
      const r = spawnSync(START, ['--skill', 'testskill', '--parent-pid', '424243'], {
        encoding: 'utf8', cwd: home, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_LEASE_DIR: leaseDir }, timeout: 30_000,
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(fs.existsSync(path.join(state, 'sessions', '424243'))).toBe(true);
      expect(fs.existsSync(lease), lease).toBe(true);
    } finally {
      fs.rmSync(lease, { force: true });
    }
  });

  test('gstack-skill-start reports a lease the held lock kept from being written, and still starts', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-home-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-lease-state-'));
    dirs.push(home, state);
    fs.writeFileSync(path.join(state, 'config.yaml'), 'update_check: false\n');
    const leaseDir = path.join(state, 'leases');
    fs.mkdirSync(leaseDir);
    fs.symlinkSync(`${sleeper()} `, path.join(leaseDir, '.lock'));
    const r = spawnSync(START, ['--skill', 'testskill', '--parent-pid', '424244'], {
      encoding: 'utf8', cwd: home, env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_LEASE_DIR: leaseDir, GSTACK_LEASE_LOCK_TRIES: '2' }, timeout: 30_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain('this session holds no workflow lease');
    expect(fs.existsSync(path.join(leaseDir, '424244'))).toBe(false);
  });
});
