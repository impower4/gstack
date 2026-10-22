/**
 * Ratchet (a): one state-root rule. Outside the two owners (lib/state-root.ts,
 * bin/gstack-state-root.sh) and the committed allowlist, no tracked file may
 * hand-roll the chain, and every gstack-paths eval must fail stop.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveStateRoot } from '../lib/state-root';

const ROOT = path.resolve(import.meta.dir, '..');
const ALLOWLIST_PATH = 'test/state-root-ratchet.allowlist.json';

type AllowEntry = { path: string; match: string; reason?: string };
type Violation = { file: string; line: number; text: string; rule: string };

const CHAIN = /\\?\$\{GSTACK_(?:HOME|STATE_ROOT|STATE_DIR):-/;
const HOMEDIR_GSTACK = /homedir\(\)\s*,\s*['"`]\.gstack['"`]/g;
const PROSE_ROOT = /(~|\\?\$HOME|\\?\$\{HOME\})\/\.gstack(?![\w-])/;
const PATHS_EVAL = /eval "\$\(.*gstack-paths"?\)"/;
const PATHS_GET = /\$\(\S*gstack-paths"? --get GSTACK_STATE_ROOT\)/;
const GUARD = ': "${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"';
const GUARD_TS = ': "\\${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"';

const isProseSource = (f: string) => f.endsWith('.tmpl') || f.startsWith('scripts/resolvers/');
const isExecutable = (f: string, text: string) =>
  /^#!.*\b(bash|sh)\b/.test(text) || f.endsWith('.sh') || f === 'setup';

/** Lines inside ```bash / ```sh fences (template-literal fences \`\`\` included), comments skipped. */
function bashBlockLines(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let inBash = false;
  text.split('\n').forEach((line, i) => {
    const fence = line.trim().match(/^(?:\\`|`){3}(\w*)/);
    if (fence) { inBash = inBash ? false : /^(bash|sh)$/.test(fence[1]); return; }
    if (inBash && !line.trim().startsWith('#')) out.push([i + 1, line]);
  });
  return out;
}

export function scan(files: Map<string, string>): Violation[] {
  const v: Violation[] = [];
  for (const [file, text] of files) {
    const lines = text.split('\n');
    const code = (line: string) => !/^\s*(#|\/\/|\*)/.test(line) || isProseSource(file);
    lines.forEach((line, i) => {
      if (code(line) && CHAIN.test(line)) v.push({ file, line: i + 1, text: line.trim(), rule: 'inline state-root chain' });
    });
    if (/\.(ts|js|mjs)$/.test(file) || !file.includes('.')) {
      for (const m of text.matchAll(HOMEDIR_GSTACK)) {
        const line = text.slice(0, m.index).split('\n').length;
        v.push({ file, line, text: lines[line - 1].trim(), rule: 'homedir() joined with .gstack' });
      }
    }
    if (isProseSource(file)) {
      for (const [n, line] of bashBlockLines(text)) {
        if (PROSE_ROOT.test(line)) v.push({ file, line: n, text: line.trim(), rule: 'executable ~/.gstack in a bash block' });
      }
      lines.forEach((line, i) => {
        if (/export GSTACK_STATE_ROOT\b/.test(line)) v.push({ file, line: i + 1, text: line.trim(), rule: 'export GSTACK_STATE_ROOT in prose' });
      });
    }
    if (isProseSource(file) || isExecutable(file, text)) {
      const guarded = (line: string) => line.includes(GUARD) || line.includes(GUARD_TS);
      lines.forEach((line, i) => {
        if (!code(line)) return;
        // Skill blocks never eval (#2763): worktree-isolated Claude Code
        // sessions refuse it, guarded or not. Executables may.
        if (isProseSource(file) && PATHS_EVAL.test(line)) {
          v.push({ file, line: i + 1, text: line.trim(), rule: 'gstack-paths eval in a skill block' });
        } else if ((PATHS_EVAL.test(line) || PATHS_GET.test(line)) && !guarded(line)) {
          v.push({ file, line: i + 1, text: line.trim(), rule: 'unguarded gstack-paths eval' });
        }
      });
    }
  }
  return v;
}

function allowed(v: Violation, allow: AllowEntry[]): boolean {
  return allow.some((a) => (a.path.endsWith('/') ? v.file.startsWith(a.path) : v.file === a.path)
    && (a.match === '*' || v.text === a.match));
}

function report(violations: Violation[]): string {
  if (violations.length === 0) return '';
  return [
    ...violations.map((x) => `${x.file}:${x.line}  ${x.text}  (${x.rule})`),
    'Rule: gstack state lives under one root resolved by one chain; a hand-rolled chain drifts (plugin installs and GSTACK_HOME users silently split their state), and an unguarded eval writes under / when the resolver is missing.',
    'Fix: in skill prose use GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); ' + GUARD
      + ' (worktree-isolated Claude Code sessions refuse eval); in executables use eval "$(~/.claude/skills/gstack/bin/gstack-paths)"; ' + GUARD
      + ' (hooks and bins may source bin/gstack-state-root.sh instead); in TS use resolveStateRoot() from lib/state-root.ts.',
    `Allowlist: ${ALLOWLIST_PATH}, keyed on file path plus matched line text, each entry with a reason. Legitimate only for illustrative prose, an install location that is not state, or a named partial-upgrade fallback.`,
  ].join('\n');
}

function trackedFiles(): Map<string, string> {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 });
  const files = new Map<string, string>();
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    if (/\.(png|jpg|jpeg|gif|webp|pdf|ico|woff2?|ttf|lock|onnx|bin|zip)$/i.test(f)) continue;
    const full = path.join(ROOT, f);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      files.set(f, fs.readFileSync(full, 'utf-8'));
    } catch { /* deleted in the working tree */ }
  }
  return files;
}

const allow: AllowEntry[] = JSON.parse(fs.readFileSync(path.join(ROOT, ALLOWLIST_PATH), 'utf-8'));

describe('ratchet (a): one state-root rule', () => {
  test('every allowlist entry carries a reason', () => {
    const missing = allow.filter((a) => !a.reason || !a.reason.trim());
    expect(missing.map((a) => `${a.path} :: ${a.match}`)).toEqual([]);
  });

  test('no tracked file outside the owners and the allowlist hand-rolls the state root', () => {
    expect(report(scan(trackedFiles()).filter((x) => !allowed(x, allow)))).toBe('');
  });

  test('planted violations fail with file:line, the Fix: text and the allowlist path', () => {
    const planted = new Map<string, string>([
      ['bin/gstack-planted', '#!/usr/bin/env bash\n# a comment "${GSTACK_HOME:-$HOME/.gstack}" is prose\nX="${GSTACK_HOME:-$HOME/.gstack}"\neval "$("$(dirname "$0")/gstack-paths")"\n'],
      ['lib/planted.ts', "import { homedir } from 'os';\nconst r = join(\n  homedir(), '.gstack');\n"],
      ['planted/SKILL.md.tmpl', 'Prose ~/.gstack is fine.\n```bash\n# comment ~/.gstack is fine\nmkdir -p ~/.gstack/analytics\nexport GSTACK_STATE_ROOT\neval "$(~/.claude/skills/gstack/bin/gstack-paths)"\neval "$(~/.claude/skills/gstack/bin/gstack-paths)"; ' + GUARD + '\nGSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT)\n```\n'],
    ]);
    const found = scan(planted);
    expect(found.map((x) => `${x.file}:${x.line}:${x.rule}`)).toEqual([
      'bin/gstack-planted:3:inline state-root chain',
      'bin/gstack-planted:4:unguarded gstack-paths eval',
      'lib/planted.ts:3:homedir() joined with .gstack',
      'planted/SKILL.md.tmpl:4:executable ~/.gstack in a bash block',
      'planted/SKILL.md.tmpl:5:export GSTACK_STATE_ROOT in prose',
      'planted/SKILL.md.tmpl:6:gstack-paths eval in a skill block',
      'planted/SKILL.md.tmpl:7:gstack-paths eval in a skill block',
      'planted/SKILL.md.tmpl:8:unguarded gstack-paths eval',
    ]);
    const message = report(found);
    expect(message).toContain('planted/SKILL.md.tmpl:4  mkdir -p ~/.gstack/analytics');
    expect(message).toContain('Fix: ');
    expect(message).toContain('resolveStateRoot()');
    expect(message).toContain(ALLOWLIST_PATH);
  });

  test('allowlist entries are keyed on text, not line numbers: inserting a line above still passes', () => {
    const file = 'careful/bin/check-careful.sh';
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    const shifted = new Map([[file, `# inserted line\n${text}`]]);
    const found = scan(shifted);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((x) => !allowed(x, allow))).toEqual([]);
  });

  test('guarded evals and the owners pass, and the TS owner resolves the documented default', () => {
    const ok = new Map([
      ['x/SKILL.md.tmpl', '```bash\nGSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT); ' + GUARD + '\nls "$GSTACK_STATE_ROOT"/projects\n```\n'],
      ['bin/gstack-x', '#!/usr/bin/env bash\neval "$("$(dirname "$0")/gstack-paths")"; ' + GUARD + '\n'],
    ]);
    expect(scan(ok)).toEqual([]);
    expect(resolveStateRoot({ HOME: '/h' }, 'linux')).toBe('/h/.gstack');
  });
});
