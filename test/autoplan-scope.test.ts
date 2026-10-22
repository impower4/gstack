/**
 * Field wave item 11: /autoplan scope keys on what the Implementation plan
 * changes. UI needs a rendered surface (a rendered file path, or a UI term
 * next to a visual noun); bare UI words and Review-record prose never add the
 * Design phase. Provenance is per axis (flag, marker, detected), `--no-dx`
 * turns DX off, a first-line scope marker in the plan is read (never
 * written), and the interactive path reads the same detector through
 * `gstack-autoplan-snapshot.ts scope`. Runner-level cases run on the
 * simulated Capy host (test/helpers/capy-host.ts).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectScope, detectUiScope, phaseOrder, sectionScopeOff } from '../lib/autoplan-prompts';
import { capyHost } from './helpers/capy-host';
import { AUTOPLAN, ROOT, env, readRun } from './helpers/autoplan-run-fixture';

const host = capyHost({ verifiedBun: '1.4.2' });
afterAll(() => host.cleanup());
let n = 0;
const planFile = (body: string, record = '', firstLine = '') => {
  const dir = path.join(host.base, `plan-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, `${firstLine ? `${firstLine}\n` : ''}# Plan ${n}\n\n## Implementation plan\n\n${body}\n\n## Review record\n\n${record}\n`);
  return file;
};
const hostEnv = () => env({ ...host.env, PATH: host.launchPath, GSTACK_SESSION_KIND: 'unattended', GSTACK_STATE_ROOT: host.stateRoot, GSTACK_HOME: host.stateRoot });
const next = (args: string[]) => spawnSync('bun', [AUTOPLAN, 'next', ...args], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 120_000 });
const snapshotScope = (file: string) => {
  const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-autoplan-snapshot.ts'), 'scope', file], { cwd: ROOT, env: hostEnv(), encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};

const CLI_PROSE = 'The sync component reads frontmatter; a malformed form is held. The doctor screen output (terminal) lists each held file with a status line.';
const DX_PROSE = 'Add a CLI flag --since to the sync command and document the flag in the command help.';

describe('UI evidence is a rendered surface in the Implementation plan', () => {
  test('non-visual CLI prose with UI words is weak evidence: no Design phase, sections still load', () => {
    const r = detectUiScope(CLI_PROSE);
    expect(r.uiRequired).toBe(false);
    expect(r.uiMatches).toBe(3);
    expect(r.uiEvidence).toEqual({ terms: [{ term: 'component', count: 1 }, { term: 'screen', count: 1 }, { term: 'form', count: 1 }], visual: [], files: [] });
    const scope = detectScope(planFile(CLI_PROSE), ROOT, {});
    expect(scope.ui).toBe(false);
    expect(phaseOrder(scope)).not.toContain('design');
    expect(sectionScopeOff('ui', scope)).toBe(false);
  });

  test('UI words only in the Review record give ui=false (Review record prose is not scanned)', () => {
    const scope = detectScope(planFile('Retry the webhook worker with backoff in lib/worker.ts.', 'The Settings page layout gets a new button and a modal; the sidebar nav moves.'), ROOT, {});
    expect(scope.ui).toBe(false);
    expect(scope.ui_matches).toBe(0);
  });

  test('a rendered file path, quoted or backticked, gives ui=true and is printed as evidence', () => {
    expect(detectUiScope('Edit src/components/Settings.tsx to add the toggle.').uiEvidence.files).toEqual(['src/components/Settings.tsx']);
    expect(detectUiScope('Render "app/views/home/index.html.erb" with the new partial.').uiRequired).toBe(true);
    expect(detectUiScope('Move the colors into `web/theme.scss`.').uiEvidence.files).toEqual(['web/theme.scss']);
    expect(detectUiScope('Touch lib/pages.ts and docs/components.md only.').uiRequired).toBe(false);
    expect(detectScope(planFile('Edit src/components/Settings.tsx to add a retry toggle.'), ROOT, {}).ui).toBe(true);
  });

  test('a UI term next to a visual noun is UI; the same term far from one is not', () => {
    const near = detectUiScope('Add a retry button to the settings page.');
    expect(near.uiRequired).toBe(true);
    expect(near.uiEvidence.visual).toEqual(['button~page']);
    expect(detectUiScope('The status layout of the JSON report is stable.').uiRequired).toBe(false);
    expect(detectUiScope('Add a button. Write a long unrelated paragraph about the queue and its retry budget and the man page.').uiRequired).toBe(false);
  });
});

describe('per-axis provenance, --no-dx and the plan marker', () => {
  test('--no-ui alone labels a detected DX as detected, not flag-forced', () => {
    const scope = detectScope(planFile(DX_PROSE), ROOT, { ui: false });
    expect(scope.dx).toBe(true);
    expect(scope.sources).toEqual({ ui: 'flag', dx: 'detected' });
  });

  test('a first-line marker with no CLI flags sets scope from the marker, and the source plan is untouched', () => {
    const file = planFile('Edit src/components/Settings.tsx to add a retry toggle.', '', '<!-- gstack-autoplan-scope: --no-ui --developer-tool -->');
    const before = fs.readFileSync(file);
    const scope = detectScope(file, ROOT, {});
    expect(scope).toMatchObject({ ui: false, dx: true, developer_tool: true, sources: { ui: 'marker', dx: 'marker' }, pin: null });
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(() => detectScope(planFile('x', '', '<!-- gstack-autoplan-scope: --bogus -->'), ROOT, {})).toThrow(/unknown scope flag --bogus/);
  });

  test('runner: CLI flags print SCOPE evidence and a SCOPE_PIN hint, never write the plan, and persist in run.json', () => {
    const file = planFile(`${DX_PROSE} ${CLI_PROSE}`);
    const before = fs.readFileSync(file);
    const out = path.join(host.base, 'run-pin');
    const r = next(['--out', out, '--plan', file, '--no-ui', '--developer-tool']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SCOPE: ui=no \(terms: component×1, screen×1, form×1; visual: none; files: none\) dx=yes \(detected: [^)]*flag×2[^)]*\) source=ui:flag,dx:flag$/m);
    expect(r.stdout).toContain(`SCOPE_PIN: add <!-- gstack-autoplan-scope: --no-ui --developer-tool --> as the first line of ${file} to keep these flags`);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(readRun(out).scope).toMatchObject({ cli_flags: ['--no-ui', '--developer-tool'], marker: null, sources: { ui: 'flag', dx: 'flag' } });
    expect(r.stdout).toContain('source=ui:flag,dx:flag; checklist=');
  });

  test('runner: a marker that already says the CLI flags prints no SCOPE_PIN', () => {
    const file = planFile(DX_PROSE, '', '<!-- gstack-autoplan-scope: --developer-tool --no-ui -->');
    const r = next(['--out', path.join(host.base, 'run-pinned'), '--plan', file, '--no-ui', '--developer-tool']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^SCOPE: .* source=ui:flag,dx:flag$/m);
    expect(r.stdout).not.toContain('SCOPE_PIN:');
  });

  test('runner: --no-dx removes the DX phase from a plan whose terms detect it', () => {
    const r = next(['--out', path.join(host.base, 'run-nodx'), '--plan', planFile(DX_PROSE), '--no-ui', '--no-dx']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PHASE: ceo snapshot=[0-9a-f]{64} order=ceo,eng$/m);
    expect(r.stdout).toMatch(/^SCOPE: ui=no .* dx=no .* source=ui:flag,dx:flag$/m);
  });
});

describe('interactive parity: one detector', () => {
  test('snapshot scope returns uiRequired with its evidence', () => {
    expect(snapshotScope(planFile('Edit src/components/Settings.tsx.'))).toMatchObject({ uiRequired: true, uiEvidence: { files: ['src/components/Settings.tsx'] } });
    expect(snapshotScope(planFile(CLI_PROSE, 'The Settings page layout gets a new button.'))).toMatchObject({ uiRequired: false, uiMatches: 3 });
  });

  test('autoplan Step 2 takes UI scope from the returned uiRequired instead of a prose grep', () => {
    const step2 = fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'), 'utf8').split('### Step 2: Read context')[1]!.split('### Step 3:')[0]!;
    expect(step2).toContain('`uiRequired`');
    expect(step2).not.toMatch(/grep the plan/i);
    expect(fs.readFileSync(path.join(ROOT, 'autoplan', 'SKILL.md'), 'utf8')).toContain('`uiRequired`');
  });
});
