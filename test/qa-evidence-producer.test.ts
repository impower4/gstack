import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createQAFunctionalFixture, fixtureCommand } from './helpers/qa-functional-fixture';
import { nativeCalls, readQACheckpointFiles, validateQACheckpoints } from './helpers/qa-checkpoint-evidence';
import { qaEvidenceCommand, qaNativeCapture } from './helpers/qa-evidence-producer';
import { observeQAWrites, qaWriteVerdict } from './helpers/qa-functional-observer';
import { parseNDJSON } from './helpers/session-runner';
import { qaFunctionalVerdict, qaNativeProbes } from './helpers/qa-functional-evidence';
import { createQaCallerFixture, validateCallerEvidence } from './helpers/qa-callers-fixture';

function recordedFixture(publicOutput = false, merged = false) {
  const fixture = createQAFunctionalFixture('webhook');
  const reportRoot = path.join(fixture.root, 'qa-reports');
  const context = { cwd: fixture.root, reportRoot, executable: path.join(fixture.root, 'bin/gstack-qa-evidence') };
  const transcript: any[] = [];
  const record = (name: string, input: any, output: string, metadata?: any) => {
    const id = `native-${transcript.length}`;
    transcript.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    transcript.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] }, ...(metadata ? { tool_use_result: metadata } : {}) });
  };
  const execute = (command: string) => {
    const result = spawnSync('bash', ['-c', command], { cwd: fixture.root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, QA_STATE_ROOT: path.join(fixture.root, '.qa-state'), GIT_OPTIONAL_LOCKS: '0' } });
    expect(result.status, result.stderr).toBe(0);
    record('Bash', { command }, result.stdout + result.stderr);
    return result;
  };
  const hypothesis = 'One successful delivery suggests checking replay after an interrupted worker.';
  const first = `bun bin/gstack-qa-evidence capture qa-reports 001 ${publicOutput ? '--public ' : ''}--timeout-ms 10000 -- bun run probe -- happy`;
  const second = `bun bin/gstack-qa-evidence capture qa-reports 002 ${publicOutput ? '--public ' : ''}--timeout-ms 10000 ${merged ? `--after 001 --hypothesis '${hypothesis}' ` : ''}-- bun run probe -- partial`;
  execute(first);
  if (merged && !publicOutput) {
    const view = path.join(reportRoot, '.qa-evidence/001/observation.json');
    const content = fs.readFileSync(view, 'utf8');
    record('Read', { file_path: view }, content.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'),
      { type: 'text', file: { filePath: view, content, startLine: 1, numLines: content.split('\n').length, totalLines: content.split('\n').length } });
  } else if (merged) {}
  else if (publicOutput) execute(`bun bin/gstack-qa-evidence checkpoint qa-reports 001 001 '${first}' '${hypothesis}' '${second}'`);
  else {
    const view = path.join(reportRoot, '.qa-evidence/001/observation.json');
    const content = fs.readFileSync(view, 'utf8');
    record('Read', { file_path: view }, content.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n'),
      { type: 'text', file: { filePath: view, content, startLine: 1, numLines: content.split('\n').length, totalLines: content.split('\n').length } });
    const intent = JSON.stringify({ capture: '001', observationCommand: first, hypothesis, nextCommand: second });
    const intentPath = path.join(reportRoot, 'intent-001.json');
    fs.writeFileSync(intentPath, intent, { mode: 0o600 });
    record('Write', { file_path: intentPath, content: intent }, 'File created successfully');
    execute('bun bin/gstack-qa-evidence checkpoint qa-reports 001 intent-001.json');
  }
  execute(second);
  const probes = nativeCalls(transcript, []).flatMap(call => {
    const capture = qaNativeCapture(call, context);
    return capture ? [{ command: call.input.command, observed: capture.captured.observed }] : [];
  });
  const input = { transcript, reportRoot, producer: context, probes, requiredProbes: probes.slice(1),
    files: readQACheckpointFiles(reportRoot), reportMarkdown: `[checkpoint ${merged ? '002' : '001'}](exploration-${merged ? '002' : '001'}.json)` };
  return { fixture, context, input, execute };
}

test('real production captures bind completed reads, causal intent, immutable publication and the actual next command', () => {
  const f = recordedFixture();
  try {
    expect(f.input.probes).toHaveLength(2);
    expect(validateQACheckpoints(f.input)).toEqual([]);
    expect(fs.readdirSync(path.join(f.fixture.root, '.qa-state')).filter(name => name.startsWith('happy-'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(f.fixture.root, '.qa-state')).filter(name => name.startsWith('partial-'))).toHaveLength(1);
    const annotations = { revision: f.fixture.revision, runtime: `bun ${Bun.version}`, cwd: f.fixture.root,
      evidence: f.input.probes.map((probe, index) => ({ capture: String(index + 1).padStart(3, '0'), command: probe.command, contract: 'README.md', expected: 'One durable effect', classification: index ? 'product-defect' : 'pass' })),
      learning: ['001'], limits: ['Only these two scenarios were executed.'] };
    fs.writeFileSync(path.join(f.input.reportRoot, 'annotations.json'), JSON.stringify(annotations), { mode: 0o600 });
    f.execute('bun bin/gstack-qa-evidence materialize qa-reports annotations.json');
    const report = JSON.parse(fs.readFileSync(path.join(f.input.reportRoot, 'evidence.json'), 'utf8'));
    expect(report.evidence.map((row: any) => row.observed)).toEqual(f.input.probes.map(probe => probe.observed));
    expect(report.evidence.map((row: any) => row.classification)).toEqual(['pass', 'product-defect']);
  } finally { f.fixture.cleanup(); }
});

test('declared public observations and inline causal intent use the same native producer without extra model turns', () => {
  const f = recordedFixture(true);
  try {
    expect(f.input.transcript).toHaveLength(6);
    expect(validateQACheckpoints(f.input)).toEqual([]);
    const parsed = parseNDJSON(f.input.transcript.map(event => JSON.stringify(event)));
    expect(qaNativeProbes(parsed, f.fixture.root).map(probe => ({ command: probe.command, observed: probe.observed }))).toEqual(f.input.probes);
    for (const mode of ['altered-observation', 'missing-receipt', 'forged-helper', 'changed-intent', 'interrupted-result']) {
      const transcript = structuredClone(f.input.transcript);
      if (mode === 'altered-observation') transcript[1].message.content[0].content = transcript[1].message.content[0].content.replace('"scenario":"happy"', '"scenario":"invented"');
      if (mode === 'missing-receipt') transcript[1].message.content[0].content = transcript[1].message.content[0].content.replace(/QA_EVIDENCE [^\n]*\n/, '');
      if (mode === 'forged-helper') transcript[0].message.content[0].input.command = transcript[0].message.content[0].input.command.replace('bin/gstack-qa-evidence', '/tmp/forged/bin/gstack-qa-evidence');
      if (mode === 'changed-intent') transcript[2].message.content[0].input.command = transcript[2].message.content[0].input.command.replace('One successful delivery', 'An invented successful delivery');
      if (mode === 'interrupted-result') transcript[1].tool_use_result = { interrupted: true };
      expect(validateQACheckpoints({ ...f.input, transcript }).length, mode).toBeGreaterThan(0);
    }
  } finally { f.fixture.cleanup(); }
});

test.each(['missing-capture-result', 'failed-capture', 'forged-capture-receipt', 'changed-native-value', 'missing-read', 'failed-read', 'partial-read', 'unacknowledged-read', 'stale-intent', 'retrospective-intent', 'pending-publication', 'failed-publication', 'forged-publication', 'next-command', 'altered-artifact', 'malformed-artifact'])('native producer rejects %s without weakening direct-Write validation', mode => {
  const f = recordedFixture();
  try {
    const events = f.input.transcript;
    if (mode === 'missing-capture-result') events[1].message.content = [];
    if (mode === 'failed-capture') events[1].message.content[0].is_error = true;
    if (mode === 'forged-capture-receipt') events[1].message.content[0].content = events[1].message.content[0].content.replace(/"sha256":"[a-f0-9]+"/, '"sha256":"' + '0'.repeat(64) + '"');
    if (mode === 'changed-native-value') (f.input.probes[0].observed as any).stateRoot += '-invented';
    if (mode === 'missing-read') events[2].message.content[0].input.file_path += '.other';
    if (mode === 'failed-read') events[3].message.content[0].is_error = true;
    if (mode === 'partial-read') events[3].tool_use_result.file.totalLines++;
    if (mode === 'unacknowledged-read') events[3].message.content = [];
    if (mode === 'stale-intent') events.unshift(...events.splice(4, 2));
    if (mode === 'retrospective-intent') events.push(...events.splice(4, 2));
    if (mode === 'pending-publication') events[7].message.content = [];
    if (mode === 'failed-publication') events[7].message.content[0].is_error = true;
    if (mode === 'forged-publication') events[7].message.content[0].content = events[7].message.content[0].content.replace(/"intentSha256":"[a-f0-9]+"/, '"intentSha256":"' + '0'.repeat(64) + '"');
    if (mode === 'next-command') events[8].message.content[0].input.command += ' extra';
    if (mode === 'altered-artifact' || mode === 'malformed-artifact') {
      const file = path.join(f.input.reportRoot, 'exploration-001.json');
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      value.observed.stateRoot += '-invented';
      fs.writeFileSync(file, mode === 'malformed-artifact' ? '{"observed":"\\.cache"}' : JSON.stringify(value));
      f.input.files = readQACheckpointFiles(f.input.reportRoot);
    }
    expect(validateQACheckpoints(f.input).length).toBeGreaterThan(0);
  } finally { f.fixture.cleanup(); }
});

test.each([false, true])('a merged capture binds its causal note to the observed capture by ID in one call (public=%p)', publicOutput => {
  const f = recordedFixture(publicOutput, true);
  try {
    expect(f.input.transcript).toHaveLength(publicOutput ? 4 : 6);
    expect(Object.keys(f.input.files)).toEqual(['exploration-002.json']);
    expect(validateQACheckpoints(f.input)).toEqual([]);
    const parsed = parseNDJSON(f.input.transcript.map(event => JSON.stringify(event)));
    const probes = qaNativeProbes(parsed, f.fixture.root);
    expect(probes.map(probe => probe.capture)).toEqual(['001', '002']);
    const merged = f.input.transcript.length - 2;
    const variants: Record<string, (events: any[], input: typeof f.input) => void> = {
      'missing-receipt': events => { events[merged + 1].message.content[0].content = events[merged + 1].message.content[0].content.replace(/QA_EVIDENCE [^\n]*\n/, ''); },
      'forged-checkpoint-hash': events => { events[merged + 1].message.content[0].content = events[merged + 1].message.content[0].content.replace(/"checkpointSha256":"[a-f0-9]+"/, '"checkpointSha256":"' + '0'.repeat(64) + '"'); },
      'forged-helper': events => { events[merged].message.content[0].input.command = events[merged].message.content[0].input.command.replace('bin/gstack-qa-evidence', '/tmp/forged/bin/gstack-qa-evidence'); },
      'changed-hypothesis': events => { events[merged].message.content[0].input.command = events[merged].message.content[0].input.command.replace('One successful delivery', 'An invented successful delivery'); },
      'interrupted-result': events => { events[merged + 1].tool_use_result = { interrupted: true }; },
      'stale-note': events => { events.unshift(...events.splice(merged, 2)); },
      'unlinked-report': (_events, input) => { input.reportMarkdown = 'exploration-002.json'; },
      'missing-observation-read': events => { if (!publicOutput) events[2].message.content[0].input.file_path += '.other'; else events[1].message.content[0].content = events[1].message.content[0].content.replace(/^\{[^\n]*\}\n/m, ''); },
      'altered-artifact': (_events, input) => {
        const file = path.join(input.reportRoot, 'exploration-002.json');
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        value.observed.stateRoot += '-invented';
        fs.writeFileSync(file, JSON.stringify(value));
        input.files = readQACheckpointFiles(input.reportRoot);
      },
    };
    for (const [mode, change] of Object.entries(variants)) {
      const input = { ...f.input, transcript: structuredClone(f.input.transcript), files: { ...f.input.files } };
      const original = fs.readFileSync(path.join(input.reportRoot, 'exploration-002.json'));
      change(input.transcript, input);
      expect(validateQACheckpoints(input).length, mode).toBeGreaterThan(0);
      fs.writeFileSync(path.join(input.reportRoot, 'exploration-002.json'), original);
    }
  } finally { f.fixture.cleanup(); }
});

test('a separate note cannot double as a merged capture\'s owner, and a merged capture cannot be retargeted by a legacy note', () => {
  const f = recordedFixture(true, true);
  try {
    const legacy = path.join(f.input.reportRoot, 'exploration-001.json');
    const first = f.input.probes[0], second = f.input.probes[1];
    const content = JSON.stringify({ observationCommand: first.command, observed: first.observed, hypothesis: 'One successful delivery suggests checking replay after an interrupted worker.', nextCommand: second.command });
    fs.writeFileSync(legacy, content, { mode: 0o600 });
    const transcript = structuredClone(f.input.transcript);
    transcript.splice(2, 0, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'extra', name: 'Write', input: { file_path: legacy, content } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'extra', content: 'File created successfully' }] } });
    const failures = validateQACheckpoints({ ...f.input, transcript, files: readQACheckpointFiles(f.input.reportRoot), reportMarkdown: '[a](exploration-001.json) [b](exploration-002.json)' });
    expect(failures).toContain(`QA checkpoint: Missing unique completed checkpoint before probe: ${second.command}`);
  } finally { f.fixture.cleanup(); }
});

test('materialized learning from a merged note satisfies the functional learning check only through bound capture IDs', () => {
  const f = recordedFixture(true, true);
  try {
    const annotations = { evidence: f.input.probes.map((probe, index) => ({ capture: String(index + 1).padStart(3, '0'), command: probe.command, contract: 'README.md', expected: 'One durable effect', classification: 'pass' })),
      limits: ['Only these two scenarios were executed.'] };
    fs.writeFileSync(path.join(f.input.reportRoot, 'annotations.json'), JSON.stringify(annotations), { mode: 0o600 });
    f.execute('bun bin/gstack-qa-evidence materialize qa-reports annotations.json');
    const report = JSON.parse(fs.readFileSync(path.join(f.input.reportRoot, 'evidence.json'), 'utf8'));
    expect(report.learning).toEqual([{ observationCapture: '001', observationArgv: ['bun', 'run', 'probe', '--', 'happy'],
      hypothesis: 'One successful delivery suggests checking replay after an interrupted worker.', nextCapture: '002', nextArgv: ['bun', 'run', 'probe', '--', 'partial'] }]);
    const parsed = parseNDJSON(f.input.transcript.map(event => JSON.stringify(event)));
    const learning = (row: any) => qaFunctionalVerdict(f.fixture, 'qa-only', { ...parsed, exitReason: 'success' } as any, { complete: true, events: [], changed: [], failures: [] } as any,
      { ...report, learning: [row] }, { path: 'qa/sections/system-functional.md', content: 'x' }, f.input.reportMarkdown).includes('missing observation-to-next-hypothesis evidence');
    expect(learning(report.learning[0])).toBe(false);
    expect(learning({ ...report.learning[0], nextCapture: '001' })).toBe(true);
    expect(learning({ ...report.learning[0], observationCapture: '002' })).toBe(true);
    expect(learning({ ...report.learning[0], hypothesis: 'A different sentence that no checkpoint recorded.' })).toBe(true);
  } finally { f.fixture.cleanup(); }
});

test('the registered native permission callback admits only the owned helper and the existing probe grammar', () => {
  const fixture = createQAFunctionalFixture('webhook');
  try {
    const hook = JSON.parse(fs.readFileSync(path.join(fixture.config, 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    const permitted = 'bun bin/gstack-qa-evidence capture qa-reports 001 --timeout-ms 10000 -- bun run probe -- happy';
    const merged = "bun bin/gstack-qa-evidence capture qa-reports 002 --timeout-ms 10000 --after 001 --hypothesis 'The happy path suggests replaying the delivery next.' -- bun run probe -- duplicate";
    for (const [command, expected] of [
      [permitted, 'allow'],
      ['bun bin/gstack-qa-evidence checkpoint qa-reports 001 intent-001.json', 'allow'],
      ['bun bin/gstack-qa-evidence materialize qa-reports annotations.json', 'allow'],
      [permitted.replace('bun run probe -- happy', 'bun -e evil'), 'deny'],
      [permitted.replace('qa-reports', '../outside'), 'deny'],
      [permitted.replace('bin/gstack-qa-evidence', '/tmp/forged/bin/gstack-qa-evidence'), 'deny'],
      [permitted + ' | cat', 'deny'], [permitted + ' > output', 'deny'],
      ['bun bin/gstack-qa-evidence checkpoint qa-reports 001 ../outside.json', 'deny'],
      [merged, 'allow'],
      [merged.replace('bun run probe -- duplicate', 'bun -e evil'), 'deny'],
      [merged.replace("'The happy path suggests replaying the delivery next.'", '"$(touch owned)"'), 'deny'],
      [merged + ' | cat', 'deny'],
    ]) {
      const result = spawnSync(hook, { shell: true, cwd: fixture.root, encoding: 'utf8', timeout: 5000,
        input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: fixture.root, tool_name: 'Bash', tool_input: { command } }) });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, command).toBe(expected);
    }
    expect(qaEvidenceCommand(permitted.replace(' -- bun ', ' -- bun; '), { cwd: fixture.root, reportRoot: path.join(fixture.root, 'qa-reports'), executable: path.join(fixture.root, 'bin/gstack-qa-evidence') })).toBeUndefined();
  } finally { fixture.cleanup(); }
});

test('native observer retains the same filesystem boundary while the production helper captures and publishes', async () => {
  const fixture = createQAFunctionalFixture('webhook');
  const observer = await observeQAWrites(fixture.root, { evidenceProducer: true });
  let stopped = false;
  try {
    const captured = fixtureCommand(fixture.root, ['bin/gstack-qa-evidence', 'capture', 'qa-reports', '001', '--timeout-ms', '10000', '--', 'bun', 'run', 'probe', '--', 'happy']);
    expect(captured.exit, captured.stderr).toBe(0);
    observer.drain();
    fs.writeFileSync(path.join(fixture.root, 'qa-reports/intent.json'), JSON.stringify({ capture: '001', observationCommand: 'observed command', hypothesis: 'The next probe tests the adjacent failure boundary after success.', nextCommand: 'next command' }));
    const published = fixtureCommand(fixture.root, ['bin/gstack-qa-evidence', 'checkpoint', 'qa-reports', '001', 'intent.json']);
    expect(published.exit, published.stderr).toBe(0);
    const result = observer.stop();
    stopped = true;
    expect(result.complete, result.failures.join('\n')).toBe(true);
    expect(qaWriteVerdict(result, 'qa-only')).toEqual([]);
  } finally { if (!stopped) observer.stop(); fixture.cleanup(); }
});

for (const merged of [false, true]) for (const expired of [false, true]) test(`bounded parent uses the production ${merged ? 'merged ' : ''}capture and retains truthful ${expired ? 'expired' : 'nonzero'} evidence`, async () => {
  const fixture = createQaCallerFixture('review-exploratory-small-cli');
  const transcript: any[] = [];
  const reportRoot = path.join(fixture.cwd, 'reports');
  const record = (name: string, input: any, output: string, failed = false) => {
    const id = `native-${transcript.length}`;
    transcript.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    transcript.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } });
  };
  const execute = (command: string) => {
    const result = spawnSync('bash', ['-c', command], { cwd: fixture.cwd, encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    expect(result.error).toBeUndefined();
    record('Bash', { command }, (result.status !== 0 ? `Exit code ${result.status}\n` : '') + result.stdout + result.stderr, result.status !== 0);
    return result;
  };
  try {
    await fixture.observe();
    for (const file of [path.join(fixture.cwd, 'caller-review.md'), path.join(fixture.runtime, 'qa/sections/exploratory.md'), path.join(fixture.runtime, 'qa/sections/system-functional.md')]) {
      record('Read', { file_path: file }, fs.readFileSync(file, 'utf8'));
    }
    const deadline = path.join(reportRoot, 'deadline.json');
    expect(execute(`bun ${fixture.runtime}/bin/gstack-qa-deadline start ${deadline} ${expired ? '1' : '30'}`).status).toBe(0);
    const first = `bun ${fixture.runtime}/bin/gstack-qa-evidence capture ${reportRoot} 001 --public --deadline ${deadline} -- bun scripts/probe.ts 3`;
    const hypothesis = 'The positive input suggests checking the declared zero boundary next.';
    const next = `bun ${fixture.runtime}/bin/gstack-qa-evidence capture ${reportRoot} 002 --public --deadline ${deadline} ${merged ? `--after 001 --hypothesis '${hypothesis}' ` : ''}-- bun scripts/probe.ts 0`;
    expect(execute(first).status).toBe(0);
    if (!merged) expect(execute(`bun ${fixture.runtime}/bin/gstack-qa-evidence checkpoint ${reportRoot} 001 001 '${first}' '${hypothesis}' '${next}'`).status).toBe(0);
    if (expired) await Bun.sleep(Math.max(1, Date.parse(JSON.parse(fs.readFileSync(deadline, 'utf8')).deadlineAt) - Date.now() + 10));
    expect(execute(next).status).toBe(expired ? 124 : 2);
    await fixture.close();
    const probes = fixture.probes();
    expect(probes).toHaveLength(expired ? 1 : 2);
    const input = { caller: fixture.caller, result: { transcript, exitReason: 'success' as const }, probes,
      receipt: { status: expired ? 'blocked' as const : 'fail' as const, probes: probes.map(probe => probe.id), remaining: ['The adverse boundary is unresolved.'] },
      currentSnapshot: fixture.snapshot(), requiredCharters: ['happy', 'adverse'], mutations: fixture.mutationEvents,
      observerComplete: fixture.observation?.complete === true && fixture.observerErrors.length === 0,
      fixtureRoot: fixture.cwd, runtime: fixture.runtime, requireGuardedSmoke: true, requireCapturedEvidence: true, reportRoot,
      checkpointFiles: readQACheckpointFiles(reportRoot), reportMarkdown: `[checkpoint](exploration-${merged ? '002' : '001'}.json)` };
    expect(Object.keys(input.checkpointFiles)).toEqual([`exploration-${merged ? '002' : '001'}.json`]);
    expect(validateCallerEvidence(input)).toEqual([]);
    const wrongExit = structuredClone(transcript);
    wrongExit.at(-1).message.content[0].content = wrongExit.at(-1).message.content[0].content.replace(/^Exit code \d+\n/, 'Exit code 127\n');
    expect(validateCallerEvidence({ ...input, result: { ...input.result, transcript: wrongExit } }).length).toBeGreaterThan(0);
    expect(validateCallerEvidence({ ...input, receipt: { ...input.receipt, status: 'pass', remaining: [] } }).length).toBeGreaterThan(0);
  } finally { await fixture.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

// ci-37163935292 eval-slices-3 ship-docsync-completion: Claude Code 2.1.284 answers a deferred-tool ToolSearch with tool_reference blocks.
test('a ToolSearch tool_reference result is a completed native call; other non-text content still fails', () => {
  const event = (type: string, content: unknown[]) => ({ type, parent_tool_use_id: null, message: { content } });
  const transcript = (name: string, content: unknown[]) => [
    event('assistant', [{ type: 'tool_use', id: 'search-1', name, input: { query: 'select:SendMessage' } }]),
    event('user', [{ type: 'tool_result', tool_use_id: 'search-1', content }]),
  ];
  const failures: string[] = [];
  const [call] = nativeCalls(transcript('ToolSearch', [{ type: 'tool_reference', tool_name: 'SendMessage' }]), failures);
  expect(failures).toEqual([]);
  expect(call).toMatchObject({ name: 'ToolSearch', failed: false, output: 'SendMessage' });
  for (const [name, content] of [['Bash', [{ type: 'tool_reference', tool_name: 'SendMessage' }]], ['ToolSearch', [{ type: 'image' }]]] as const) {
    const rejected: string[] = [];
    nativeCalls(transcript(name, [...content]), rejected);
    expect(rejected).toEqual(['Unsupported native result content']);
  }
});
