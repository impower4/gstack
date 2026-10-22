/**
 * Field list 2, W6: `gstack-autoplan export --public <dir>` writes a copy of a
 * run with its recorded machine roots rewritten, never touching the private
 * run, and `gstack-artifact validate --public <dir> [--private <run.json>]`
 * fails on a recorded root (file:line) and on provenance drift, and WARNs on
 * generic home paths. The regression shape is gbrain-evals #164: a committed
 * plan that cited the run directory and the author's home in prose. Runs on
 * the simulated Capy host; every spawn has a timeout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LOCAL_NOTES, rewriteRoots } from '../lib/autoplan-public';
import { ROOT, SMALL_PLAN } from './helpers/autoplan-run-fixture';
import { capyRunner, phaseVia, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
const ARTIFACT = path.join(ROOT, 'bin', 'gstack-artifact');
const artifact = (args: string[]) => spawnSync('bun', [ARTIFACT, ...args], { cwd: ROOT, env: r.env, encoding: 'utf8', timeout: 60_000 });
let n = 0;

/** A gated run whose plan cites its own run directory and the author's home in prose (gbrain-evals #164). */
function gatedRun(extra = ''): { out: string; dir: string } {
  const dir = path.join(r.host.base, `pub${++n}`);
  const out = path.join(dir, 'run');
  const text = SMALL_PLAN.replace('## Review record', `Run notes live in ${out}/plan-active.md and ${r.host.home}/notes/retry.md.${extra}\n\n## Review record`);
  const plan = writePlan(dir, text);
  const first = r.ap(['next', '--out', out, '--plan', plan, '--no-ui']);
  if (first.status !== 0) throw new Error(first.stderr);
  phaseVia(r, out, 'ceo', { native: [{ severity: 'High', title: 'Notes path leaks', file: path.join(out, 'plan-active.md'), line: 3 }], outside: [] });
  phaseVia(r, out, 'eng', { native: [], outside: [] });
  expect(r.ap(['export', '--out', out]).status).toBe(0);
  return { out, dir };
}
const digest = (dir: string) => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name !== 'run.lock')
  .map(e => { const f = path.join(e.parentPath, e.name); return [path.relative(dir, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]; }));
const allText = (dir: string) => fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

describe('export --public', () => {
  test('rewrites recorded roots, leaves the private run byte-identical and resumable, and validates', () => {
    const { out, dir } = gatedRun();
    const before = digest(out);
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status, e.stderr).toBe(0);
    expect(e.stdout).toContain(`EXPORTED_PUBLIC: ${path.join(pub, 'plan.md')}`);
    expect(digest(out)).toEqual(before);
    const text = allText(pub);
    expect(text).not.toContain(out);
    expect(text).not.toContain(r.host.home);
    expect(text).not.toContain(dir);
    expect(fs.readFileSync(path.join(pub, 'plan.md'), 'utf8')).toContain('Run notes live in <local notes (not committed)>/plan-active.md and <local notes (not committed)>/notes/retry.md.');
    const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'run.json'), 'utf8'));
    expect(manifest.provenance.private_run).toBe(readRunJson(out).run);
    expect(manifest.provenance.files['plan.md'].private_sha256).toBe(readRunJson(out).artifacts['plan.md'].sha256);
    expect(manifest.artifacts['plan.md'].sha256).toBe(manifest.provenance.files['plan.md'].public_sha256);
    const full = artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]);
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout).toMatch(/^ARTIFACT_VALID: public run=\S+ warnings=0$/m);
    const standalone = artifact(['validate', '--public', pub]);
    expect(standalone.status, standalone.stderr).toBe(0);
    expect(standalone.stdout).toContain('recorded roots unchecked: pass --private <run.json> on the exporting machine');
    const resumed = r.ap(['resume', '--out', out]);
    expect(resumed.stdout).toContain('status=gate_pending');
    expect(r.validate(out).status).toBe(0);
  });

  test('validate --public fails on a recorded root with file:line, and on provenance drift without --private', () => {
    const { out, dir } = gatedRun();
    const pub = path.join(dir, 'public');
    expect(r.ap(['export', '--out', out, '--public', pub]).status).toBe(0);
    const record = path.join(pub, 'review-record.md');
    const lines = fs.readFileSync(record, 'utf8').split('\n').length;
    fs.appendFileSync(record, `see ${out}/attempts.jsonl\n`);
    const full = artifact(['validate', '--public', pub, '--private', path.join(out, 'run.json')]);
    expect(full.status).toBe(1);
    expect(full.stderr).toContain(`at review-record.md:${lines}`);
    expect(full.stderr).toMatch(/the recorded run root \S+ appears in the public copy at review-record\.md:\d+\).*\(ARTIFACT_MACHINE_PATH\)$/m);
    const standalone = artifact(['validate', '--public', pub]);
    expect(standalone.status).toBe(1);
    expect(standalone.stderr).toMatch(/\(ARTIFACT_STALE\)$/m);
  });

  test('a recorded root inside plan.md code is never rewritten: export refuses and writes nothing; generic home paths WARN', () => {
    const { out, dir } = gatedRun(`\n\n\`\`\`bash\ncat ${r.host.home}/notes/retry.md\n\`\`\`\n\nThe old box kept them in /home/someone/notes.`);
    const pub = path.join(dir, 'public');
    const e = r.ap(['export', '--out', out, '--public', pub]);
    expect(e.status).toBe(3);
    expect(e.stderr).toMatch(/plan\.md:\d+: the recorded home root .* \(inside code, which export never rewrites: edit the plan\).*\(ARTIFACT_MACHINE_PATH\)$/m);
    expect(fs.existsSync(pub)).toBe(false);
    expect(fs.readdirSync(dir).filter(f => f.includes('.public-'))).toEqual([]);
    const ok = gatedRun('\n\nThe old box kept them in /home/someone/notes.');
    const pub2 = path.join(ok.dir, 'public');
    const warned = r.ap(['export', '--out', ok.out, '--public', pub2]);
    expect(warned.status, warned.stderr).toBe(0);
    expect(warned.stderr).toMatch(/^WARN: plan\.md:\d+ has a home-directory path \(\/home\/someone\/\)/m);
    const taken = path.join(ok.dir, 'taken');
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, 'keep.txt'), 'x');
    const refused = r.ap(['export', '--out', ok.out, '--public', taken]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toMatch(/\(ARTIFACT_PUBLIC_TARGET_EXISTS\)$/m);
    expect(r.ap(['export', '--out', ok.out, '--public', pub2]).status).toBe(0);
  });
});

describe('export --public path containment', () => {
  test('an artifact path that leaves the run directory refuses before anything is written, outside or inside --public', () => {
    const { out, dir } = gatedRun();
    const text = 'synthetic artifact text\n';
    fs.writeFileSync(path.join(dir, 'sentinel.txt'), text);
    const victim = path.join(r.host.base, `victim${n}.txt`);
    fs.writeFileSync(victim, 'unrelated owner file\n');
    const state = readRunJson(out);
    state.artifacts['escape.txt'] = { path: `../../${path.basename(victim)}`, sha256: crypto.createHash('sha256').update(text).digest('hex') };
    fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(state) + '\n');
    const pub = path.join(dir, 'public');
    const x = r.ap(['export', '--out', out, '--public', pub]);
    expect(x.status, x.stdout + x.stderr).toBe(3);
    expect(x.stderr).toContain('ARTIFACT_PATH_ESCAPE');
    expect(fs.readFileSync(victim, 'utf8')).toBe('unrelated owner file\n');
    expect(fs.existsSync(pub)).toBe(false);
  });
});

describe('rewriteRoots', () => {
  test('a worktree path becomes repo-relative; a local root nested in the worktree still reads as local notes', () => {
    const roots = [{ label: 'run', root: '/w/repo/.context/run' }, { label: 'home', root: '/home/u' }, { label: 'worktree', root: '/w/repo' }];
    expect(rewriteRoots('see /w/repo/lib/a.ts and /w/repo', roots)).toBe('see lib/a.ts and .');
    expect(rewriteRoots('notes at /home/u/notes.md', roots)).toBe(`notes at ${LOCAL_NOTES}/notes.md`);
    expect(rewriteRoots('/w/repo/.context/run/run.json', roots)).toBe('.context/run/run.json');
  });
});
