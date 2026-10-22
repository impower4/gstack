/**
 * The free runner's git auto-maintenance backstop: every shard child gets
 * maintenance.auto=false and gc.auto=0 appended to its inherited GIT_CONFIG_*
 * pairs, so a fixture commit cannot leave a detached `git maintenance run`
 * creating and deleting .git/objects/maintenance.lock under a later listing,
 * watch or removal. Fixtures that build their own git env set the keys
 * themselves (docs/TESTING_INTERNALS.md#flake-ledger).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { disableGitAutoMaintenance, runFreeShard } from '../scripts/test-free-shards';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scratch = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'free-git-maintenance-')));
  roots.push(root);
  return root;
};
const gitConfigEnv = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG_')).sort());
const cleanGitEnv = (home: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'no-global-gitconfig'),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
});

/** The GIT_CONFIG_* entries the real runFreeShard child received. */
async function childGitConfig(env: NodeJS.ProcessEnv | undefined): Promise<NodeJS.ProcessEnv> {
  const out = path.join(scratch(), 'child-env.json');
  const probe = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_CONFIG_')))));`
    + `console.log('Ran 1 tests across 1 files. [1.00ms]');`;
  const outcome = await runFreeShard(['probe'], 1, 1, { env, quiet: true, log: () => {},
    commandFor: () => ({ command: process.execPath, args: ['-e', probe] }) });
  expect(outcome.status).toBe('passed');
  return gitConfigEnv(JSON.parse(fs.readFileSync(out, 'utf8')));
}

const OFF = { maintenance: ['maintenance.auto', 'false'], gc: ['gc.auto', '0'] } as const;
const appended = (start: number) => ({
  [`GIT_CONFIG_KEY_${start}`]: OFF.maintenance[0], [`GIT_CONFIG_VALUE_${start}`]: OFF.maintenance[1],
  [`GIT_CONFIG_KEY_${start + 1}`]: OFF.gc[0], [`GIT_CONFIG_VALUE_${start + 1}`]: OFF.gc[1],
});

describe('free runner: git auto-maintenance off for every shard child', () => {
  test('absent and zero inherited GIT_CONFIG_COUNT both start the pairs at index 0', async () => {
    const home = scratch();
    expect(await childGitConfig(cleanGitEnv(home))).toEqual(gitConfigEnv({ ...cleanGitEnv(home), GIT_CONFIG_COUNT: '2', ...appended(0) }));
    expect(await childGitConfig({ ...cleanGitEnv(home), GIT_CONFIG_COUNT: '0' }))
      .toEqual(gitConfigEnv({ ...cleanGitEnv(home), GIT_CONFIG_COUNT: '2', ...appended(0) }));
  });

  test('a nonzero inherited count keeps its pairs and appends after them', async () => {
    const env = { ...cleanGitEnv(scratch()), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture' };
    expect(await childGitConfig(env)).toEqual(gitConfigEnv({ ...env, GIT_CONFIG_COUNT: '3', ...appended(1) }));
  });

  test('an explicit options.env and the default process.env are both covered, and neither caller object changes', async () => {
    const env = { ...cleanGitEnv(scratch()), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false' };
    const envBefore = structuredClone(env);
    const processBefore = gitConfigEnv(process.env);
    await childGitConfig(env);
    expect(env).toEqual(envBefore);
    const inherited = Number(process.env.GIT_CONFIG_COUNT || '0');
    expect(await childGitConfig(undefined)).toEqual({ ...processBefore, GIT_CONFIG_COUNT: String(inherited + 2), ...appended(inherited) });
    expect(gitConfigEnv(process.env)).toEqual(processBefore);
  });

  test('a malformed inherited count is passed through untouched and git still rejects it', async () => {
    const env = { ...cleanGitEnv(scratch()), GIT_CONFIG_COUNT: 'abc', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Fixture' };
    const child = await childGitConfig(env);
    expect(child).toEqual(gitConfigEnv(env));
    const result = spawnSync('git', ['config', '--get', 'user.name'], { env: { ...env, ...child }, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain('GIT_CONFIG_COUNT');
  });

  test('a traced commit in the runner child env starts no git maintenance run; the default env does', async () => {
    const root = scratch();
    const base = cleanGitEnv(root);
    const traced = (env: NodeJS.ProcessEnv, name: string) => {
      const repo = path.join(root, name);
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: repo, env: { ...env, GIT_TRACE: '1' }, encoding: 'utf8', timeout: 10_000 });
        expect(result.status, result.stderr).toBe(0);
        return result.stderr;
      };
      fs.mkdirSync(repo);
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
      git('add', 'a.txt');
      return git('commit', '-qm', 'traced').split('\n').filter(line => /maintenance run|gc --auto/.test(line));
    };
    expect(traced(base, 'defaults').length, 'control: the default env must show the auto-maintenance child').toBeGreaterThan(0);
    const runnerEnv = { ...base, ...(await childGitConfig(base)) };
    expect(traced(runnerEnv, 'runner')).toEqual([]);
  });

  test('disableGitAutoMaintenance mutates only the env it is given', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: ' 2 ', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' };
    disableGitAutoMaintenance(env);
    expect(env).toEqual({ GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2', GIT_CONFIG_COUNT: '4', ...appended(2) });
  });
});
