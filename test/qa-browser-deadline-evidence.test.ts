import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertQaBrowserDeadline, assertQaBrowserPreparation, assertQaBrowserCheckpoints, qaDeadlineShellPolicy } from './helpers/qa-browser-deadline-evidence';
import capturedPreparation from './fixtures/qa-only-charter-public.json';
import capturedObservation from './fixtures/qa-only-observation-public.json';
import capturedStop from './fixtures/qa-only-stop-cleanup-public.json';
import capturedBookkeeping from './fixtures/qa-only-bookkeeping-joins-public.json';

const ROOT = path.resolve(import.meta.dir, '..');
const guard = path.join(ROOT, 'bin/gstack-qa-deadline');
const browse = process.execPath;
const directories: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function fixture(expectedBudgetMs = 30000) {
  const started = Date.now();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-gate-'));
  directories.push(directory);
  fs.mkdirSync(path.join(directory, 'qa/sections'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'qa/sections/browser-setup.md'), path.join(directory, 'qa/sections/browser-setup.md'));
  fs.mkdirSync(path.join(directory, 'qa-reports/screenshots'), { recursive: true });
  const policy = qaDeadlineShellPolicy(directory, guard, browse);
  const calls: Array<{ tool: string; input: any; output: string }> = [];
  const invoke = (args: string[], expected = 0, timeout = 5000) => {
    const command = ['bun', guard, ...args].map(quote).join(' ');
    const result = spawnSync('bash', ['-c', command], { cwd: directory, encoding: 'utf8', timeout });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(expected);
    calls.push({ tool: 'Bash', input: { command }, output: result.stdout + result.stderr });
  };
  invoke(['start', policy.file, String(expectedBudgetMs / 1000)]);
  const run = () => invoke(['run', policy.file, '--', browse, '--version']);
  const check = (ended = Date.now()) => assertQaBrowserDeadline(calls, { directory, guard, browse, started, ended, expectedBudgetMs });
  return { directory, policy, calls, invoke, run, check, started };
}

test.each(['captured-rewrite', 'verbatim-text', 'decoded-json', 'wrapped-json', 'missing-ack', 'late-write', 'disk-mismatch', 'wrong-command', 'receipt-in-observed'])
  ('browser checkpoints bind actual public results and acknowledgments: %s', scenario => {
    const f = fixture();
    const events = JSON.parse(JSON.stringify(capturedObservation.events)
      .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard).replaceAll('__QA_BROWSE__', browse));
    const baseline = events[1].message.content[0];
    const write = events[2].message.content[0];
    const note = JSON.parse(write.input.content);
    const lines = baseline.content.split('\n');
    const first = lines.findIndex((line: string) => line.startsWith('QA_DEADLINE '));
    const last = lines.findLastIndex((line: string) => line.startsWith('QA_DEADLINE '));
    if (scenario !== 'captured-rewrite') note.observed = lines.slice(first + 1, last).join('\n');
    if (scenario === 'decoded-json' || scenario === 'wrapped-json') {
      baseline.content = lines[first] + '\n{"nested":{"value":7}}\n\n' + lines[last];
      note.observed = scenario === 'decoded-json' ? { nested: { value: 7 } } : { result: { nested: { value: 7 } } };
    }
    if (scenario === 'receipt-in-observed') note.observed += lines[last];
    if (scenario === 'wrong-command') note.observationCommand = 'another command';
    write.input.content = JSON.stringify(note);
    fs.writeFileSync(write.input.file_path, scenario === 'disk-mismatch' ? '{}' : write.input.content);
    if (scenario === 'missing-ack') events.splice(3, 1);
    if (scenario === 'late-write') events.push(...events.splice(2, 2));
    const check = () => assertQaBrowserCheckpoints(events, { directory: f.directory, guard, browse });
    if (scenario === 'verbatim-text' || scenario === 'decoded-json') expect(check).not.toThrow();
    else expect(check).toThrow();
  });

// CI run 37252022510 (qa-only-no-fix): after its last probe the agent closed the tab
// through the guard, as the fixture prompt directs, and the clock had expired.
test.each(['cleanup-after-last-probe', 'cleanup-direct-argv', 'probe-after-cleanup', 'compound-cleanup', 'other-browser-cleanup'])
  ('guarded browser cleanup after the last probe needs no checkpoint; anything more is a probe: %s', scenario => {
    const f = fixture();
    const events = JSON.parse(JSON.stringify(capturedObservation.events)
      .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard).replaceAll('__QA_BROWSE__', browse));
    const baseline = events[1].message.content[0], write = events[2].message.content[0];
    const lines = baseline.content.split('\n');
    const first = lines.findIndex((line: string) => line.startsWith('QA_DEADLINE '));
    const last = lines.findLastIndex((line: string) => line.startsWith('QA_DEADLINE '));
    write.input.content = JSON.stringify({ ...JSON.parse(write.input.content), observed: lines.slice(first + 1, last).join('\n') });
    fs.writeFileSync(write.input.file_path, write.input.content);
    const child = scenario === 'cleanup-direct-argv' ? quote(browse) + ' closetab'
      : `bash -c 'B="${scenario === 'other-browser-cleanup' ? '/usr/bin/true' : browse}"; "$B" closetab${scenario === 'compound-cleanup' ? '; "$B" goto http://127.0.0.1:1/' : ''}'`;
    const expired = events[5].message.content[0].content;
    const cleanup = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_cleanup', name: 'Bash', input: { command: `bun ${quote(guard)} run ${quote(path.join(f.directory, 'qa-reports/deadline.json'))} -- ${child}` } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_cleanup', content: expired, is_error: true }] } },
    ];
    if (scenario === 'probe-after-cleanup') events.splice(4, 0, ...cleanup); else events.push(...cleanup);
    const check = () => assertQaBrowserCheckpoints(events, { directory: f.directory, guard, browse });
    if (['cleanup-after-last-probe', 'cleanup-direct-argv'].includes(scenario)) expect(check).not.toThrow();
    else expect(check).toThrow(scenario === 'probe-after-cleanup' ? 'browser cleanup preceded a probe' : 'follow-up lacks one acknowledged preceding checkpoint');
  });

// PR #3272 Opus gate 39217387697 slice 8 (qa-only-no-fix, head 3986ac5): two guarded probes with one
// checkpoint, then the browser stopped inside the guard. stop is cleanup like closetab; a disguised probe is not.
test.each(['captured', 'unquoted-variable', 'direct-argv', 'closetab-then-stop', 'stop-before-probe', 'disguised-probe', 'other-verb'])
  ('guarded "$B" stop after the last probe is cleanup: %s', scenario => {
    const f = fixture();
    const events = JSON.parse(JSON.stringify(capturedStop.events)
      .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard).replaceAll('__QA_BROWSE__', browse));
    const write = events[2].message.content[0];
    fs.writeFileSync(write.input.file_path, write.input.content);
    const stop = events[6].message.content[0];
    const prefix = `bun ${quote(guard)} run ${quote(path.join(f.directory, 'qa-reports/deadline.json'))} -- `;
    expect(stop.input.command).toBe(prefix + `bash -c 'B="${browse}"; "$B" stop'`);
    const child = ({
      'unquoted-variable': `bash -c 'B="${browse}"; $B stop'`,
      'direct-argv': quote(browse) + ' stop',
      'disguised-probe': `bash -c 'B="${browse}"; "$B" goto http://127.0.0.1:1/; "$B" stop'`,
      'other-verb': `bash -c 'B="${browse}"; "$B" stop --all'`,
    } as Record<string, string>)[scenario];
    if (child) stop.input.command = prefix + child;
    if (scenario === 'closetab-then-stop') {
      const closetab = structuredClone(events.slice(6, 8));
      closetab[0].message.content[0].id = closetab[1].message.content[0].tool_use_id = 'toolu_closetab';
      closetab[0].message.content[0].input.command = prefix + `bash -c 'B="${browse}"; "$B" closetab'`;
      events.splice(6, 0, ...closetab);
    }
    if (scenario === 'stop-before-probe') events.splice(4, 0, ...events.splice(6, 2));
    const check = () => assertQaBrowserCheckpoints(events, { directory: f.directory, guard, browse });
    if (['captured', 'unquoted-variable', 'direct-argv', 'closetab-then-stop'].includes(scenario)) expect(check).not.toThrow();
    else expect(check).toThrow(scenario === 'stop-before-probe' ? 'browser cleanup preceded a probe' : 'follow-up lacks one acknowledged preceding checkpoint');
  });

test.each([['direct', (b: string) => `${quote(b)} stop`], ['shell variable', (b: string) => `B=${quote(b)}; "$B" stop`]])
  ('browser stop outside the guard is not cleanup: %s', (_, command) => {
    const f = fixture();
    f.run();
    f.calls.push({ tool: 'Bash', input: { command: command(browse) }, output: '' });
    expect(() => f.check()).toThrow('QA deadline: ');
  });

test('the deadline prompt names both accepted cleanup children', () => {
  const { policy } = fixture();
  expect(policy.prompt).toContain('exactly "$B" closetab or "$B" stop');
});

test('R70 retained public ordering has no completed report Write before its clock/baseline', () => {
  const f = fixture();
  const events = JSON.parse(JSON.stringify(capturedPreparation.events)
    .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard));
  expect(capturedPreparation.sourceEventIndices).toEqual([461, 465, 546, 550, 1041, 1045, 1965, 1969]);
  expect(events[5].message.content[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } });
  expect(() => assertQaBrowserPreparation(events, { directory: f.directory, guard })).toThrow('report Write must complete before guard start/baseline');
});

test('the deadline prompt orders the charter Write before the one 30-second start', () => {
  const { policy } = fixture();
  const report = path.join(path.dirname(policy.file), 'qa-only-report.md');
  const start = policy.prompt.split('\n').find(line => line.startsWith('Start exactly once'))!;
  expect(start).toContain(`your Write of the initial charter to ${report} has completed`);
  expect(start.endsWith(`bun ${quote(guard)} start ${quote(policy.file)} 30`)).toBe(true);
  expect(start.indexOf('Write of the initial charter')).toBeLessThan(start.indexOf(' start '));
});

test.each(['early', 'failed', 'unacknowledged', 'wrong-path', 'after-start', 'delayed-ack', 'subagent',
  'crossed-parent', 'duplicate-use', 'duplicate-result', 'wrong-result-id', 'empty', 'malformed-content', 'malformed-result'])
  ('preparation credit requires an owned acknowledged nonempty Write: %s', scenario => {
    const f = fixture();
    const captured = JSON.parse(JSON.stringify(capturedPreparation.events)
      .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard));
    const write = captured.at(-2), receipt = captured.at(-1);
    write.message.content[0].input.content = 'Dashboard load: observe the rendered controls and record any incomplete checks.';
    let events = [write, receipt, ...captured.slice(0, -2)];
    if (scenario === 'failed') receipt.message.content[0].is_error = true;
    if (scenario === 'unacknowledged') events.splice(1, 1);
    if (scenario === 'wrong-path') write.message.content[0].input.file_path = path.join(f.directory, 'qa-reports/other.md');
    if (scenario === 'after-start') events = [...events.slice(2, 4), write, receipt, ...events.slice(4)];
    if (scenario === 'delayed-ack') events = [write, ...events.slice(2, 4), receipt, ...events.slice(4)];
    if (scenario === 'subagent') write.parent_tool_use_id = receipt.parent_tool_use_id = 'child';
    if (scenario === 'crossed-parent') receipt.parent_tool_use_id = 'child';
    if (scenario === 'duplicate-use') events.unshift(structuredClone(write));
    if (scenario === 'duplicate-result') events.splice(2, 0, structuredClone(receipt));
    if (scenario === 'wrong-result-id') receipt.message.content[0].tool_use_id = 'unrelated';
    if (scenario === 'empty') write.message.content[0].input.content = ' \n\t';
    if (scenario === 'malformed-content') write.message.content[0].input.content = { text: 'not a Write string' };
    if (scenario === 'malformed-result') receipt.message.content[0].content = [{ type: 'image', source: { type: 'base64', data: 'not a Write receipt' } }];
    const check = () => assertQaBrowserPreparation(events, { directory: f.directory, guard });
    if (scenario === 'early') expect(check).not.toThrow();
    else expect(check).toThrow('QA preparation:');
  });

test('native literal argv, status, scripts, readiness and artifact bookkeeping are accepted', () => {
  const f = fixture();
  const start = f.calls.shift()!;
  for (const command of f.policy.allowed) f.calls.push({ tool: 'Bash', input: { command }, output: 'readiness/bookkeeping' });
  f.calls.push(start);
  f.run();
  f.invoke(['status', f.policy.file]);
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `${quote(browse)} --version | cat; printf '%s\n' 'done'`]);
  f.calls.push({ tool: 'Write', input: { file_path: path.join(f.directory, 'qa-reports/report.md') }, output: '' });
  expect(f.check()).toEqual({ launchedRuns: 2, completedRuns: 2, refusedRuns: 0, timedOutRuns: 0 });
});

// PR gate run 38969924945 (qa-only-no-fix): after saving fallback screenshots into the owned
// directory the prompt names, the agent listed it with this exact spelling.
// GSTA-49: qa-only-no-fix opts into the shared read-only grammar, so pure reads inside the fixture root
// (parent-escape stays inside it, other-subdirectory, extra-option) are accepted; leaving the root or
// composing with a non-read tool is not.
test.each(['captured-screenshots-listing', 'parent-escape', 'other-subdirectory', 'operator', 'extra-option', 'root-escape', 'absolute-outside'])
  ('listing the owned screenshots directory is bookkeeping; nothing wider is: %s', scenario => {
    const f = fixture();
    f.run();
    const screenshots = path.join(f.directory, 'qa-reports/screenshots');
    const commands = {
      'captured-screenshots-listing': `ls -la ${quote(screenshots)}`,
      'parent-escape': `ls -la ${quote(screenshots + '/../..')}`,
      'other-subdirectory': `ls -la ${quote(path.join(f.directory, 'qa/sections'))}`,
      operator: `ls -la ${quote(screenshots)}; ${quote(browse)} --version`,
      'extra-option': `ls -laR ${quote(screenshots)}`,
      'root-escape': `ls -la ${quote(screenshots + '/../../..')}`,
      'absolute-outside': 'ls -la /etc',
    };
    f.calls.push({ tool: 'Bash', input: { command: commands[scenario as keyof typeof commands] }, output: 'total 0' });
    if (['captured-screenshots-listing', 'parent-escape', 'other-subdirectory', 'extra-option'].includes(scenario)) expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
    else expect(() => f.check()).toThrow(scenario === 'operator' ? 'QA deadline: unsupported outer shell composition' : 'QA deadline: untrusted runtime or unguarded command');
  });

test.each(['extra-option', 'suffix-option', 'operator', 'newline', 'foreign-cwd', 'missing-cwd'])
  ('metadata exception stays exact, fixture-bound and unbatched: %s', scenario => {
    const f = fixture();
    f.run();
    const metadata = `git -C ${quote(f.directory)} rev-parse HEAD`;
    const commands = {
      'extra-option': `git -C ${quote(f.directory)} -c color.ui=false rev-parse HEAD`,
      'suffix-option': metadata + ' --git-dir',
      operator: metadata + '; ' + quote(browse) + ' --version',
      newline: metadata + '\n' + metadata,
      'foreign-cwd': `git -C ${quote(path.dirname(f.directory))} rev-parse HEAD`,
      'missing-cwd': 'git rev-parse HEAD',
    };
    f.calls.push({ tool: 'Bash', input: { command: commands[scenario as keyof typeof commands] }, output: 'metadata' });
    expect(() => f.check()).toThrow('QA deadline:');
  });

// Opus gates 39313931713, 39332134395 and 39336730429 (slice 8, attempt 1) failed qa-only-no-fix with
// "unsupported outer shell composition" after joining reads with an exact bookkeeping call, as in
// `ls -la; git -C <fixture> branch --show-current`. Every non-guard Bash command from those three
// attempts and from the eight passing attempts beside them replays inside a real guarded attempt.
const bookkeepingReplay = (f: ReturnType<typeof fixture>, command: string) => command
  .replaceAll('__QA_FIXTURE__', f.directory).replaceAll('__QA_GUARD__', guard).replaceAll('__QA_BROWSE__', browse);
test.each(capturedBookkeeping.attempts.map(attempt => [attempt.source, attempt.passed, attempt.commands] as const))
  ('captured non-guard Bash commands replay as bookkeeping: %s (passed %p)', (_, __, commands) => {
    const f = fixture();
    const start = f.calls.shift()!;
    for (const command of commands) f.calls.push({ tool: 'Bash', input: { command: bookkeepingReplay(f, command) }, output: 'bookkeeping' });
    f.calls.push(start);
    f.run();
    expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
  });

test('the captured joins are the three failing attempts\' only unaccepted commands', () => {
  const failing = capturedBookkeeping.attempts.filter(attempt => !attempt.passed);
  expect(failing.map(attempt => attempt.source.split(' ')[1])).toEqual(['39313931713', '39332134395', '39336730429']);
  expect(failing.flatMap(attempt => attempt.commands.filter(command => /^ls -la; /.test(command)))).toEqual([
    "ls -la; cat TODOS.md 2>/dev/null; git -C '__QA_FIXTURE__' rev-parse --short HEAD",
    "ls -la; git -C '__QA_FIXTURE__' branch --show-current",
    "ls -la; git -C '__QA_FIXTURE__' branch --show-current",
  ]);
});

test.each(['captured', 'two-bookkeeping', 'and-or', 'readiness-check-joined', 'trailing-semicolon',
  'browser-after', 'browser-before', 'guard-joined', 'guard-tail', 'git-option', 'git-other-subcommand', 'pipe-to-shell', 'background',
  'substitution', 'newline', 'cd-then-read', 'read-outside-root', 'dangling-and', 'escaped-semicolon', 'quoted-operator', 'receipt-in-output', 'readiness-block-joined'])
  ('bookkeeping joins accept exact calls and grammar reads only: %s', scenario => {
    const f = fixture();
    f.run();
    const status = `git -C ${quote(f.directory)} status --short`;
    const branch = `git -C ${quote(f.directory)} branch --show-current`;
    const guarded = ['bun', guard, 'run', f.policy.file, '--', browse, '--version'].map(quote).join(' ');
    const commands: Record<string, string> = {
      captured: `ls -la; ${branch}`,
      'two-bookkeeping': `${status}; ${branch}`,
      'and-or': `ls -la qa-reports && ${status} || echo none`,
      'readiness-check-joined': `${f.policy.allowed[3]}; ${branch}`,
      'trailing-semicolon': `ls -la; ${branch};`,
      'browser-after': `ls -la; ${branch}; ${quote(browse)} goto http://127.0.0.1:1/`,
      'browser-before': `${quote(browse)} --version && ${status}`,
      'guard-joined': `${status} && ${guarded}`,
      'guard-tail': `${guarded}; ${status}`,
      'git-option': `ls -la; git -C ${quote(f.directory)} -c core.pager=cat log -1`,
      'git-other-subcommand': `ls -la; git -C ${quote(f.directory)} config --list`,
      'pipe-to-shell': `${status} | sh`,
      background: `${status} & ${quote(browse)} --version`,
      substitution: `ls -la "$(${quote(browse)} --version)"; ${status}`,
      newline: `ls -la\n${status}`,
      'cd-then-read': `cd qa-reports; cat deadline.json; ${status}`,
      'read-outside-root': `cat /etc/hostname; ${status}`,
      'dangling-and': `ls -la; ${status} &&`,
      'escaped-semicolon': `ls -la \\; ${quote(browse)} --version; ${status}`,
      'quoted-operator': `echo 'a; b'; ${status}`,
      'receipt-in-output': `ls -la; ${status}`,
      'readiness-block-joined': `${f.policy.allowed[0]}; ${status}`,
    };
    f.calls.push({ tool: 'Bash', input: { command: commands[scenario] }, output: scenario === 'receipt-in-output' ? 'QA_DEADLINE {"guard":"qa-deadline"}' : 'bookkeeping' });
    if (['captured', 'two-bookkeeping', 'and-or', 'readiness-check-joined', 'trailing-semicolon', 'quoted-operator'].includes(scenario)) expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
    else expect(() => f.check()).toThrow(scenario === 'receipt-in-output' ? 'receipt outside trusted guard invocation' : 'QA deadline:');
  });

test('the deadline prompt declares the bookkeeping join it accepts', () => {
  const { policy } = fixture();
  expect(policy.prompt).toContain('join several of them and the shared-grammar reads below with ;, && or || (no cd in such a join)');
  expect(policy.prompt).toContain('as its own Bash call (no appended commands)');
});

test('quoted question marks stay literal but bare glob expansion is rejected', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.directory, 'x'), 'glob target');
  f.run();
  f.invoke(['run', f.policy.file, '--', '/usr/bin/printf', '%s', '?']);
  const call = f.calls.at(-1)!;
  expect(call.output.startsWith('?')).toBe(true);
  expect(f.check().completedRuns).toBe(2);
  call.input.command = call.input.command.replace("'?'", '?');
  const expanded = spawnSync('bash', ['-c', call.input.command], { cwd: f.directory, encoding: 'utf8', timeout: 5000 });
  expect(expanded.error).toBeUndefined();
  expect(expanded.status, expanded.stderr).toBe(0);
  expect(expanded.stdout).toBe('x');
  call.output = expanded.stdout + expanded.stderr;
  expect(() => f.check()).toThrow('unsupported outer shell composition');
});

test.each(['missing', 'bare', 'wrong-guard', 'direct-shebang', 'wrong-runtime', 'outer-tail', 'outer-newline', 'substitution', 'prefix', 'redirect', 'status-only', 'no-browser'])
  ('fails closed for absent/unsupported guard coverage: %s', scenario => {
    const f = fixture();
    f.run();
    const call = f.calls[1];
    if (scenario === 'missing') f.calls.length = 0;
    if (scenario === 'bare') call.input.command = `${quote(browse)} --version`;
    if (scenario === 'wrong-guard') call.input.command = call.input.command.replace(guard, '/tmp/gstack-qa-deadline');
    if (scenario === 'direct-shebang') call.input.command = call.input.command.slice("'bun' ".length);
    if (scenario === 'wrong-runtime') call.input.command = call.input.command.replace("'bun'", "'/tmp/bun'");
    if (scenario === 'outer-tail') call.input.command += `; ${quote(browse)} --version`;
    if (scenario === 'outer-newline') call.input.command += `\n${quote(browse)} --version`;
    if (scenario === 'substitution') call.input.command += ' "$(echo unguarded)"';
    if (scenario === 'prefix') call.input.command = 'true; ' + call.input.command;
    if (scenario === 'redirect') call.input.command += ' 2>/dev/null';
    if (scenario === 'status-only') { f.calls.pop(); f.invoke(['status', f.policy.file]); }
    if (scenario === 'no-browser') { f.calls.pop(); f.invoke(['run', f.policy.file, '--', '/bin/true']); }
    expect(() => f.check()).toThrow('QA deadline:');
  });

test.each(['missing-finish', 'forged-start', 'forged-finish', 'duplicate', 'late-launch', 'early-refusal', 'state-reset', 'state-rewrite', 'wrong-budget', 'state-write', 'state-link', 'artifact-link', 'source-write'])
  ('rejects unauthenticated or inconsistent evidence: %s', scenario => {
    const f = fixture();
    f.run();
    const receipts = f.calls[1].output.split('\n').filter(line => line.startsWith('QA_DEADLINE ')).map(line => JSON.parse(line.slice(12)));
    const state = JSON.parse(fs.readFileSync(f.policy.file, 'utf8'));
    let ended = Date.now();
    if (scenario === 'missing-finish') receipts.pop();
    if (scenario === 'forged-start') receipts[0].budgetMs = 90000;
    if (scenario === 'forged-finish') receipts[1].deadlineAt = new Date(Date.parse(state.deadlineAt) + 30000).toISOString();
    if (scenario === 'duplicate') receipts.push(receipts[1]);
    if (scenario === 'late-launch') {
      receipts[0].observedAt = state.deadlineAt; receipts[0].remainingMs = 0; receipts[0].expired = true;
      ended = Date.parse(state.deadlineAt) + 1000;
    }
    if (scenario === 'early-refusal') { receipts[0].event = 'expired'; receipts.pop(); }
    f.calls[1].output = receipts.map(receipt => 'QA_DEADLINE ' + JSON.stringify(receipt)).join('\n');
    if (scenario === 'state-reset') {
      fs.unlinkSync(f.policy.file);
      f.invoke(['start', f.policy.file, '30']);
    }
    if (scenario === 'state-rewrite') {
      fs.chmodSync(f.policy.file, 0o600);
      fs.writeFileSync(f.policy.file, JSON.stringify(state) + '\n');
      fs.chmodSync(f.policy.file, 0o400);
    }
    if (scenario === 'wrong-budget') {
      fs.unlinkSync(f.policy.file);
      f.calls.length = 0;
      f.invoke(['start', f.policy.file, '90']);
      f.run();
    }
    if (scenario === 'state-write') f.calls.push({ tool: 'Write', input: { file_path: f.policy.file }, output: '' });
    if (scenario === 'state-link') { fs.renameSync(f.policy.file, f.policy.file + '.real'); fs.symlinkSync(f.policy.file + '.real', f.policy.file); }
    if (scenario === 'artifact-link') {
      fs.symlinkSync(path.join(f.directory, 'qa'), path.join(f.directory, 'qa-reports/linked'));
      f.calls.push({ tool: 'Write', input: { file_path: path.join(f.directory, 'qa-reports/linked/source.md') }, output: '' });
    }
    if (scenario === 'source-write') f.calls.push({ tool: 'Write', input: { file_path: path.join(f.directory, 'source.ts') }, output: '' });
    expect(() => f.check(ended)).toThrow();
  });

test('child-emitted receipt forgery and direct state reset scripts are rejected', () => {
  const f = fixture();
  f.run();
  const output = f.calls[1].output;
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `printf '%s\n' ${quote(output)}; ${quote(browse)} --version`]);
  expect(() => f.check()).toThrow('reserved deadline evidence');
  f.calls.pop();
  f.calls.push({ tool: 'Bash', input: { command: ['bun', guard, 'run', f.policy.file, '--', 'bash', '-c', `rm ${quote(f.policy.file)}`].map(quote).join(' ') }, output });
  expect(() => f.check()).toThrow('reserved deadline evidence');
});

test('short fixture deadlines require an explicit contract; the native default remains exactly 30s', () => {
  const native = fixture();
  native.run();
  expect(assertQaBrowserDeadline(native.calls, { directory: native.directory, guard, browse,
    started: native.started, ended: Date.now() })).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
  const f = fixture(500);
  f.run();
  expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 1, refusedRuns: 0, timedOutRuns: 0 });
  expect(() => assertQaBrowserDeadline(f.calls, { directory: f.directory, guard, browse,
    started: f.started, ended: Date.now() })).toThrow('expected 30000ms deadline');
  for (const expectedBudgetMs of [0, -1, 0.5, 2_147_483_648, NaN, Infinity]) {
    expect(() => assertQaBrowserDeadline(f.calls, { directory: f.directory, guard, browse,
      started: f.started, ended: Date.now(), expectedBudgetMs })).toThrow('invalid expected deadline budget');
  }
  f.calls[0].input.command = f.calls[0].input.command.replace("'0.5'", "'30'");
  expect(() => f.check()).toThrow('missing or repeated native start');
});

test('native timeout and subsequent refusal get no completed-run credit; bare late work still fails', async () => {
  const f = fixture(500);
  const pidFile = path.join(f.directory, 'child.pid');
  const lateMarker = path.join(f.directory, 'late-work');
  const refusalMarker = path.join(f.directory, 'refused-work');
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `printf '%s' "$$" > ${quote(pidFile)}; sleep 2; ${quote(browse)} --version > ${quote(lateMarker)}`], 124);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  const reapedBy = performance.now() + 500;
  let reaped = false;
  while (performance.now() < reapedBy) {
    try { process.kill(pid, 0); }
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      reaped = true;
      break;
    }
    await Bun.sleep(10);
  }
  expect(reaped).toBe(true);
  expect(fs.existsSync(lateMarker)).toBe(false);
  f.invoke(['run', f.policy.file, '--', 'bash', '-c', `touch ${quote(refusalMarker)}; ${quote(browse)} --version`], 124);
  expect(fs.existsSync(refusalMarker)).toBe(false);
  expect(f.check()).toEqual({ launchedRuns: 1, completedRuns: 0, refusedRuns: 1, timedOutRuns: 1 });
  f.calls.push({ tool: 'Bash', input: { command: `${quote(browse)} --version` }, output: 'late bare work' });
  expect(() => f.check()).toThrow('unguarded');
});

test.each([
  `B="/workspace/gstack/browse/dist/browse"\n$B js "(async () => { const links = [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href))].filter(h => new URL(h).origin === location.origin && !/logout|signout|delete|remove|cancel|unsubscribe/i.test(h)); const out = []; for (const l of links) { const r = await fetch(l, { method: 'HEAD' }).catch(e => ({ status: 'ERR ' + e.message })); out.push('LINK ' + r.status + ' ' + l); } return out.join('\\n'); })()" 2>&1\necho "=== ALL HREFS ==="; $B links 2>&1`,
  `echo "CLOCK=$(date -u +%Y-%m-%dT%H:%M:%SZ)"\nB="/workspace/gstack/browse/dist/browse"\ntimeout 20 $B js "(async()=>{const links=[...new Set([...document.querySelectorAll('a[href]')].map(a=>a.href))].filter(h=>new URL(h).origin===location.origin&&!/logout|signout|delete|remove|cancel|unsubscribe/i.test(h));const out=[];for(const l of links){const r=await fetch(l,{method:'HEAD'}).catch(e=>({status:'ERR '+e.message}));out.push('LINK '+r.status+' '+l);}const imgs=[...document.images].map(i=>'IMG '+(i.complete&&i.naturalWidth>0?'ok':'broken')+' '+i.src);return out.concat(imgs).join('\\\\n');})()" 2>&1\necho "CLOCK_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
])('R65/R66 public late-link commands fail even after genuine guarded work: %#', command => {
  const f = fixture();
  f.run();
  f.calls.push({ tool: 'Bash', input: { command }, output: 'CLOCK=2026-09-27T14:33:12Z' });
  expect(() => f.check()).toThrow('QA deadline:');
});
