/**
 * bin/gstack-design-claim publishes a staged paid image without overwriting.
 * One table drives both claim implementations (the sh helper and $D's
 * claimOutputPath) so their suffix and cap rules cannot drift apart.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimOutputPath } from '../design/src/persist';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-design-claim');

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-claim-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function stage(content = 'paid bytes'): string {
  const staged = path.join(fs.mkdtempSync(path.join(dir, 'stage-')), 'variant.png');
  fs.writeFileSync(staged, content);
  return staged;
}

function claimSh(src: string, dest: string) {
  return spawnSync('sh', [BIN, src, dest], { encoding: 'utf8', timeout: 30_000 });
}

const TABLE: Array<{ name: string; existing: string[]; requested: string; expected: string }> = [
  { name: 'free name', existing: [], requested: 'variant-A.png', expected: 'variant-A.png' },
  { name: 'first bump', existing: ['variant-A.png'], requested: 'variant-A.png', expected: 'variant-A-2.png' },
  { name: 'gap is not reused out of order', existing: ['variant-A.png', 'variant-A-2.png'], requested: 'variant-A.png', expected: 'variant-A-3.png' },
  { name: 'suffix appends to the requested stem', existing: ['x-2.png'], requested: 'x-2.png', expected: 'x-2-2.png' },
  { name: 'only the last extension splits', existing: ['shot.v1.png'], requested: 'shot.v1.png', expected: 'shot.v1-2.png' },
  { name: 'no extension', existing: ['mock'], requested: 'mock', expected: 'mock-2' },
];

describe('claim rule table (sh helper and claimOutputPath agree)', () => {
  for (const row of TABLE) {
    // Value: protects=the sh helper and $D bump to the same -N name; fails_when=either suffix rule changes alone;
    //   why_new=the two implementations are new and must stay in lockstep; seam=none
    test(row.name, () => {
      for (const impl of ['sh', 'ts'] as const) {
        const target = fs.mkdtempSync(path.join(dir, `${impl}-`));
        for (const f of row.existing) fs.writeFileSync(path.join(target, f), `existing ${f}`);
        let actual: string;
        if (impl === 'sh') {
          const r = claimSh(stage(), path.join(target, row.requested));
          expect(r.status, r.stderr).toBe(0);
          actual = r.stdout.trim();
        } else {
          const c = claimOutputPath(path.join(target, row.requested));
          fs.closeSync(c.fd);
          actual = c.path;
        }
        expect({ impl, actual }).toEqual({ impl, actual: path.join(target, row.expected) });
        for (const f of row.existing) expect(fs.readFileSync(path.join(target, f), 'utf8')).toBe(`existing ${f}`);
      }
    });
  }
});

describe('gstack-design-claim', () => {
  // Value: protects=publishing copies the staged bytes, prints the final path and never clobbers; fails_when=the helper uses plain cp/mv or > without noclobber;
  //   why_new=new helper replacing shotgun's cp; seam=none
  test('publishes bytes without clobbering and removes the staged copy', () => {
    const dest = path.join(dir, 'designs', 'variant-B.png');
    fs.mkdirSync(path.dirname(dest));
    fs.writeFileSync(dest, 'round one');
    const staged = stage('round two');
    const r = claimSh(staged, dest);
    expect(r.status, r.stderr).toBe(0);
    const final = path.join(dir, 'designs', 'variant-B-2.png');
    expect(r.stdout).toBe(`${final}\n`);
    expect(fs.readFileSync(dest, 'utf8')).toBe('round one');
    expect(fs.readFileSync(final, 'utf8')).toBe('round two');
    expect(fs.existsSync(staged)).toBe(false);
  });

  // Value: protects=the -999 cap stops with problem/cause/fix and keeps the staged image; fails_when=the cap is removed or the staged file is deleted on failure;
  //   why_new=new helper; seam=none
  test('stops at the -999 cap and keeps the staged image', () => {
    const target = path.join(dir, 'full');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'x.png'), '1');
    for (let n = 2; n <= 999; n++) fs.writeFileSync(path.join(target, `x-${n}.png`), String(n));
    const staged = stage();
    const r = claimSh(staged, path.join(target, 'x.png'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already exist');
    expect(r.stderr).toMatch(/cause: .+\nfix: .+/);
    expect(fs.existsSync(staged)).toBe(true);
    expect(fs.readdirSync(target).length).toBe(999);
  });

  // Value: protects=a non-collision error (destination parent is a file) fails at once, explains itself and keeps the staged bytes;
  //   fails_when=errors are treated as collisions or the staged file is removed; why_new=new helper; seam=none
  test('other errors exit non-zero with problem, cause and fix, keeping the staged image', () => {
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'file');
    const staged = stage();
    const r = claimSh(staged, path.join(blocker, 'variant-A.png'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/^gstack-design-claim: cannot create .*staged image kept at .*\ncause: .+\nfix: .+/);
    expect(fs.readFileSync(staged, 'utf8')).toBe('paid bytes');
  });

  // Value: protects=an empty or missing staged file is refused instead of published; fails_when=the -s guard is removed;
  //   why_new=new helper; seam=none
  test('refuses a missing or empty staged image', () => {
    const empty = stage('');
    const r = claimSh(empty, path.join(dir, 'variant-A.png'));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('missing or empty');
    expect(fs.existsSync(path.join(dir, 'variant-A.png'))).toBe(false);
  });
});
