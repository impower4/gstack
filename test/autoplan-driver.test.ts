/**
 * Field wave item 13: autoplan/DRIVER.md is the compact, host-neutral entry a
 * parent agent reads to drive /autoplan through `gstack-autoplan`. It is
 * generated from autoplan/DRIVER.md.tmpl by resolvers that read the code
 * (phase order, scope flags, run files, RESULT FORMAT, result codes, the
 * coordinator contract), stays under 160 lines with no harness vocabulary,
 * is in the generator's normal, out-dir and dry-run inventories, and is
 * found from an installed root through its recorded `.source-path`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FILES } from '../lib/autoplan-state';
import { PHASES, RESULT_FORMAT } from '../lib/autoplan-prompts';
import { SCOPE_FLAG_TOKENS } from '../lib/autoplan-scope';
import { COORDINATOR_CONTRACT } from '../lib/coordinator-contract';
import { parseReply, type GateList } from '../lib/gate-list';
import { resolveSourceRoot } from '../lib/source-root';
import { AUTOPLAN_DRIVER_COMMANDS, DRIVER_CODES, GATE_REPLY_FORMS } from '../scripts/resolvers/autoplan-driver';
import { runGeneration } from '../scripts/gen-skill-docs';
import { capyHost } from './helpers/capy-host';
import { AUTOPLAN, ROOT, SMALL_PLAN, env } from './helpers/autoplan-run-fixture';

const DRIVER = path.join(ROOT, 'autoplan', 'DRIVER.md');
const doc = fs.readFileSync(DRIVER, 'utf8');
const host = capyHost({ verifiedBun: '1.4.2' });
afterAll(() => host.cleanup());
const hostEnv = () => env({ ...host.env, PATH: host.launchPath, GSTACK_STATE_ROOT: host.stateRoot, GSTACK_HOME: host.stateRoot });

describe('autoplan/DRIVER.md content comes from the code', () => {
  test('phase order, scope flags, run files, RESULT FORMAT, result codes and the coordinator contract are rendered', () => {
    expect(doc).toContain(`Order: ${PHASES.join(' → ')}.`);
    for (const flag of SCOPE_FLAG_TOKENS) expect(doc).toContain(`\`${flag}\``);
    for (const file of Object.values(FILES)) expect(doc).toContain(`\`${file}\``);
    expect(doc).toContain(RESULT_FORMAT('<phase>', '<snapshot sha256>', '<result file>').replace(/^\n---\n/, '').trimEnd());
    for (const code of DRIVER_CODES) expect(doc).toMatch(new RegExp(`^- \`${code}\`: \\S`, 'm'));
    expect(doc).toContain(COORDINATOR_CONTRACT);
    for (const c of AUTOPLAN_DRIVER_COMMANDS) expect(doc).toContain(`- \`${c.cmd}\``);
    for (const f of GATE_REPLY_FORMS) expect(doc).toContain(`- \`${f.reply}\`: `);
  });

  test('the plan-specified commands and the amendment interlock are present', () => {
    for (const token of ['submit --out <dir> --phase <p> --voice native|outside --record', '--attest "<reason>"', '--unavailable|--failed',
      'revise --out <dir> --plan <plan v2> --incorporates <decision ids>', '--withdraw <decision id>', '[--scaffold]', '`--no-dx`', '`as-is`', '`rec`', 'render <dir>/gate.json --all', '--settle <decision id|d4>', '--owner-reply', '--from <checkpoint>', 'PLAN_AMEND_PENDING', 'APPLY:']) {
      expect(doc).toContain(token);
    }
  });

  test('at most 160 lines and no harness vocabulary', () => {
    expect(doc.split('\n').length).toBeLessThanOrEqual(160);
    for (const term of ['PreToolUse', 'PostToolUse', 'SessionStart', 'AskUserQuestion', 'Skill tool']) expect(doc).not.toContain(term);
  });

  test('every flag it names is in gstack-autoplan --help, and the gate forms parse', () => {
    const help = spawnSync('bun', [AUTOPLAN, '--help'], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 30_000 }).stdout;
    const commands = AUTOPLAN_DRIVER_COMMANDS.map(c => c.cmd).join(' ');
    for (const flag of new Set(commands.match(/--[a-z][a-z-]*/g)!)) {
      expect(help.includes(flag), flag).toBe(true);
    }
    const gate: GateList = { schema_version: 1, run: 'r', gate_rev: 1, items: ['d3', 'uc1'].map(id => ({ id, title: id, recommended: 'a', kind: 'auto' as const, options: [{ key: 'a', text: 'keep' }, { key: 'b', text: 'change' }] })) };
    for (const f of GATE_REPLY_FORMS) expect(parseReply(f.reply, gate, 1).valid, f.reply).toBe(true);
    expect(parseReply('yes', gate, 1).valid).toBe(false);
  });
});

describe('where a parent finds it', () => {
  test('gstack-autoplan --help prints DRIVER: <root>/autoplan/DRIVER.md', () => {
    const r = spawnSync('bun', [AUTOPLAN, '--help'], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(r.stdout.split('\n')).toContain(`DRIVER: ${DRIVER}`);
  });

  test('the first next prints the DRIVER line once', () => {
    const dir = path.join(host.base, 'first-next');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plan.md'), SMALL_PLAN);
    const out = path.join(dir, 'run');
    const first = spawnSync('bun', [AUTOPLAN, 'next', '--out', out, '--plan', path.join(dir, 'plan.md'), '--no-ui'], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 120_000 });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.split('\n').filter(l => l.startsWith('DRIVER: '))).toEqual([`DRIVER: ${DRIVER}`]);
    const again = spawnSync('bun', [AUTOPLAN, 'next', '--out', out], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 120_000 });
    expect(again.stdout).not.toContain('DRIVER: ');
  });

  test('an installed copy root resolves DRIVER.md through its recorded .source-path; a stale record falls back to the root', () => {
    const root = path.join(host.base, 'install-root');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
    fs.copyFileSync(AUTOPLAN, path.join(root, 'bin', 'gstack-autoplan'));
    fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts'), path.join(root, 'bin', 'gstack-autoplan-snapshot.ts'));
    fs.writeFileSync(path.join(root, '.source-path'), `${ROOT}\n`);
    const help = spawnSync('bun', [path.join(root, 'bin', 'gstack-autoplan'), '--help'], { cwd: host.base, env: hostEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(help.stdout.split('\n')).toContain(`DRIVER: ${DRIVER}`);
    expect(resolveSourceRoot(root)).toBe(ROOT);
    fs.writeFileSync(path.join(root, '.source-path'), `${path.join(host.base, 'gone')}\n`);
    expect(resolveSourceRoot(root)).toBe(root);
  });
});

describe('generator inventory', () => {
  test('normal, out-dir and dry-run generation all carry autoplan/DRIVER.md, and the committed file is fresh', async () => {
    const outDir = path.join(host.base, 'render');
    const written = await runGeneration({ host: 'claude', outputRoot: outDir, contentLinkRoot: null });
    expect(written.artifacts).toContainEqual({ relativePath: 'autoplan/DRIVER.md', kind: 'asset', host: 'claude' });
    expect(fs.readFileSync(path.join(outDir, 'autoplan', 'DRIVER.md'), 'utf8')).toBe(doc);
    const dry = await runGeneration({ host: 'claude', dryRun: true });
    expect(dry.artifacts).toContainEqual({ relativePath: 'autoplan/DRIVER.md', kind: 'asset', host: 'claude' });
    expect(dry.diagnostics.filter(d => d.relativePath === 'autoplan/DRIVER.md')).toEqual([]);
  }, 120_000);
});
