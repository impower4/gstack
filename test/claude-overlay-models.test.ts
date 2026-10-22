/**
 * `resolveClaudeOverlay` — the validation table behind `./setup --claude-model`.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ALL_MODEL_NAMES, CLAUDE_OVERLAY_MODELS, type ClaudeOverlay, type ClaudeOverlayError, resolveClaudeOverlay } from '../scripts/models';

const ROOT = resolve(import.meta.dir, '..');

describe('resolveClaudeOverlay', () => {
  test.each([
    ['claude', 'claude', false],
    ['opus-4-7', 'opus-4-7', false],
    ['claude-opus-4-7', 'opus-4-7', false],
    ['claude-opus-4-8-20260115', 'opus-4-8', false],
    ['claude-opus-4-8-latest', 'opus-4-8', false],
    ['claude-sonnet-5[1m]', 'sonnet-5', false],
    ['  Claude-Sonnet-5  ', 'sonnet-5', false],
    ['claude-fable-5-1', 'fable-5', false],
    ['claude-opus-5-5', 'claude', true],
    ['claude-opus-4-7-1', 'claude', true],
    ['claude-haiku-4-5', 'claude', true],
    ['claude-3-opus-20240229', 'claude', true],
  ] as [string, ClaudeOverlay, boolean][])('%p uses the %p overlay', (id, overlay, generic) => {
    expect(resolveClaudeOverlay(id)).toEqual({ overlay, generic });
  });

  test.each([
    ['opus', 'alias'],
    ['sonnet', 'alias'],
    ['haiku', 'alias'],
    ['default', 'alias'],
    ['Opus[1m]', 'alias'],
    ['gpt-5.4', 'non-claude'],
    ['gemini', 'non-claude'],
    ['o3', 'non-claude'],
    ['gpt-6-astra', 'non-claude'],
    ['banana', 'unknown'],
    ['', 'unknown'],
  ] as [string, ClaudeOverlayError['kind']][])('%p is rejected as %p with problem, cause and fix', (id, kind) => {
    const result = resolveClaudeOverlay(id);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.kind).toBe(kind);
    for (const part of [result.error.problem, result.error.cause, result.error.fix]) expect(part.length).toBeGreaterThan(10);
    expect(result.error.fix).toContain('claude');
  });

  test('every Claude overlay is a known model with an overlay file', () => {
    for (const overlay of CLAUDE_OVERLAY_MODELS) {
      expect((ALL_MODEL_NAMES as readonly string[]).includes(overlay)).toBe(true);
      expect(existsSync(join(ROOT, 'model-overlays', `${overlay}.md`))).toBe(true);
    }
  });

  test('the CLI bridge setup calls prints overlay and generic flag, or the error lines', () => {
    const run = (id: string) => spawnSync('bun', ['run', 'scripts/models.ts', 'claude-overlay', id], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    const ok = run('claude-opus-5-5');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('claude\t1\n');
    const bad = run('opus');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr.trim().split('\n')).toHaveLength(3);
  });
});
