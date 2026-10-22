/**
 * Skills start in worktree-isolated Claude Code sessions (#2763).
 *
 * A session isolated to `.claude/worktrees/<name>` refuses any Bash command it
 * cannot statically prove keeps git inside the worktree. Reproduced with the
 * pinned CLI (2.1.284, `claude -p --worktree`), refused verbatim:
 *   - a command named by a variable (`"$_SS" …`): "runs a command whose name
 *     is computed at runtime inside a construct too complex to verify"
 *   - `eval "$(…gstack-slug…)"` / `eval "$(…gstack-paths)"`, `.` / `source`:
 *     "runs eval inside a construct too complex to verify"
 *   - git inside a pipe or an argument substitution, or `X=$(git …)` followed
 *     by further commands: "names git in a form too complex to verify"
 * while a literal-path command, `X=$(<literal path> …)` and `: "${X:?…}"` run.
 * These checks pin the generated shapes to the forms that ran.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const EVAL_HELPER = /\beval\s+"\$\(.*gstack-(?:slug|paths)/;

function claudeSkills(): string[] {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
  const files = ['SKILL.md'];
  for (const d of dirs) {
    if (fs.existsSync(path.join(ROOT, d.name, 'SKILL.md'))) files.push(path.join(d.name, 'SKILL.md'));
    const sections = path.join(ROOT, d.name, 'sections');
    if (fs.existsSync(sections)) for (const f of fs.readdirSync(sections)) if (f.endsWith('.md')) files.push(path.join(d.name, 'sections', f));
  }
  return files;
}

function bashFences(text: string): string[] {
  return [...text.matchAll(/^```(?:bash|sh)\n([\s\S]*?)\n```/gm)].map(m => m[1]!);
}

function fenceAfter(text: string, heading: RegExp): string {
  const at = text.search(heading);
  expect(at).toBeGreaterThan(-1);
  const open = text.indexOf('```bash\n', at) + '```bash\n'.length;
  return text.slice(open, text.indexOf('\n```', open));
}

describe('worktree-isolated session shapes (#2763)', () => {
  test('no generated Claude skill or section evals gstack-slug or gstack-paths', () => {
    const offenders: string[] = [];
    for (const file of claudeSkills()) {
      for (const fence of bashFences(fs.readFileSync(path.join(ROOT, file), 'utf-8'))) {
        for (const line of fence.split('\n')) if (EVAL_HELPER.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the skill start, context recovery and eureka blocks use only the forms that ran', () => {
    let starts = 0;
    for (const file of claudeSkills().filter(f => f.endsWith('SKILL.md'))) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      if (!/^## Preamble \((?:run first|after scope gate)\)/m.test(text)) continue;
      starts++;
      expect(fenceAfter(text, /^## Preamble \((?:run first|after scope gate)\)/m), file)
        .toMatch(/^~\/\.claude\/skills\/gstack\/bin\/gstack-skill-start --skill "[a-z0-9-]+" --model "[a-z0-9.-]+"$/);
      if (text.includes('\n## Context Recovery\n')) {
        expect(fenceAfter(text, /^## Context Recovery$/m), file).toBe('~/.claude/skills/gstack/bin/gstack-context-recovery');
      }
      if (text.includes('**Eureka:**')) {
        const eureka = fenceAfter(text, /\*\*Eureka:\*\*/);
        expect(eureka, file).not.toMatch(/\beval\b|^\.\s|\bsource\b|\$\(git\b|^"\$/m);
        expect(eureka.split('\n')[0], file).toBe('GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); : "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"');
      }
    }
    expect(starts).toBeGreaterThan(40);
  });
});
