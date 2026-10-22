/**
 * Field list 2, W7: lane durability for unattended /autoplan on the simulated
 * Capy host. With GSTACK_AUTOPLAN_CHECKPOINT_DIR unset the runner prints the
 * export line naming the private project-user Drive folder and writes nothing
 * there; `gstack-config set autoplan_checkpoint drive` opts in. A generation is
 * published after each bound voice and phase transition, and a run restored
 * from one never redispatches a voice it had bound. The coordinator contract
 * and /ship's handoff carry the WIP-push rule. Every spawn has a timeout.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { capyDriveFolder } from '../lib/autoplan-checkpoint';
import { COORDINATOR_CONTRACT } from '../lib/coordinator-contract';
import { ROOT } from './helpers/autoplan-run-fixture';
import { capyRunner, readRunJson, writePlan } from './helpers/autoplan-capy';

const r = capyRunner();
afterAll(() => r.cleanup());
const drive = path.join(r.host.home, '.capy', 'drive', 'project-user-demo-garry');
fs.mkdirSync(drive, { recursive: true });
const folder = path.join(drive, 'autoplan-checkpoints');
const config = (value: string) => spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-config'), 'set', 'autoplan_checkpoint', value], { env: r.env, encoding: 'utf8', timeout: 30_000 });
let n = 0;
const start = () => { const dir = path.join(r.host.base, `dur${++n}`); const out = path.join(dir, 'run'); return { dir, out, first: r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui']) }; };

describe('checkpoints on Capy', () => {
  test('unset: the first next prints the export line for the project-user Drive folder and writes nothing there', () => {
    const { first } = start();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toContain(`CHECKPOINT: unset; to survive machine replacement: export GSTACK_AUTOPLAN_CHECKPOINT_DIR=${folder} (or for every run: gstack-config set autoplan_checkpoint drive)`);
    expect(fs.existsSync(folder)).toBe(false);
  });

  test('opted in: a generation after each bound voice and transition; a restored run keeps the bound voice and redispatches only the other', () => {
    expect(config('drive').status).toBe(0);
    try {
      const { dir, out, first } = start();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toMatch(/^CHECKPOINT: \S+ status=awaiting_result /m);
      const run = readRunJson(out);
      const collection = path.join(folder, run.run);
      expect(fs.existsSync(path.join(collection, 'current.json'))).toBe(true);
      expect(r.review(path.join(out, 'ceo-native-prompt.md'), { FIXTURE_FINDINGS: '[]' }).status).toBe(0);
      const bound = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', run.phases.ceo.native.attempts[0].result, '--model', 'anthropic/claude-opus-5-5', '--attempt', run.phases.ceo.native.attempt]);
      expect(bound.status, bound.stderr).toBe(0);
      expect(bound.stderr).toMatch(/^CHECKPOINT: \S+ status=awaiting_result gate_rev=0 revision=\d+ /m);
      const restored = path.join(dir, 'restored');
      const resume = r.ap(['resume', '--out', restored, '--from', collection]);
      expect(resume.status, resume.stderr).toBe(0);
      expect(resume.stdout).toMatch(/^EXECUTION_UNKNOWN: \S+-a2$/m);
      const back = readRunJson(restored);
      expect(back.phases.ceo.native.status).toBe('completed');
      const refused = r.ap(['next', '--out', restored]);
      expect(refused.status).toBe(3);
      expect(refused.stderr).toMatch(/\S+-a2 \(ceo outside\).*\(EXECUTION_UNKNOWN\)$/m);
      const again = r.ap(['next', '--out', restored, '--redispatch', back.phases.ceo.outside.attempt]);
      expect(again.status, again.stderr).toBe(0);
      expect(again.stdout.match(/^ATTEMPT: /gm)).toHaveLength(1);
      expect(again.stdout).toMatch(/^ATTEMPT: \S+-a3 phase=ceo voice=outside /m);
      expect(readRunJson(restored).phases.ceo.native.attempt).toBe(run.phases.ceo.native.attempt);
    } finally {
      config('off');
    }
  });

  test('opted in: the next that opens a phase mid-run publishes a generation', () => {
    expect(config('drive').status).toBe(0);
    try {
      const { out, first } = start();
      expect(first.status, first.stderr).toBe(0);
      const run = readRunJson(out);
      for (const voice of ['native', 'outside'] as const) {
        expect(r.review(path.join(out, `ceo-${voice}-prompt.md`), { FIXTURE_FINDINGS: '[]' }).status).toBe(0);
        const bound = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', voice, '--result', run.phases.ceo[voice].attempts[0].result, '--model', voice === 'native' ? 'anthropic/claude-opus-5-5' : 'openai/gpt-6.1-sol', '--attempt', run.phases.ceo[voice].attempt]);
        expect(bound.status, bound.stderr).toBe(0);
      }
      const current = () => JSON.parse(fs.readFileSync(path.join(folder, run.run, 'current.json'), 'utf8'));
      const before = current().generation;
      const opened = r.ap(['next', '--out', out]);
      expect(opened.status, opened.stderr).toBe(0);
      expect(opened.stdout).toMatch(/^ATTEMPT: \S+ phase=eng voice=native /m);
      expect(opened.stderr).toMatch(/^CHECKPOINT: \S+ status=awaiting_result /m);
      expect(current()).toMatchObject({ status: 'awaiting_result' });
      expect(current().generation).not.toBe(before);
    } finally {
      config('off');
    }
  });

  test('GSTACK_AUTOPLAN_CHECKPOINT_DIR wins over the Drive opt-in', () => {
    expect(config('drive').status).toBe(0);
    try {
      const elsewhere = path.join(r.host.base, 'explicit-checkpoints');
      const dir = path.join(r.host.base, `dur${++n}`);
      const first = r.ap(['next', '--out', path.join(dir, 'run'), '--plan', writePlan(dir), '--no-ui'], { GSTACK_AUTOPLAN_CHECKPOINT_DIR: elsewhere });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toContain(`CHECKPOINT: ${elsewhere}`);
    } finally {
      config('off');
    }
  });
});

describe('capyDriveFolder', () => {
  test('one project-user folder, or the one named for the repo among several; none off Capy or when ambiguous', () => {
    const home = path.join(r.host.base, 'drive-home');
    const env = { GSTACK_CAPY: '1', HOME: home };
    const base = path.join(home, '.capy', 'drive');
    fs.mkdirSync(path.join(base, 'project-user-gstack-garry'), { recursive: true });
    expect(capyDriveFolder(env, 'gstack')).toBe(path.join(base, 'project-user-gstack-garry', 'autoplan-checkpoints'));
    expect(capyDriveFolder({ HOME: home }, 'gstack')).toBeUndefined();
    fs.mkdirSync(path.join(base, 'project-user-gbrain-garry'), { recursive: true });
    expect(capyDriveFolder(env, 'gbrain')).toBe(path.join(base, 'project-user-gbrain-garry', 'autoplan-checkpoints'));
    expect(capyDriveFolder(env)).toBeUndefined();
  });
});

describe('the WIP-push rule', () => {
  test('the coordinator contract and the /ship handoff carry it', () => {
    expect(COORDINATOR_CONTRACT).toContain('A lane pushes a WIP commit to its branch after each step and gates a pushed SHA.');
    expect(fs.readFileSync(path.join(ROOT, 'autoplan', 'DRIVER.md'), 'utf8')).toContain('A lane pushes a WIP commit to its branch after each step and gates a pushed SHA.');
    expect(fs.readFileSync(path.join(ROOT, 'ship', 'sections', 'handoff.md'), 'utf8')).toMatch(/### Multi-lane runs\n\nLanes push a WIP commit after each step and gate a pushed SHA\./);
  });
});
