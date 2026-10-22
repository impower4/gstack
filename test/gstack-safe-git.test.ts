/**
 * bin/gstack-safe-git: the only Git entry point /deslop-shared-libs allows.
 * A fake `git` first on PATH records the exact argv and environment the real
 * script sends, then delegates to the real Git so hostile repository config
 * proves which forms can and cannot execute project-controlled programs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dir, '..', 'bin', 'gstack-safe-git');
const REAL_GIT = Bun.which('git') || 'git';
const NODE = Bun.which('node') || process.execPath;
const PREFIX = ['--no-pager', '--no-lazy-fetch', '--no-replace-objects',
  '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'diff.submodule=short'];
const RECORDED_ENV = ['GIT_OPTIONAL_LOCKS', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT',
  'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];

let root = '', repo = '', trace = '', marker = '', base = '', head = '';
let env: Record<string, string> = {};

const git = (...args: string[]) => {
  const result = spawnSync(REAL_GIT, args, { cwd: repo, encoding: 'utf8', timeout: 10_000, env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const safeGit = (args: string[], extraEnv: Record<string, string> = {}, cwd = repo) =>
  spawnSync(SCRIPT, args, { cwd, encoding: 'utf8', timeout: 10_000, env: { ...env, ...extraEnv } });
const recorded = (): Array<{ args: string[]; env: Record<string, string> }> =>
  fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const hooks = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
const reset = () => { fs.rmSync(trace, { force: true }); fs.rmSync(marker, { force: true }); };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-safe-git-'));
  repo = path.join(root, 'repo');
  trace = path.join(root, 'git-calls.jsonl');
  marker = path.join(root, 'hooks.log');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  env = { ...process.env as Record<string, string>, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
  for (const key of RECORDED_ENV) delete env[key];
  // This Git may predate --no-lazy-fetch (2.44); the recorded argv is still exactly what the script sent.
  const lazyFlag = spawnSync(REAL_GIT, ['--no-lazy-fetch', '--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
  fs.writeFileSync(path.join(bin, 'git'), `#!${NODE}
const fs = require('node:fs'), cp = require('node:child_process');
const args = process.argv.slice(2);
const env = Object.fromEntries(${JSON.stringify(RECORDED_ENV)}.filter(k => k in process.env).map(k => [k, process.env[k]]));
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, env }) + '\\n');
if (process.env.FAKE_GIT_EXIT) { process.stderr.write('unknown option: --no-lazy-fetch\\n'); process.exit(Number(process.env.FAKE_GIT_EXIT)); }
const forwarded = ${lazyFlag} ? args : args.filter(arg => arg !== '--no-lazy-fetch');
const result = cp.spawnSync(${JSON.stringify(REAL_GIT)}, forwarded, { stdio: 'inherit', timeout: 10_000 });
process.exit(result.status ?? 1);
`, { mode: 0o755 });

  git('init', '-b', 'main');
  git('config', 'user.name', 'Safe Git Fixture');
  git('config', 'user.email', 'safe-git@example.invalid');
  git('remote', 'add', 'origin', 'https://example.invalid/fixture.git');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'tracked.txt filter=probe diff=probe\n');
  git('add', '.');
  git('commit', '-m', 'base');
  base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello world\n');
  git('commit', '-am', 'change');
  // A signature header makes plain log reads consult the configured verifier.
  const signed = git('cat-file', 'commit', 'HEAD').replace('\n\n',
    '\ngpgsig -----BEGIN PGP SIGNATURE-----\n dummy\n -----END PGP SIGNATURE-----\n\n') + '\n';
  const written = spawnSync(REAL_GIT, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    { cwd: repo, input: signed, encoding: 'utf8', timeout: 10_000, env });
  head = written.stdout.trim();
  git('update-ref', 'HEAD', head);
  const hook = (name: string, body: string) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> '${marker}'\n${body}\n`, { mode: 0o755 });
    return file;
  };
  git('config', 'filter.probe.clean', hook('clean-hook', 'cat'));
  git('config', 'diff.probe.textconv', hook('textconv-hook', 'cat "$1"'));
  git('config', 'diff.external', hook('external-diff-hook', 'exit 0'));
  git('config', 'core.fsmonitor', hook('fsmonitor-hook', 'exit 1'));
  git('config', 'gpg.program', hook('gpg-hook', 'exit 1'));
  git('config', 'log.showSignature', 'true');
  // A raw worktree edit: any index refresh or worktree diff would run the clean filter.
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello raw overlay\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
});

afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('gstack-safe-git', () => {
  test('the hostile config is live: equivalent raw Git reads execute every canary', () => {
    reset();
    for (const args of [['diff', base, head], ['log', '-1'], ['status'], ['diff', '--no-ext-diff', base, head],
      ['hash-object', '--path', 'tracked.txt', 'tracked.txt']]) {
      spawnSync(REAL_GIT, args, { cwd: repo, encoding: 'utf8', timeout: 10_000, env });
    }
    for (const name of ['external-diff-hook', 'gpg-hook', 'fsmonitor-hook', 'clean-hook', 'textconv-hook']) {
      expect(hooks()).toContain(name);
    }
  });

  test('always applies the fixed prefix and environment, and strips caller config overrides', () => {
    reset();
    const result = safeGit(['rev-parse', '--is-inside-work-tree'], {
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/bin/false'", GIT_CONFIG_COUNT: '1',
      GIT_EXTERNAL_DIFF: path.join(root, 'external-diff-hook'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('true');
    expect(recorded()).toEqual([{ args: [...PREFIX, 'rev-parse', '--is-inside-work-tree'],
      env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } }]);
  });

  const permitted = (): Array<[string[], string[]]> => [
    [['rev-parse', 'HEAD'], ['rev-parse', 'HEAD']],
    [['symbolic-ref', '--short', 'HEAD'], ['symbolic-ref', '--short', 'HEAD']],
    [['branch', '--show-current'], ['branch', '--show-current']],
    [['remote', '-v'], ['remote', '-v']],
    [['remote', 'get-url', 'origin'], ['remote', 'get-url', 'origin']],
    [['config', '--get', 'remote.origin.url'], ['config', '--get', 'remote.origin.url']],
    [['log', '-p', '--format=%H %s', '-2'], ['log', '--no-ext-diff', '--no-textconv', '-p', '--format=%H %s', '-2']],
    [['show', head], ['show', '--no-ext-diff', '--no-textconv', head]],
    [['show', `${head}:tracked.txt`], ['show', '--no-ext-diff', '--no-textconv', `${head}:tracked.txt`]],
    [['ls-tree', '-r', head], ['ls-tree', '-r', head]],
    [['cat-file', '-p', head], ['cat-file', '-p', head]],
    [['rev-list', '--count', head], ['rev-list', '--count', head]],
    [['merge-base', base, head], ['merge-base', base, head]],
    [['for-each-ref', '--format=%(refname)'], ['for-each-ref', '--format=%(refname)']],
    [['show-ref'], ['show-ref']],
    [['grep', '-n', 'hello', head, '--', 'tracked.txt'], ['grep', '-n', 'hello', head, '--', 'tracked.txt']],
    [['diff', base, head, '--', 'tracked.txt'], ['diff', '--no-ext-diff', '--no-textconv', base, head, '--', 'tracked.txt']],
    [['diff', '--stat', base.slice(0, 12), head], ['diff', '--no-ext-diff', '--no-textconv', '--stat', base.slice(0, 12), head]],
    [['ls-files', '--cached', '--others', '--exclude-standard', '-z'], ['ls-files', '--cached', '--others', '--exclude-standard', '-z']],
    [['ls-files', '--stage', '-z', '--', 'tracked.txt'], ['ls-files', '--stage', '-z', '--', 'tracked.txt']],
  ];

  test('forwards every permitted read with patch drivers disabled and runs no project program', () => {
    for (const [args, forwarded] of permitted()) {
      reset();
      const result = safeGit(args);
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
      expect(recorded().map(row => row.args), args.join(' ')).toEqual([[...PREFIX, ...forwarded]]);
      expect(hooks(), args.join(' ')).toBe('');
    }
    reset();
    const overlay = safeGit(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    expect(overlay.stdout.split('\0').filter(Boolean).sort()).toEqual(['.gitattributes', 'tracked.txt', 'untracked.txt']);
    const patch = safeGit(['diff', base, head, '--', 'tracked.txt']);
    expect(patch.stdout).toContain('+hello world');
    expect(safeGit(['show', `${head}:tracked.txt`]).stdout).toBe('hello world\n');
    const fromOutside = safeGit(['-C', repo, 'rev-parse', 'HEAD'], {}, root);
    expect(fromOutside.stdout.trim()).toBe(head);
    expect(hooks()).toBe('');
  });

  const refused: Array<[string[], RegExp]> = [
    [[], /no subcommand/],
    [['status'], /'status' is not an allowlisted read/],
    [['add', 'tracked.txt'], /'add' is not an allowlisted read/],
    [['hash-object', '--path', 'tracked.txt', 'tracked.txt'], /'hash-object' is not an allowlisted read/],
    [['update-index', '--refresh'], /not an allowlisted read/],
    [['write-tree'], /not an allowlisted read/],
    [['fetch', 'origin'], /not an allowlisted read/],
    [['ls-remote', 'origin'], /not an allowlisted read/],
    [['checkout', 'main'], /not an allowlisted read/],
    [['blame', 'tracked.txt'], /not an allowlisted read/],
    [['-c', 'core.fsmonitor=/bin/true', 'log'], /global option '-c'/],
    [['--git-dir=.git', 'log'], /global option/],
    [['-C'], /-C needs a directory/],
    [['diff'], /exactly two explicit committed object IDs/],
    [['diff', 'HEAD~1', 'HEAD'], /'HEAD~1' is not an explicit object ID/],
    [['diff', '--cached', 'BASE', 'HEAD'], /compares the index/],
    [['diff', '--merge-base', 'BASE', 'HEAD'], /compares the index/],
    [['diff', 'BASE', 'tracked.txt'], /'tracked.txt' is not an explicit object ID/],
    [['diff', 'BASE', '--', 'tracked.txt'], /exactly two explicit committed object IDs/],
    [['diff', '--no-index', 'a', 'b'], /'--no-index'/],
    [['diff', '--ext-diff', 'BASE', 'HEAD'], /diff drivers or filters/],
    [['log', '--output=out.patch', '-p'], /writes files/],
    [['log', '-p', '--output', 'out.patch'], /writes files/],
    [['log', '--show-signature'], /signature verifier/],
    [['log', '--format=%G?'], /signature verifier/],
    [['for-each-ref', '--format=%(signature)'], /signature verifier/],
    [['show', '--textconv', 'HEAD:tracked.txt'], /diff drivers or filters/],
    [['cat-file', '--filters', 'HEAD:tracked.txt'], /diff drivers or filters/],
    [['cat-file', '--textconv', 'HEAD:tracked.txt'], /diff drivers or filters/],
    [['grep', '-Ocat', 'hello'], /launches a pager program/],
    [['grep', '--open-files-in-pager=cat', 'hello'], /launches a pager program/],
    [['grep', '--recurse-submodules', 'hello'], /reads outside/],
    [['ls-files', '--cached', '--others', '--exclude-standard'], /NUL-delimited with -z/],
    [['ls-files', '--modified', '-z'], /ls-files '--modified'/],
    [['ls-files', '-z', '--deleted'], /ls-files '--deleted'/],
    [['symbolic-ref', 'HEAD', 'refs/heads/other'], /exactly one ref/],
    [['symbolic-ref', '-d', 'HEAD'], /is not a read/],
    [['branch', 'other'], /branch --show-current/],
    [['remote', 'add', 'x', 'https://example.invalid/x.git'], /listing and get-url/],
    [['remote', 'show', 'origin'], /listing and get-url/],
    [['config', 'user.name', 'x'], /--get, --get-all and --get-regexp/],
    [['config', '--get', 'user.name', '--unset'], /config '--unset'/],
  ];

  test.each(refused)('refuses %j with one actionable line and never starts Git', (args, reason) => {
    reset();
    const concrete = args.map(arg => arg === 'BASE' ? base : arg === 'HEAD' && args[0] === 'diff' ? head : arg);
    const result = safeGit(concrete);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toMatch(/^gstack-safe-git: refused: /);
    expect(result.stderr).toMatch(reason);
    expect(result.stderr).toContain('; allowed: rev-parse');
    expect(result.stderr).toContain('diff <object-id> <object-id> [-- <path>...]');
    expect(result.stderr).toContain('ls-files --cached --others --exclude-standard -z');
    expect(recorded()).toEqual([]);
    expect(hooks()).toBe('');
  });

  test("passes Git's exit status and stderr through unchanged", () => {
    reset();
    const unsupported = safeGit(['rev-parse', '--is-inside-work-tree'], { FAKE_GIT_EXIT: '129' });
    expect(unsupported.status).toBe(129);
    expect(unsupported.stderr).toBe('unknown option: --no-lazy-fetch\n');
    const missing = safeGit(['rev-parse', '--verify', '--quiet', 'refs/heads/absent']);
    expect(missing.status).toBe(1);
    const badObject = safeGit(['cat-file', '-t', '0'.repeat(40)]);
    expect(badObject.status).toBe(128);
  });
});
