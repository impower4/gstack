/**
 * gstack-config plan_mode_preamble (#3168): on | off, default on.
 *
 * off makes ./setup render every installed skill without the plan-mode
 * preamble (--plan-mode=off). The key is a closed domain like explain_level:
 * an unknown value warns and stores on. Setting it outside ./setup says the
 * change lands on the next setup run and prints the command that applies it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runBin } from './helpers/run-bin';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_CONFIG = path.join(ROOT, 'bin', 'gstack-config');

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-plan-mode-cfg-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string | undefined> = { GSTACK_SETUP_RUNNING: undefined }) {
  return runBin(BIN_CONFIG, args, { gstackHome: tmpHome, cwd: ROOT, trim: true, env });
}

describe('gstack-config plan_mode_preamble', () => {
  test('defaults to on, in get, list and defaults', () => {
    expect(run(['get', 'plan_mode_preamble']).stdout).toBe('on');
    expect(run(['defaults']).stdout).toMatch(/plan_mode_preamble:\s+on$/m);
    expect(run(['list']).stdout).toMatch(/plan_mode_preamble:\s+on \(default\)$/m);
  });

  test('accepts off and on', () => {
    expect(run(['set', 'plan_mode_preamble', 'off']).status).toBe(0);
    expect(run(['get', 'plan_mode_preamble']).stdout).toBe('off');
    expect(run(['list']).stdout).toMatch(/plan_mode_preamble:\s+off \(set\)$/m);
    expect(run(['set', 'plan_mode_preamble', 'on']).status).toBe(0);
    expect(run(['get', 'plan_mode_preamble']).stdout).toBe('on');
  });

  test('an unknown value warns and stores on', () => {
    run(['set', 'plan_mode_preamble', 'off']);
    const junk = run(['set', 'plan_mode_preamble', 'false']);
    expect(junk.status).toBe(0);
    expect(junk.stderr).toContain("plan_mode_preamble 'false' not recognized. Valid values: on, off. Using on.");
    expect(run(['get', 'plan_mode_preamble']).stdout).toBe('on');
  });

  test('outside setup, set says it applies on the next ./setup run and gives the command', () => {
    const r = run(['set', 'plan_mode_preamble', 'off']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`gstack-config: plan_mode_preamble=off applies on the next ./setup run. Apply now: cd ${ROOT} && ./setup --refresh-registered`);
  });

  test('inside setup, set prints nothing', () => {
    const r = run(['set', 'plan_mode_preamble', 'off'], { GSTACK_SETUP_RUNNING: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  test('the config header documents the key and its values', () => {
    run(['set', 'plan_mode_preamble', 'on']);
    const cfg = fs.readFileSync(path.join(tmpHome, 'config.yaml'), 'utf-8');
    expect(cfg).toContain('# plan_mode_preamble: on');
    expect(cfg).toContain('# off = rendered skills omit the "Plan Mode Safe');
  });
});
