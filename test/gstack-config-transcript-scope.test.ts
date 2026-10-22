/**
 * bin/gstack-config writes: the transcript_repos allowlist and its +repos
 * marker change together in one locked rename, `unset` removes a key, and
 * every mutation goes through one mkdir lock with a read-modify-write rename,
 * so concurrent writers lose nothing and an interrupted write leaves the old
 * file.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CONFIG_BIN = join(import.meta.dir, '..', 'bin', 'gstack-config');
let root: string;
const env = () => ({ ...process.env, GSTACK_STATE_ROOT: root });
const cfg = (...args: string[]) => {
  const r = spawnSync('bash', [CONFIG_BIN, ...args], { encoding: 'utf-8', timeout: 30_000, env: env() });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const file = () => join(root, 'config.yaml');
const snapshot = () => (existsSync(file()) ? readFileSync(file(), 'utf-8') : null);
const keyLines = (key: string) => (snapshot() ?? '').split('\n').filter((l) => l.startsWith(`${key}:`));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gstack-config-scope-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('transcript_repos and the +repos marker', () => {
  test('setting the allowlist stores canonical remotes and marks the mode in the same write', () => {
    expect(cfg('set', 'transcript_ingest_mode', 'recent').status).toBe(0);
    expect(cfg('set', 'transcript_repos', 'https://github.com/Acme/App.git, git@github.com:acme/api.git,github.com/acme/app').status).toBe(0);
    expect(cfg('get', 'transcript_repos').out).toBe('github.com/acme/app,github.com/acme/api');
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('recent+repos');
  });

  test('a mode change keeps the marker while the allowlist exists; off never carries it', () => {
    cfg('set', 'transcript_repos', 'github.com/acme/app');
    expect(cfg('get', 'transcript_ingest_mode').status).toBe(0);
    expect(keyLines('transcript_ingest_mode')).toEqual([]);
    cfg('set', 'transcript_ingest_mode', 'all');
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('all+repos');
    cfg('set', 'transcript_ingest_mode', 'new@2026-10-03T17:00:00Z');
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('new@2026-10-03T17:00:00Z+repos');
    cfg('set', 'transcript_ingest_mode', 'off');
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('off');
    cfg('set', 'transcript_ingest_mode', 'recent+repos');
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('recent+repos');
  });

  test('unset transcript_repos drops the marker in the same write; unset of an absent key is a no-op', () => {
    cfg('set', 'transcript_ingest_mode', 'recent');
    cfg('set', 'transcript_repos', 'github.com/acme/app');
    expect(cfg('unset', 'transcript_repos').status).toBe(0);
    expect(cfg('has', 'transcript_repos').status).toBe(1);
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('recent');
    const before = snapshot();
    expect(cfg('unset', 'transcript_repos').status).toBe(0);
    expect(snapshot()).toBe(before);
    expect(cfg('unset', 'bad key!').status).toBe(1);
  });

  test('unset removes only the named key', () => {
    cfg('set', 'proactive', 'false');
    cfg('set', 'skill_prefix', 'true');
    expect(cfg('unset', 'proactive').status).toBe(0);
    expect(cfg('has', 'proactive').status).toBe(1);
    expect(cfg('get', 'skill_prefix').out).toBe('true');
  });

  test('a +repos value without an allowlist and an empty allowlist are rejected with the file unchanged', () => {
    cfg('set', 'transcript_ingest_mode', 'recent');
    const before = snapshot();
    const marked = cfg('set', 'transcript_ingest_mode', 'all+repos');
    expect(marked.status).toBe(1);
    expect(marked.err).toContain('Existing value left unchanged');
    for (const value of [' , ', ',']) {
      const r = cfg('set', 'transcript_repos', value);
      expect(r.status).toBe(1);
      expect(r.err).toContain('Existing value left unchanged');
      expect(r.err).toContain('gstack-config unset transcript_repos');
    }
    expect(snapshot()).toBe(before);
  });
});

describe('one lock and one rename for every mutation', () => {
  test('concurrent unrelated sets lose nothing', async () => {
    cfg('set', 'proactive', 'true');
    const keys = Array.from({ length: 12 }, (_, i) => `scope_test_key_${i}`);
    const codes = await Promise.all(
      keys.map(
        (key, i) =>
          new Promise<number | null>((resolve) => {
            const child = spawn('bash', [CONFIG_BIN, 'set', key, `value-${i}`], { env: env(), stdio: 'ignore' });
            child.on('exit', resolve);
          }),
      ),
    );
    expect(codes).toEqual(keys.map(() => 0));
    for (const [i, key] of keys.entries()) expect(keyLines(key)).toEqual([`${key}: value-${i}`]);
    expect(keyLines('proactive')).toEqual(['proactive: true']);
    expect(existsSync(join(root, '.config-yaml.lock'))).toBe(false);
  }, 60_000);

  test('an interrupted write leaves the old file, and the next writer takes over the dead lock', () => {
    cfg('set', 'transcript_ingest_mode', 'recent');
    cfg('set', 'transcript_repos', 'github.com/acme/app');
    const before = snapshot();
    // A mv that kills gstack-config right before the rename over config.yaml.
    const shim = join(root, 'shim');
    mkdirSync(shim);
    writeFileSync(join(shim, 'mv'), '#!/bin/sh\nfor last; do :; done\ncase "$last" in */config.yaml) kill -9 $PPID; exit 1 ;; esac\nexec /bin/mv "$@"\n');
    chmodSync(join(shim, 'mv'), 0o755);
    const crashed = spawnSync('bash', [CONFIG_BIN, 'unset', 'transcript_repos'], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...env(), PATH: `${shim}:${process.env.PATH}` },
    });
    expect(crashed.status).not.toBe(0);
    expect(snapshot()).toBe(before);
    expect(existsSync(join(root, '.config-yaml.lock'))).toBe(true);
    const t0 = Date.now();
    expect(cfg('unset', 'transcript_repos').status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(cfg('get', 'transcript_ingest_mode').out).toBe('recent');
  }, 60_000);

  test('a lock held longer than 10 s is stale even when its pid is alive', () => {
    mkdirSync(join(root, '.config-yaml.lock'));
    writeFileSync(join(root, '.config-yaml.lock', 'pid'), `${process.pid} ${Math.floor(Date.now() / 1000) - 20}\n`);
    expect(cfg('set', 'proactive', 'false').status).toBe(0);
    expect(cfg('get', 'proactive').out).toBe('false');
  });

  test('a live, fresh lock makes the writer wait instead of writing alongside it', async () => {
    mkdirSync(join(root, '.config-yaml.lock'));
    writeFileSync(join(root, '.config-yaml.lock', 'pid'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
    const child = spawn('bash', [CONFIG_BIN, 'set', 'proactive', 'false'], { env: env(), stdio: 'ignore' });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    await Bun.sleep(500);
    expect(snapshot()).toBeNull();
    rmSync(join(root, '.config-yaml.lock'), { recursive: true, force: true });
    expect(await exited).toBe(0);
    expect(keyLines('proactive')).toEqual(['proactive: false']);
  }, 30_000);

  test('the user-slug writer goes through the same lock', () => {
    const r = spawnSync('bash', [CONFIG_BIN, 'resolve-user-slug'], {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...env(), HOME: root, USER: 'scope-tester' },
    });
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(keyLines('user_slug_at_local')).toEqual([`user_slug_at_local: ${r.stdout}`]);
    expect(existsSync(join(root, '.config-yaml.lock'))).toBe(false);
  });
});
