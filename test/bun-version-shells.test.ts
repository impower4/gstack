import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkInstallAdmission } from '../lib/install-verdict';

// #3195: the Bun floor check is sourced from whatever shell runs it; under zsh
// it must still judge (no word splitting), and a version it cannot read holds
// the update with BUN_VERSION_UNREADABLE instead of reading as "not below".
// One version table drives bash, zsh, bash --posix and the TypeScript twin.

const ROOT = path.resolve(import.meta.dir, '..');
const VERSIONS = path.join(ROOT, 'bin', 'gstack-bun-version.sh');
const hasZsh = spawnSync('zsh', ['-c', 'true'], { timeout: 10_000 }).status === 0;
const SHELLS: Array<[string, string[]]> = [['bash', ['bash']], ['bash --posix', ['bash', '--posix']], ['zsh', ['zsh']]];
const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

/** Status against the floor 1.3.3 and the tested 1.4.2. */
const TABLE: Record<string, 'too-old' | 'untested' | 'ok' | 'malformed'> = {
  '1.3.2': 'too-old',
  '1.3.3-canary.1': 'too-old',
  '1.3.3': 'untested',
  '1.3.14': 'untested',
  '1.4.2': 'ok',
  '1.10.0': 'ok',
  '01.04.02': 'ok',
  '2.0.0': 'ok',
  garbage: 'malformed',
};

function run(shell: string[], script: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(shell[0]!, [...shell.slice(1), '-c', script, '_', VERSIONS, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env },
  });
}

/** A git checkout whose HEAD carries this release's bin/ and VERSION, plus a `bun` that prints `version`. */
function install(version: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-shells-')));
  bases.push(base);
  const repo = path.join(base, 'install'), stub = path.join(base, 'stub');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  fs.mkdirSync(stub);
  for (const f of ['gstack-bun-version.sh', 'gstack-sanitize-echo.sh']) if (fs.existsSync(path.join(ROOT, 'bin', f))) fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(repo, 'bin', f));
  fs.writeFileSync(path.join(repo, 'VERSION'), '9.9.9.9\n');
  const git = (...a: string[]) => expect(spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).status).toBe(0);
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'release');
  fs.writeFileSync(path.join(stub, 'bun'), `#!/bin/sh\nprintf '%s\\n' '${version.replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
  return { repo, env: { PATH: `${stub}:${process.env.PATH}` }, bun: path.join(stub, 'bun') };
}

describe.skipIf(process.platform === 'win32')('Bun floor check in every shell (#3195)', () => {
  for (const [label, shell] of SHELLS) {
    test.skipIf(label === 'zsh' && !hasZsh)(`${label}: gstack_bun_status judges the version table`, () => {
      const got = Object.fromEntries(Object.keys(TABLE).map(v => [v, run(shell, '. "$1"; gstack_bun_status "$2"', [v]).stdout.trim()]));
      expect(got).toEqual(TABLE);
    });
  }

  test.skipIf(!hasZsh)('zsh: Bun 1.3.2 is too old (the issue repro)', () => {
    const r = run(['zsh'], '. "$1"; gstack_bun_status 1.3.2');
    expect(r.stdout.trim()).toBe('too-old');
    expect(r.stderr).not.toContain('integer expression expected');
  });

  test('a floor the comparison cannot parse is malformed, never ok', () => {
    for (const [label, shell] of SHELLS) {
      if (label === 'zsh' && !hasZsh) continue;
      expect(run(shell, '. "$1"; gstack_bun_status 1.4.2 "$2"', ['1.x.3']).stdout.trim()).toBe('malformed');
    }
  });

  test('the TypeScript twin below() agrees with the same table', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-bun-twin-'));
    bases.push(base);
    const refused = (version: string, release: string) => {
      fs.mkdirSync(path.join(base, release, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(base, release, 'bin', 'gstack-bun-version.sh'), `GSTACK_BUN_TESTED="${release}"\n`);
      return checkInstallAdmission({ skill: 'review', gstackRoot: path.join(base, release), bunVersion: version,
        env: { GSTACK_SESSION_KIND: 'unattended' } }).status === 'runtime';
    };
    const got = Object.fromEntries(Object.keys(TABLE).map(v => [v,
      v === 'garbage' ? (refused(v, '1.3.3') ? 'malformed' : 'accepted')
        : refused(v, '1.3.3') ? 'too-old' : refused(v, '1.4.2') ? 'untested' : 'ok']));
    expect(got).toEqual(TABLE);
  });

  for (const [label, shell] of SHELLS) {
    test.skipIf(label === 'zsh' && !hasZsh)(`${label}: the incoming hold holds below the floor and on an unreadable version`, () => {
      const old = install('1.3.2');
      const held = run(shell, '. "$1"; gstack_bun_incoming_hold "$2" HEAD; echo "rc=$?"', [old.repo], old.env);
      expect(held.stdout).toContain(`bun-too-old: found Bun 1.3.2 at ${old.bun}; gstack 9.9.9.9 needs 1.3.3 or newer`);
      expect(held.stdout).toContain('rc=0');

      const bad = install("bun\x1b[2J\nstages=setup it's");
      const unreadable = run(shell, '. "$1"; gstack_bun_incoming_hold "$2" HEAD; echo "rc=$?"', [bad.repo], bad.env);
      expect(unreadable.stdout).toBe(`bun-version-unreadable: could not read the version of Bun at ${bad.bun} (bun --version printed 'bun[2J'); ` +
        'gstack 9.9.9.9 needs 1.3.3 or newer (BUN_VERSION_UNREADABLE)\nrc=0\n');

      const fine = install('1.4.2');
      expect(run(shell, '. "$1"; gstack_bun_incoming_hold "$2" HEAD; echo "rc=$?"', [fine.repo], fine.env).stdout).toBe('rc=1\n');
    });
  }

  test('/gstack-upgrade Step 4 runs the floor check through bash, whatever the tool shell is', () => {
    const tmpl = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf8');
    expect(tmpl).toContain(`HOLD=$(bash -c '. bin/gstack-bun-version.sh && gstack_bun_incoming_hold . origin/main' 2>/dev/null)`);
    expect(tmpl).not.toMatch(/HOLD=\$\(\. bin\/gstack-bun-version\.sh/);
    expect(tmpl).toContain('BUN_VERSION_UNREADABLE');
  });
});
