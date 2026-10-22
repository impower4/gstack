/**
 * pregate check `secrets` (tier 1, preflight, never downgradable): the
 * branch's added lines (merge-base → working tree, untracked files included)
 * go through bin/gstack-redact. Exit 0 is clean; 2 (MEDIUM) and 3 (HIGH)
 * fail; anything else is incomplete. Runs regardless of lint tools.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runScriptSync } from '../../script-invocation';
import { baseInputs, sha256 } from '../context';
import type { CheckDef, CheckResult, PregateContext } from '../types';

const BIN_DIR = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), '..', '..', '..', 'bin');

/** The diff's added-line text per file, hunk-aware: a `+++` inside a hunk is content, not a header. */
export function parseAddedLines(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let file = '';
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --')) { file = ''; inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    if (line.startsWith('+')) files.set(file, [...(files.get(file) ?? []), line.slice(1)]);
  }
  return files;
}

/**
 * Added lines from the merge-base to the working tree, plus every line of
 * untracked files, grouped by file so gstack-redact can use each file's type
 * (#3211). External diff and textconv drivers are off: either can empty or
 * rewrite the diff, and an empty diff reads as clean.
 */
export function addedLines(ctx: PregateContext): Array<{ file: string; text: string }> {
  const diff = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-filter=ACMR', ctx.mergeBase, '--'], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: ctx.env });
  const files = parseAddedLines(diff.stdout ?? '');
  for (const t of ctx.touched) {
    if (!t.uncommitted || t.status === 'D') continue;
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', t.path], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 15_000 }).status === 0;
    if (tracked) continue;
    try { const st = fs.statSync(path.join(ctx.repoRoot, t.path)); if (st.isFile() && st.size <= 4 * 1024 * 1024) files.set(t.path, [...(files.get(t.path) ?? []), ...fs.readFileSync(path.join(ctx.repoRoot, t.path), 'utf8').split('\n')]); } catch { /* unreadable: skipped */ }
  }
  return [...files].map(([file, lines]) => ({ file, text: lines.join('\n') })).filter(p => p.text.trim());
}

type Finding = { id?: string; description?: string; severity?: string; category?: string; line?: number; file: string };

function run(ctx: PregateContext): CheckResult {
  const parts = addedLines(ctx);
  const inputs = baseInputs(ctx, { added_lines: sha256(JSON.stringify(parts)) });
  if (!parts.length) return { id: 'secrets', stage: 'preflight', status: 'pass', detail: 'no added lines', inputs };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pregate-secrets-'));
  try {
    const findings: Finding[] = [];
    let high = false;
    let medium = false;
    for (const [i, part] of parts.entries()) {
      const file = path.join(tmp, String(i), path.basename(part.file) || 'added.txt');
      fs.mkdirSync(path.dirname(file), { mode: 0o700 });
      fs.writeFileSync(file, part.text, { mode: 0o600 });
      const r = runScriptSync(path.join(BIN_DIR, 'gstack-redact'), ['--from-file', file, '--json', '--max-bytes', String(64 * 1024 * 1024)], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: Math.min(ctx.timeoutMs, 300_000), maxBuffer: 64 * 1024 * 1024, env: ctx.env });
      if (r.error || r.status === null) return { id: 'secrets', stage: 'preflight', status: 'incomplete', inputs, code: 'PREGATE_INCOMPLETE', detail: `gstack-redact did not finish on ${part.file || 'added lines'} (${r.error?.message ?? 'killed'})`, fix: 'rerun; raise --timeout for very large diffs' };
      if (r.status !== 0 && r.status !== 2 && r.status !== 3) return { id: 'secrets', stage: 'preflight', status: 'incomplete', inputs, code: 'PREGATE_INCOMPLETE', detail: `gstack-redact exited ${r.status} on ${part.file || 'added lines'}: ${(r.stderr ?? '').trim().split('\n').pop() ?? ''}`, fix: 'fix the scanner invocation; an incomplete scan never passes' };
      high ||= r.status === 3;
      medium ||= r.status === 2;
      try { findings.push(...(JSON.parse(r.stdout).findings ?? []).map((f: Omit<Finding, 'file'>) => ({ ...f, file: part.file }))); } catch { /* non-JSON output: judged by exit status */ }
    }
    const render = (f: Finding) => `${f.severity} ${f.id ?? 'finding'} [${f.category ?? '?'}]: ${f.description ?? ''}${f.line ? ` (${f.file ? `${f.file}, ` : ''}added line ${f.line})` : ''}`;
    // HIGH and any MEDIUM credential fail; a MEDIUM hygiene/internal/pii/legal
    // hit in code (a `.local` property reads as a hostname) is listed as warn:
    // there is no user to answer gstack-redact's per-finding question here.
    const blocking = findings.filter(f => f.severity === 'HIGH' || (f.severity === 'MEDIUM' && f.category === 'secret'));
    const advisory = findings.filter(f => f.severity === 'MEDIUM' && f.category !== 'secret');
    const lineCount = parts.reduce((n, p) => n + p.text.split('\n').length, 0);
    if (!high && !medium) return { id: 'secrets', stage: 'preflight', status: 'pass', inputs, detail: `${lineCount} added lines clean${findings.length ? ` (${findings.length} WARN)` : ''}` };
    if (blocking.length) return { id: 'secrets', stage: 'preflight', status: 'fail', inputs, lines: [...blocking, ...advisory].map(render), code: 'PREGATE_SECRETS', detail: `${blocking.length} credential finding(s) in added lines (${blocking.map(f => f.id).join(', ')})`, fix: 'rotate and remove the credential from the added lines (history included); secrets cannot be downgraded' };
    if (high) return { id: 'secrets', stage: 'preflight', status: 'fail', inputs, lines: findings.map(render), code: 'PREGATE_SECRETS', detail: 'HIGH finding(s) in added lines', fix: 'rotate and remove the credential from the added lines (history included); secrets cannot be downgraded' };
    return { id: 'secrets', stage: 'preflight', status: 'warn', inputs, lines: advisory.map(render), code: 'PREGATE_SECRETS', detail: `${advisory.length} MEDIUM non-credential finding(s) in added lines (${[...new Set(advisory.map(f => f.id))].join(', ')})`, fix: 'read each listed line; gstack-post asks about the same findings when the PR body quotes them' };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const secretsCheck: CheckDef = { id: 'secrets', stage: 'preflight', tier: 1, downgradable: false, needsRepoCommands: false, run };
