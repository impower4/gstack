/**
 * `bun run audit:manifest` — the slices a contributor feeds to
 * `/claude-api prompt-audit` at each frontier-model release.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildManifest } from '../scripts/prompt-audit-manifest';

const ROOT = resolve(import.meta.dir, '..');

describe('prompt-audit manifest', () => {
  const manifest = buildManifest();
  const files = manifest.flatMap(s => s.files);

  test('covers CLAUDE.md, every overlay and resolver, and the skill templates, each once', () => {
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain('CLAUDE.md');
    for (const overlay of readdirSync(join(ROOT, 'model-overlays'))) expect(files).toContain(`model-overlays/${overlay}`);
    for (const rel of ['scripts/resolvers/constants.ts', 'scripts/resolvers/preamble.ts', 'ship/SKILL.md.tmpl', 'codex/sections/consult-mode.md.tmpl', 'test/helpers/llm-judge.ts']) {
      expect(files).toContain(rel);
    }
    expect(files.some(f => f.endsWith('SKILL.md'))).toBe(false);
    const resolvers = (readdirSync(join(ROOT, 'scripts/resolvers'), { recursive: true }) as string[])
      .filter(f => f.endsWith('.ts')).map(f => `scripts/resolvers/${f.replaceAll('\\', '/')}`);
    expect(resolvers.filter(f => !files.includes(f))).toEqual([]);
  });

  test('a skill stays in one slice, and only a single oversized unit exceeds the budget', () => {
    const sliceOf = new Map(manifest.flatMap(s => s.files.map(f => [f, s.id] as const)));
    expect(sliceOf.get('codex/SKILL.md.tmpl')).toBe(sliceOf.get('codex/sections/consult-mode.md.tmpl'));
    for (const slice of manifest.filter(s => s.group !== 'shared instructions')) {
      if (slice.bytes > 200 * 1024) {
        const skills = new Set(slice.files.map(f => f.split('/')[0]));
        expect(slice.files.length === 1 || skills.size === 1).toBe(true);
      }
      expect(slice.bytes).toBe(slice.files.reduce((n, f) => n + statSync(join(ROOT, f)).size, 0));
    }
    expect(manifest.map(s => s.id)).toEqual(manifest.map((_, i) => `s${String(i + 1).padStart(2, '0')}`));
  });

  test('bun run audit:manifest prints the slices', () => {
    const r = spawnSync('bun', ['run', 'audit:manifest'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('/claude-api prompt-audit');
    expect(r.stdout).toContain('## s01 shared instructions');
    const json = spawnSync('bun', ['run', 'scripts/prompt-audit-manifest.ts', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(JSON.parse(json.stdout)).toEqual(manifest);
  });
});
