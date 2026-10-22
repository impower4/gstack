/**
 * Empty `find | xargs ls -t` must not fall through to cwd (#2483).
 *
 * GNU xargs runs `ls -t` once even on EMPTY input, and `ls -t` with no
 * operands lists the CURRENT DIRECTORY — so on a fresh install (no
 * ceo-plans / checkpoints / plans yet) a random cwd .md becomes "the plan"
 * or "the latest checkpoint". `xargs -r` pins the BSD skip-on-empty
 * behavior on both GNU and BSD (same shape as the landed
 * bin/gstack-codex-session-import fix, #2482).
 *
 * Re-derived from community PR #2483 by @tranthanhnhatkhoa.
 */
import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HOST_PATHS } from '../scripts/resolvers/types';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateContextRecovery } from '../scripts/resolvers/preamble/generate-context-recovery';
import { discoverSkillFiles } from '../scripts/discover-skills';
import { getExternalHosts } from '../hosts';

const ROOT = path.join(import.meta.dir, '..');

function generatedSkillFiles(root: string): string[] {
  // Match the generator's output locations before scanning files. Workspace
  // evidence, dependencies, and local Claude installs can be arbitrarily large.
  const skillRoots = [root, ...getExternalHosts().map(host => path.join(root, host.hostSubdir, 'skills')),
    path.join(root, 'openclaw', 'skills')];
  return skillRoots.filter(dir => fs.existsSync(dir)).flatMap(dir =>
    discoverSkillFiles(dir).map(file => path.join(dir, file)));
}

function unguardedSkillFiles(root: string): string[] {
  return generatedSkillFiles(root).filter(file => fs.readFileSync(file, 'utf-8').includes('xargs ls -t'));
}

function makeCtx(): TemplateContext {
  return {
    skillName: 'test-skill',
    tmplPath: 'test.tmpl',
    host: 'claude',
    paths: HOST_PATHS.claude,
    preambleTier: 2,
  };
}

describe('empty find must not fall through to cwd (#2483)', () => {
  test('no resolver emits a bare `xargs ls -t` (must be `xargs -r ls -t`)', () => {
    const out = execSync(
      `grep -rn "xargs ls -t" "${path.join(ROOT, 'scripts')}" "${path.join(ROOT, 'bin')}" || true`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    expect(out.trim()).toBe('');
  });

  test('Context Recovery uses the guarded form at both find sites', () => {
    // The listing moved from the rendered fence into bin/gstack-context-recovery
    // (#2763); the render is one literal command with no find at all.
    const rendered = generateContextRecovery(makeCtx());
    expect(rendered).not.toContain('xargs');
    expect(rendered).toContain('gstack-context-recovery');
    const script = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-context-recovery'), 'utf-8');
    expect(script.split('xargs ls -t').length - 1).toBe(0);
    expect(script.split('xargs -r ls -t').length - 1).toBe(2);
  });

  test('live helper: empty checkpoints dir yields NO checkpoint, not a cwd file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cwd-'));
    try {
      // Fresh install shape: the checkpoints dir exists but is EMPTY,
      // and the cwd holds a decoy markdown file.
      const proj = path.join(home, 'projects', 'decoy-proj');
      fs.mkdirSync(path.join(proj, 'checkpoints'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'DECOY.md'), '# not a checkpoint\n');
      const out = execSync(`"${path.join(ROOT, 'bin', 'gstack-context-recovery')}"`, {
        cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, GSTACK_HOME: home, GSTACK_PROJECT_SLUG: 'decoy-proj' },
      });
      expect(out).toContain('--- RECENT ARTIFACTS ---');
      expect(out).not.toContain('LATEST_CHECKPOINT');
      expect(out).not.toContain('DECOY.md');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('no generated SKILL.md carries the unguarded form', () => {
    expect(generatedSkillFiles(ROOT).length).toBeGreaterThan(0);
    expect(unguardedSkillFiles(ROOT)).toEqual([]);
  });

  test('generated skill discovery checks every host and excludes non-generated trees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-skill-scan-'));
    const unsafe = ['SKILL.md', path.join('review', 'SKILL.md'),
      ...getExternalHosts().map(host => path.join(host.hostSubdir, 'skills', 'gstack-review', 'SKILL.md')),
      path.join('openclaw', 'skills', 'gstack-openclaw-review', 'SKILL.md')];
    const decoys = ['.context', 'node_modules', '.claude', 'dist'].map(dir => path.join(dir, 'nested', 'SKILL.md'));
    try {
      for (const file of [...unsafe, ...decoys, path.join('safe', 'SKILL.md')]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), file === path.join('safe', 'SKILL.md') ? 'xargs -r ls -t' : 'xargs ls -t');
      }
      expect(unguardedSkillFiles(root).sort()).toEqual(unsafe.map(file => path.join(root, file)).sort());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
