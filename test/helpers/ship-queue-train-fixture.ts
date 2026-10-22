/**
 * Fixtures for merge trains (lib/ship-queue-train*.ts): a hermetic repo from
 * restamp-fixture (bare origin plus working clone under os.tmpdir(), its own
 * git identity) whose base policy declares a `train` block, and a stateful
 * `gh` on PATH that answers every GitHub call the train surface makes from a
 * JSON file: PR views, repo view, workflow dispatches that create runs (with
 * a train record, a full-gate check run and bisect prefix artifacts built
 * from per-test rules), run lists by workflow, branch and event, run views,
 * artifact downloads and check-run reads. Every call is logged, so tests can
 * prove what was (and was not) dispatched.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TRAIN_KEYS_VERSION } from '../../lib/ship-policy';
import { BASE_POLICY, makeFixtureRepo, runBin, type FixtureRepo } from './restamp-fixture';

export const TRAIN_BLOCK = {
  gate_workflow: 'evals.yml', free_workflow: 'free-tests.yml', full_gate_check: 'gstack/full-gate', record_artifact: 'gstack-train-record',
  max_size: 5, fill_hours: 3, screen_selection: 'none', trial_reservation_usd: 1.5,
};
export const TRAIN_POLICY = { ...BASE_POLICY, train: TRAIN_BLOCK, min_gstack_version: TRAIN_KEYS_VERSION };

export interface Rule {
  fail?: boolean; silent?: boolean; failButCreate?: boolean; status?: string; conclusion?: string | null; event?: string; headSha?: string;
  record?: { panels: unknown[]; census?: unknown; verdict?: 'GREEN' | 'RED'; nonce?: string };
  check?: string | null;
  bisect?: { prefixes: string[]; patterns: Record<string, string>; costUsd?: number };
}
export interface ShimData {
  repo: string; origin: string; nextId: number; prs: Record<string, unknown>; runs: Array<Record<string, unknown>>;
  artifacts: Record<string, Record<string, unknown>>; checks: Record<string, Array<{ name: string; status: string; conclusion: string | null }>>;
  ci: Record<string, unknown[]>; rules: Record<string, Rule>; artifact: string; log: Array<Record<string, unknown>>;
}

export interface TrainFixture { repo: FixtureRepo; state: string; dataFile: string; env: Record<string, string>; read: () => ShimData; write: (fn: (d: ShimData) => void) => void }

export function trainFixture(policy: Record<string, unknown> = TRAIN_POLICY, prefix = 'gstack-train-'): TrainFixture {
  const repo = makeFixtureRepo({ policy, prefix });
  const dir = path.join(repo.root, 'gh-train-shim');
  fs.mkdirSync(dir, { recursive: true });
  const dataFile = path.join(dir, 'data.json');
  const data: ShimData = { repo: 'fixture/repo', origin: repo.origin, nextId: 100, prs: {}, runs: [], artifacts: {}, checks: {}, ci: {}, rules: {}, artifact: TRAIN_BLOCK.record_artifact, log: [] };
  fs.writeFileSync(dataFile, JSON.stringify(data));
  fs.writeFileSync(path.join(dir, 'shim.js'), shimSource());
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nexec node "${path.join(dir, 'shim.js')}" "${dataFile}" "$@"\n`, { mode: 0o755 });
  const state = path.join(repo.root, 'state');
  const env = { PATH: `${dir}:${process.env.PATH ?? ''}`, GSTACK_STATE_ROOT: state, GSTACK_SHIP_QUEUE_POLL_MS: '20', GSTACK_EVAL_BG_POLL_MS: '20', GSTACK_SHIP_QUEUE_NOW: '2026-10-18T12:00:00Z' };
  const read = () => JSON.parse(fs.readFileSync(dataFile, 'utf8')) as ShimData;
  const write = (fn: (d: ShimData) => void) => { const d = read(); fn(d); fs.writeFileSync(dataFile, JSON.stringify(d)); };
  return { repo, state, dataFile, env, read, write };
}

/** The repo key lib/ship-queue-train-record.ts derives from origin's URL. */
export function repoKey(fx: TrainFixture): string {
  const norm = fx.repo.origin.replace(/\.git$/, '').replace(/\/+$/, '');
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** A same-repo PR: a branch from origin/main touching `file`, published as refs/pull/<n>/head (and /merge), known to the gh shim. */
export function openPr(fx: TrainFixture, pr: string, opts: { file?: string; text?: string; changelog?: boolean; cross?: boolean; from?: string } = {}): string {
  const { repo } = fx;
  repo.git('checkout', '-q', opts.from ?? 'origin/main', '-B', `pr-${pr}`);
  const file = opts.file ?? `pr-${pr}.txt`;
  fs.mkdirSync(path.dirname(path.join(repo.work, file)), { recursive: true });
  fs.writeFileSync(path.join(repo.work, file), opts.text ?? `change from #${pr}\n`);
  if (opts.changelog !== false) {
    const cl = fs.readFileSync(path.join(repo.work, 'CHANGELOG.md'), 'utf8');
    fs.writeFileSync(path.join(repo.work, 'CHANGELOG.md'), cl.replace('# Changelog\n', `# Changelog\n\n## [Unreleased]\n\n- #${pr} change\n`));
  }
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `feat #${pr}`);
  const head = repo.git('rev-parse', 'HEAD');
  repo.git('push', '-q', '-f', 'origin', `HEAD:refs/pull/${pr}/head`, `HEAD:refs/pull/${pr}/merge`);
  fx.write(d => { d.prs[pr] = { headRefOid: head, isCrossRepository: !!opts.cross, state: 'OPEN', headRefName: `pr-${pr}`, url: `https://github.com/fixture/repo/pull/${pr}`, body: '' }; });
  return head;
}

/** A READY receipt as `ready --screen|--no-screen` writes it (the lane side is tested separately). */
export function readyReceipt(fx: TrainFixture, pr: string, head: string, opts: { screen?: boolean; at?: string } = {}): void {
  const key = repoKey(fx);
  const file = path.join(fx.state, 'ship-queue', 'ready', key, `${pr}-${head}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = opts.at ?? '2026-10-18T08:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify({ schema: 1, kind: 'ready', repo_key: key, pr, head, base_sha: fx.repo.git('rev-parse', 'origin/main'), ready_at: at,
    screen: { choice: opts.screen ? 'screen' : 'no-screen', policy: opts.screen ? 'narrow' : null, nonce: null, run: null, merge_sha: null }, updated_at: at }));
}

export const PASS = (id: string, kind = 'rule', cost = 0.7) => ({ case: id, kind, status: 'PASS', red_class: null, cost_usd: cost });
export const FAIL = (id: string, cls = 'VERDICT', cost = 0.9) => ({ case: id, kind: 'rule', status: 'FAIL', red_class: cls, cost_usd: cost });
export const COMPLETE = { complete: true, planned: { rule: 2, judge: 1 }, executed: { rule: 2, judge: 1 }, unbound: 0, partial_shards: 0, cancelled_shards: 0, killed_before_upload: 0 };
export const GREEN_GATE: Rule = { record: { panels: [PASS('c1'), PASS('c2'), PASS('j1', 'judge', 0.1)], census: COMPLETE, verdict: 'GREEN' }, check: 'success' };
export const RED_GATE: Rule = { conclusion: 'failure', record: { panels: [FAIL('c1'), PASS('c2'), PASS('j1', 'judge', 0.1)], census: COMPLETE, verdict: 'RED' }, check: null };

export function queue(fx: TrainFixture, args: string[], extraEnv: Record<string, string> = {}, cwd = fx.repo.work) {
  return runBin(fx.repo, 'gstack-ship-queue', [...args, '--base', 'main'], { ...fx.env, ...extraEnv }, cwd);
}

export const line = (out: string, prefix: string) => out.split('\n').find(l => l.startsWith(prefix)) ?? '';
export const nonceOf = (out: string) => /^TRAIN: (\S+)/m.exec(out)?.[1] ?? '';
export function trainJson(fx: TrainFixture, nonce: string, state = fx.state): any {
  return JSON.parse(fs.readFileSync(path.join(state, 'ship-queue', 'trains', nonce, 'train.json'), 'utf8'));
}
export const dispatches = (fx: TrainFixture, workflow?: string) => fx.read().log.filter(l => l.cmd === 'workflow run' && (!workflow || l.workflow === workflow));

function shimSource(): string {
  return [
    "const fs = require('fs'); const path = require('path'); const cp = require('child_process');",
    "const file = process.argv[2]; const a = process.argv.slice(3); const d = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "const save = () => fs.writeFileSync(file, JSON.stringify(d));",
    "const opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };",
    "const out = v => { console.log(JSON.stringify(v)); save(); process.exit(0); };",
    "const fail = m => { console.error(m); save(); process.exit(1); };",
    "const rev = r => { const x = cp.spawnSync('git', ['--git-dir', d.origin, 'rev-parse', '--verify', '--quiet', r], { encoding: 'utf8', timeout: 30000 }); return x.status === 0 ? x.stdout.trim() : ''; };",
    "d.log.push({ cmd: a.slice(0, 2).join(' '), args: a });",
    "if (a[0] === 'repo' && a[1] === 'view') out({ nameWithOwner: d.repo });",
    "if (a[0] === 'pr' && a[1] === 'view') { const p = d.prs[a[2]]; if (!p) fail('no pull request found'); out(p); }",
    "if (a[0] === 'workflow' && a[1] === 'run') {",
    "  const w = a[2]; const ref = opt('--ref'); const inputs = {};",
    "  a.forEach((x, i) => { if (x === '-f') { const kv = a[i + 1]; const k = kv.slice(0, kv.indexOf('=')); inputs[k] = kv.slice(kv.indexOf('=') + 1); } });",
    "  Object.assign(d.log[d.log.length - 1], { workflow: w, ref, inputs });",
    "  const rule = d.rules[w] || {};",
    "  if (rule.fail) fail('HTTP 422: dispatch refused');",
    "  if (rule.silent) { save(); process.exit(0); }",
    "  const id = d.nextId++; const head = rule.headSha || inputs.expected_sha || rev('refs/heads/' + ref) || rev(ref);",
    "  const run = { databaseId: id, workflow: w, headBranch: ref, headSha: head, status: rule.status || 'completed', conclusion: rule.conclusion === undefined ? 'success' : rule.conclusion,",
    "    url: 'https://example.invalid/runs/' + id, event: rule.event || 'workflow_dispatch', displayTitle: inputs.nonce ? 'E2E Evals [eval-bg ' + inputs.nonce + ']' : w, inputs };",
    "  d.runs.push(run); d.artifacts[id] = {};",
    "  if (rule.record && !inputs.prefix_shas) d.artifacts[id][d.artifact] = { schema: 1, kind: 'train-gate', nonce: rule.record.nonce || inputs.nonce, head_sha: head, tree: rev(head + '^{tree}'),",
    "    verdict: rule.record.verdict || 'GREEN', census: rule.record.census, panels: rule.record.panels };",
    "  if (rule.check && !inputs.prefix_shas) (d.checks[head] = d.checks[head] || []).push({ name: 'gstack/full-gate', status: 'completed', conclusion: rule.check });",
    "  if (rule.bisect && inputs.prefix_shas) for (const sha of inputs.prefix_shas.split(',')) {",
    "    const at = rule.bisect.prefixes.indexOf(sha);",
    "    d.artifacts[id][d.artifact + '-bisect-' + sha.slice(0, 12)] = { schema: 1, kind: 'train-bisect-prefix', nonce: inputs.nonce, prefix_sha: sha, checked_out_sha: sha,",
    "      panels: inputs.cases.split(',').map(c => ({ case: c, kind: 'rule', status: rule.bisect.patterns[c][at] === 'R' ? 'FAIL' : 'PASS', red_class: rule.bisect.patterns[c][at] === 'R' ? 'VERDICT' : null, cost_usd: rule.bisect.costUsd ?? 0.5 })) };",
    "  }",
    "  if (rule.failButCreate) fail('HTTP 502: gateway timeout');",
    "  save(); process.exit(0);",
    "}",
    "if (a[0] === 'run' && a[1] === 'list') {",
    "  const w = opt('--workflow'); const br = opt('--branch'); const ev = opt('--event');",
    "  out(d.runs.filter(r => r.workflow === w && (!br || r.headBranch === br) && (!ev || r.event === ev)).sort((x, y) => y.databaseId - x.databaseId).slice(0, Number(opt('--limit') || 20)));",
    "}",
    "if (a[0] === 'run' && a[1] === 'view') { const r = d.runs.find(x => String(x.databaseId) === a[2]); if (!r) fail('run not found'); out(r); }",
    "if (a[0] === 'run' && a[1] === 'download') {",
    "  const art = (d.artifacts[a[2]] || {})[opt('-n')]; if (!art) fail('no artifact matches');",
    "  fs.mkdirSync(opt('-D'), { recursive: true }); fs.writeFileSync(path.join(opt('-D'), 'record.json'), JSON.stringify(art)); save(); process.exit(0);",
    "}",
    "if (a[0] === 'api') {",
    "  const named = /commits\\/([0-9a-f]+)\\/check-runs\\?check_name=([^&]+)/.exec(a[1] || '');",
    "  if (named) { const list = (d.checks[named[1]] || []).filter(c => c.name === decodeURIComponent(named[2])); out({ total_count: list.length, check_runs: list }); }",
    "  const paged = /commits\\/([0-9a-f]+)\\/(check-runs|status)\\?.*page=(\\d+)/.exec(a[1] || '');",
    "  if (paged) { const list = paged[2] === 'check-runs' ? (d.ci[paged[1]] || []) : []; const key = paged[2] === 'check-runs' ? 'check_runs' : 'statuses';",
    "    out(paged[3] === '1' ? { total_count: list.length, state: 'success', [key]: list } : { total_count: list.length, [key]: [] }); }",
    "}",
    "fail('gh shim: unsupported ' + a.join(' '));",
  ].join('\n') + '\n';
}
