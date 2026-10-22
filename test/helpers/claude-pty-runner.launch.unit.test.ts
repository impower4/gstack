/**
 * Deterministic unit tests for the PTY launcher (test/helpers/pty/launch.ts).
 * Split along the W4 module seams from the former claude-pty-runner.unit.test.ts;
 * tests import the public barrel, test/helpers/claude-pty-runner.ts.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  type ClaudePtyOptions,
} from './claude-pty-runner';

describe('runPlanSkillObservation env passthrough surface', () => {
  test('ClaudePtyOptions exposes env: Record<string, string>', () => {
    // Type-level guard: this file would fail to compile if the env field
    // were removed or its shape regressed. The actual env merge happens in
    // launchClaudePty's spawn call (`env: { ...process.env, ...opts.env }`),
    // so a regression where `env: opts.env` gets dropped from the
    // runPlanSkillObservation -> launchClaudePty handoff is only caught by
    // the live PTY test, not here.
    const opts: ClaudePtyOptions = {
      env: { QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' },
    };
    expect(opts.env).toEqual({ QUESTION_TUNING: 'false', EXPLAIN_LEVEL: 'default' });
  });
});

describe('launchClaudePty model pin', () => {
  // Behavioral: a fake CLI records the argv its real PTY launch received.
  // Chain mirrors session-runner.ts: opts.model -> EVALS_MODEL ->
  // resolveEvalModel('capture'); --model precedes extraArgs so a per-test
  // --model wins (last flag wins). Per-runner forwarding of opts.model is
  // asserted through the fake driver in claude-pty-runner.runners.unit.test.ts.
  test('ClaudePtyOptions exposes model?: string', () => {
    const opts: ClaudePtyOptions = { model: 'claude-sonnet-4-6' };
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  test.skipIf(process.platform === 'win32')('spawn args pin --model from the fallback chain, before extraArgs, with hermetic MCP gating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pty-model-pin-'));
    try {
      const fake = join(dir, 'fake-claude');
      writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('ARGV=' + JSON.stringify(process.argv.slice(2)) + '\\n');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
      const runner = pathToFileURL(join(import.meta.dir, 'claude-pty-runner.ts')).href;
      const worker = join(dir, 'worker.ts');
      writeFileSync(worker, `import { launchClaudePty } from ${JSON.stringify(runner)};
import { resolveEvalModel } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, '../../lib/eval-model.ts')).href)};
const argv = async (opts, evalsModel) => {
  if (evalsModel === undefined) delete process.env.EVALS_MODEL; else process.env.EVALS_MODEL = evalsModel;
  const session = await launchClaudePty({ cwd: ${JSON.stringify(dir)}, timeoutMs: 5000, ...opts });
  try { await session.waitFor(/ARGV=\\[.*\\]/, { timeoutMs: 4000, pollMs: 20 }); return JSON.parse(/ARGV=(\\[.*\\])/.exec(session.visibleText())[1]); }
  finally { await session.close(); }
};
process.stdout.write(JSON.stringify({ capture: resolveEvalModel('capture'),
  fallback: await argv({}, undefined), env: await argv({}, 'env-model'), explicit: await argv({ model: 'opts-model' }, 'env-model'),
  extra: await argv({ extraArgs: ['--model', 'override'] }, undefined) }));
`);
      const run = (hermetic: string) => {
        const result = spawnSync(process.execPath, [worker], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, BROWSE_TERMINAL_BINARY: fake, EVALS_HERMETIC: hermetic } });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      };
      const hermetic = run('1');
      const model = (args: string[]) => args[args.indexOf('--model') + 1];
      expect(model(hermetic.fallback)).toBe(hermetic.capture);
      expect(model(hermetic.env)).toBe('env-model');
      expect(model(hermetic.explicit)).toBe('opts-model');
      expect(hermetic.extra.indexOf('--model')).toBeLessThan(hermetic.extra.lastIndexOf('--model'));
      expect(hermetic.extra.slice(-2)).toEqual(['--model', 'override']);
      expect(hermetic.fallback).toContain('--strict-mcp-config');
      expect(run('0').fallback).not.toContain('--strict-mcp-config');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
