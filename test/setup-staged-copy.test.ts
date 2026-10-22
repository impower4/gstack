/**
 * Windows copy installs are staged (setup `_link_or_copy`, IS_WINDOWS=1): the
 * new copy is built beside the destination and swapped in only when complete,
 * and an interrupted swap is restored on the next run. Runs in the
 * windows-free-tests lane as well as on Linux and macOS.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupFixtures, makeFixture, put, ROOT } from './helpers/install-fixture';

afterEach(cleanupFixtures);

const SETUP_SRC = readFileSync(join(ROOT, 'setup'), 'utf8').replace(/\r\n/g, '\n');
const start = SETUP_SRC.indexOf('_link_or_copy() {');
const fn = SETUP_SRC.slice(start, SETUP_SRC.indexOf('\n}\n', start) + 2);
const bash = (script: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
const sh = (p: string) => p.replaceAll('\\', '/');

describe('Windows copy activation is staged (_link_or_copy)', () => {
  test('a failed copy keeps the previous copy in place', () => {
    const f = makeFixture();
    put(join(f.dir, 'src/SKILL.md'), 'new\n');
    put(join(f.dir, 'dst/SKILL.md'), 'old working copy\n');
    const r = bash(`IS_WINDOWS=1\n${fn}\ncp() { return 1; }\n_link_or_copy "${sh(f.dir)}/src" "${sh(f.dir)}/dst" || echo FAILED`);
    expect(r.stdout).toContain('FAILED');
    expect(readFileSync(join(f.dir, 'dst/SKILL.md'), 'utf8')).toBe('old working copy\n');
    expect(readdirSync(f.dir).filter(n => n.includes('gstack-new'))).toEqual([]);
  });

  test('a swap interrupted between the renames is restored on the next run', () => {
    const f = makeFixture();
    put(join(f.dir, 'dst.gstack-old.123/SKILL.md'), 'last working copy\n');
    put(join(f.dir, 'dst.gstack-new.123/partial'), 'x');
    const r = bash(`IS_WINDOWS=1\n${fn}\n_link_or_copy "${sh(f.dir)}/missing-src" "${sh(f.dir)}/dst"`);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(f.dir, 'dst/SKILL.md'), 'utf8')).toBe('last working copy\n');
    expect(readdirSync(f.dir).filter(n => n.includes('gstack-'))).toEqual([]);
  });

  test('a successful copy replaces the destination', () => {
    const f = makeFixture();
    put(join(f.dir, 'src/SKILL.md'), 'new\n');
    put(join(f.dir, 'dst/stale.md'), 'stale\n');
    const r = bash(`IS_WINDOWS=1\n${fn}\n_link_or_copy "${sh(f.dir)}/src" "${sh(f.dir)}/dst"`);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(f.dir, 'dst'))).toEqual(['SKILL.md']);
  });
});
