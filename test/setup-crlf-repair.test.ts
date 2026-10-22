/**
 * setup's CRLF repair (#3110).
 *
 * Git for Windows checks out with core.autocrlf=true, so a script with no
 * `eol` rule was written with CRLF. Adding the rule later does not fix the
 * copy: git never rewrites a stat-clean file whose blob did not change. The
 * fixture makes that state with a real autocrlf=true clone, adds the rule
 * upstream, pulls, and runs setup's _repair_crlf_checkout under the real
 * install-registry lock. The repaired hook must have LF bytes and run under
 * bash; a locally edited CRLF file is named in a warning and left alone.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const HOOK_SHIM = fs.readFileSync(path.join(ROOT, 'autoplan', 'bin', 'phase-publication-hook'), 'utf-8');
const HOOK_REL = 'autoplan/bin/phase-publication-hook';
const EDITED_REL = 'autoplan/bin/edited-hook';

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

let tmp: string;
let upstream: string;
let clone: string;
let stateRoot: string;
let env: Record<string, string | undefined>;

function run(cmd: string, args: string[], cwd: string, input?: string) {
  return spawnSync(cmd, args, { cwd, env, input, encoding: 'utf-8', timeout: 30_000 });
}

function git(cwd: string, ...args: string[]): string {
  const r = run('git', args, cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function write(dir: string, rel: string, body: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body, { mode });
}

function repair() {
  return run('bash', ['-c', [
    'set -e',
    'QUIET=0',
    'log() { [ "$QUIET" -eq 0 ] && echo "$@" || true; }',
    `SOURCE_GSTACK_DIR=${JSON.stringify(clone)}`,
    `GSTACK_STATE_ROOT=${JSON.stringify(stateRoot)}`,
    `. ${JSON.stringify(path.join(ROOT, 'bin', 'gstack-install-registry.sh'))}`,
    extractFn('_repair_crlf_checkout'),
    '_repair_crlf_checkout',
  ].join('\n')], clone);
}

function runHook() {
  return run('bash', [path.join(clone, HOOK_REL)], clone, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-crlf-'));
  upstream = path.join(tmp, 'upstream');
  clone = path.join(tmp, 'clone');
  stateRoot = path.join(tmp, 'state');
  const gitconfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n');
  env = {
    ...process.env,
    HOME: tmp,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  fs.mkdirSync(upstream);
  git(upstream, 'init', '-q');
  write(upstream, '.gitattributes', '.gitattributes text eol=lf\n*.ts text eol=lf\n');
  write(upstream, HOOK_REL, HOOK_SHIM, 0o755);
  write(upstream, `${HOOK_REL}.ts`, "process.stdout.write('{}');\n");
  write(upstream, EDITED_REL, '#!/usr/bin/env bash\nset -euo pipefail\necho upstream\n', 0o755);
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '-qm', 'old release: no eol rule for nested bin/');

  git(tmp, 'clone', '-q', '-c', 'core.autocrlf=true', upstream, clone);

  write(upstream, '.gitattributes', '.gitattributes text eol=lf\n*.ts text eol=lf\n**/bin/* text eol=lf\n');
  git(upstream, 'commit', '-qam', 'new release: nested bin/ is LF');
  git(clone, 'pull', '-q', '--ff-only');

  const edited = path.join(clone, EDITED_REL);
  fs.writeFileSync(edited, fs.readFileSync(edited, 'utf-8') + 'echo local edit\r\n');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('setup CRLF repair (#3110)', () => {
  test('fixture precondition: the pulled rule left the CRLF copy, and Linux bash cannot run it', () => {
    expect(fs.readFileSync(path.join(clone, HOOK_REL), 'utf-8')).toContain('\r\n');
    expect(git(clone, 'check-attr', 'eol', '--', HOOK_REL)).toContain('eol: lf');
    expect(git(clone, 'status', '--porcelain', '--untracked-files=no')).toBe(` M ${EDITED_REL}\n`);
    const r = runHook();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('pipefail');
  });

  test('rewrites the unmodified file as LF, keeps the edited one, and the hook runs', () => {
    const r = repair();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Rewrote 1 file(s)');

    const repaired = fs.readFileSync(path.join(clone, HOOK_REL));
    expect(repaired.includes('\r')).toBe(false);
    expect(repaired.toString('utf-8')).toBe(git(clone, 'show', `HEAD:${HOOK_REL}`));
    expect(fs.statSync(path.join(clone, HOOK_REL)).mode & 0o111).not.toBe(0);
    expect(git(clone, 'status', '--porcelain', '--untracked-files=no')).toBe(` M ${EDITED_REL}\n`);

    const edited = fs.readFileSync(path.join(clone, EDITED_REL), 'utf-8');
    expect(edited).toContain('echo local edit\r\n');
    expect(edited).toContain('\r\n');
    expect(r.stderr).toContain(EDITED_REL);
    expect(r.stderr).toContain(`cd ${clone} && git stash && git stash pop`);
    expect(r.stderr).toContain('docs/troubleshooting.md#setup-crlf-repair');
    expect(fs.existsSync(path.join(stateRoot, 'installs.tsv.lock'))).toBe(false);

    const hook = runHook();
    expect(hook.stderr).toBe('');
    expect(hook.status).toBe(0);
    expect(hook.stdout.trim()).toBe('{}');
  });

  test('a second run rewrites nothing', () => {
    const r = repair();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Rewrote');
    expect(r.stderr).toContain(EDITED_REL);
  });

  test('the printed fix rewrites the edited file as LF and keeps the edit', () => {
    git(clone, 'stash', '-q');
    git(clone, 'stash', 'pop', '-q');
    const edited = fs.readFileSync(path.join(clone, EDITED_REL), 'utf-8');
    expect(edited.includes('\r')).toBe(false);
    expect(edited).toContain('echo local edit\n');
    const r = repair();
    expect(r.stdout + r.stderr).toBe('');
  });
});
