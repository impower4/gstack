/**
 * bin/gstack-upgrade under Git Bash: `pwd -P` spells the checkout /c/x while
 * Git for Windows answers `rev-parse --show-toplevel` as C:/x. The checkout
 * check compares the paths through bin/gstack-path-spelling.sh, so a real
 * checkout is accepted and a directory that is not its own toplevel is still
 * refused. A uname/cygpath/git shim stands in for MSYS on Linux and macOS.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { capyHost, type CapyHost } from './helpers/capy-host';

const REPO = path.resolve(import.meta.dir, '..');
const DEPS = [
  'bin/gstack-upgrade', 'bin/gstack-path-spelling.sh', 'bin/gstack-bun-version.sh', 'bin/gstack-paths', 'bin/gstack-state-root.sh',
  'bin/gstack-egress-lib.sh', 'bin/gstack-egress-receipt', 'lib/egress-receipt.ts', 'lib/state-root.ts',
  'bin/gstack-lease', 'bin/gstack-harness-pid.sh', 'bin/gstack-install-verdict.sh',
];
const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim();
const hosts: CapyHost[] = [];
afterEach(() => { for (const h of hosts.splice(0)) h.cleanup(); });

const write = (file: string, text: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

/** PATH entries that make this host look like Git Bash: MINGW uname, a cygpath mapping /x to C:/msys64/x, and a git whose --show-toplevel answers the native spelling. */
function msysShim(base: string, realPath: string): string {
  const shim = path.join(base, 'msys-shim');
  write(path.join(shim, 'uname'), '#!/usr/bin/env bash\necho MINGW64_NT-10.0\n', 0o755);
  write(path.join(shim, 'cygpath'), [
    '#!/usr/bin/env bash',
    '[ "$1" = -am ] || exit 1',
    'case "$2" in',
    '  [A-Za-z]:*) printf "%s\\n" "$2" ;;',
    '  /*) printf "C:/msys64%s\\n" "$2" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n', 0o755);
  write(path.join(shim, 'git'), [
    '#!/usr/bin/env bash',
    `export PATH='${realPath}'`,
    'case " $* " in',
    `  *" rev-parse --show-toplevel "*) out=$('${REAL_GIT}' "$@") || exit $?; printf 'C:/msys64%s\\n' "$out" ;;`,
    `  *) exec '${REAL_GIT}' "$@" ;;`,
    'esac',
  ].join('\n') + '\n', 0o755);
  return shim;
}

/** A bare remote at 1.0.1 and a clone at 1.0.0 whose gstack checkout lives at `<clone>/<sub>`. */
function fixture(sub = '') {
  const host = capyHost({ systemBun: '1.4.2' });
  hosts.push(host);
  const git = (args: string[], cwd: string) => {
    const r = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: host.env, timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const seed = path.join(host.base, 'seed');
  const bare = path.join(host.base, 'remote.git');
  fs.mkdirSync(seed, { recursive: true });
  git(['init', '-q', '-b', 'main'], seed);
  for (const rel of DEPS) {
    fs.mkdirSync(path.dirname(path.join(seed, sub, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(seed, sub, rel));
    fs.chmodSync(path.join(seed, sub, rel), fs.statSync(path.join(REPO, rel)).mode);
  }
  write(path.join(seed, sub, 'VERSION'), '1.0.0\n');
  write(path.join(seed, sub, 'setup'), '#!/usr/bin/env bash\nexit 0\n', 0o755);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'A'], seed);
  git(['init', '-q', '--bare', '-b', 'main', bare], host.base);
  git(['push', '-q', bare, 'main'], seed);
  const clone = path.join(host.base, 'gstack');
  git(['clone', '-q', '--single-branch', `file://${bare}`, clone], host.base);
  write(path.join(seed, sub, 'VERSION'), '1.0.1\n');
  git(['commit', '-qam', 'B'], seed);
  git(['push', '-q', bare, 'main'], seed);
  const env = { ...host.env, PATH: `${msysShim(host.base, host.env.PATH)}${path.delimiter}${host.env.PATH}` };
  const check = () => spawnSync('bash', [path.join(clone, sub, 'bin/gstack-upgrade'), '--check'], { cwd: host.home, encoding: 'utf8', env, timeout: 60_000 });
  return { check, head: () => git(['rev-parse', 'HEAD'], clone) };
}

describe('gstack-upgrade under Git Bash path spellings', () => {
  test.skipIf(process.platform === 'win32')('a checkout whose toplevel git spells C:/… is accepted and reports behind', () => {
    const f = fixture();
    const before = f.head();
    const r = f.check();
    expect(r.stderr).not.toContain('UPGRADE_REFUSED');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('gstack-upgrade: behind 1.0.0 -> 1.0.1 (1 commits)');
    expect(f.head()).toBe(before);
  });

  test.skipIf(process.platform === 'win32')('a gstack tree nested inside another repository is still not a checkout', () => {
    const f = fixture('vendor/gstack');
    const r = f.check();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('is not a gstack checkout');
    expect(r.stderr).toContain('(UPGRADE_REFUSED)');
  });
});
