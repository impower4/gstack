/**
 * #3107: after a Claude Code 2.1.293 auto-compaction the journal holds a
 * compact boundary followed by copies of the kept conversation: a new uuid, a
 * parentUuid relinked to the previous copy (a tool_result copy keeps its
 * original parent), zeroed message.usage, every other field identical. The
 * owned reader collapses such a copy into its pre-boundary original; any other
 * difference, or a duplicate with no boundary between, still fails closed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { guardFixture, section, codeOf, denial, type GuardFixture } from './helpers/autoplan-guard-fixture';
import { readOwnedClaudePublicTranscript } from '../lib/claude-public-transcript';
import { OWNED_READ_APPROVAL } from '../autoplan/bin/owned-read';

type Row = Record<string, any>;
const fixtures: GuardFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const fixture = (...args: Parameters<typeof guardFixture>) => { const f = guardFixture(...args); fixtures.push(f); return f; };

const rowsOf = (f: GuardFixture): Row[] => fs.readFileSync(f.transcript, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const write = (f: GuardFixture, rows: Row[]) => fs.writeFileSync(f.transcript, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const toolResult = (r: Row) => r.message?.role === 'user' && Array.isArray(r.message.content) && r.message.content[0]?.type === 'tool_result';
const toolUse = (r: Row) => r.message?.role === 'assistant' && Array.isArray(r.message.content) && r.message.content.some((b: Row) => b.type === 'tool_use');
/** What 2.1.293 keeps in full: prompts, assistant text and end turns, plus the last `tools` tool calls. */
const kept = (tools: number) => (rows: Row[]) => {
  const uses = rows.filter(toolUse).slice(rows.filter(toolUse).length - tools)
    .flatMap(r => r.message.content.filter((b: Row) => b.type === 'tool_use').map((b: Row) => b.id));
  return rows.filter(r => !(toolUse(r) || toolResult(r)) || r.message.content.some((b: Row) => uses.includes(b.id ?? b.tool_use_id)));
};

/** Give every assistant record real usage, as Claude Code writes it before a compaction. */
function withUsage(f: GuardFixture): void {
  write(f, rowsOf(f).map(r => r.message?.role === 'assistant'
    ? { ...r, message: { ...r.message, usage: { input_tokens: 812, output_tokens: 64, cache_read_input_tokens: 4096 } } } : r));
}

/**
 * Append a 2.1.293-shaped compaction: the boundary, then copies of `select(rows)`
 * (the message records since the last boundary, by default all of them).
 */
function compact(f: GuardFixture, opts: { select?: (rows: Row[]) => Row[]; boundary?: boolean; change?: (copy: Row) => void } = {}): Row[] {
  const rows = rowsOf(f), last = rows.at(-1)!;
  const since = rows.slice(rows.findLastIndex(r => r.subtype === 'compact_boundary') + 1).filter(r => r.message);
  const boundary = { parentUuid: null, logicalParentUuid: last.uuid, isSidechain: false, cwd: last.cwd, sessionId: last.sessionId,
    version: last.version, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false,
    timestamp: new Date(Date.parse(last.timestamp) + 1000).toISOString(), uuid: randomUUID(),
    compactMetadata: { trigger: 'auto', preTokens: 975885, postTokens: 52538 } };
  const out = opts.boundary === false ? [...rows] : [...rows, boundary];
  let parent = opts.boundary === false ? last.uuid : boundary.uuid;
  const copies: Row[] = [];
  for (const original of (opts.select ?? (r => r))(since)) {
    const copy = structuredClone(original);
    copy.uuid = randomUUID();
    if (!toolResult(original)) copy.parentUuid = parent;
    if (copy.message.usage) copy.message.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    opts.change?.(copy);
    parent = copy.uuid; copies.push(copy); out.push(copy);
  }
  write(f, out);
  return copies;
}

/** Journal the phase-entry Read under the last record, so the hook takes the journal path. */
function enterNext(f: GuardFixture) {
  const rows = rowsOf(f), last = rows.at(-1)!;
  const input = f.input('next', 'Read', { file_path: section('design-phase.md') });
  rows.push({ ...last, uuid: randomUUID(), parentUuid: last.uuid, type: 'assistant', toolUseResult: undefined, isMeta: undefined,
    origin: undefined, promptId: undefined, promptSource: undefined, timestamp: new Date(Date.parse(last.timestamp) + 1000).toISOString(),
    message: { role: 'assistant', id: f.nextMessage(), content: [{ type: 'tool_use', id: 'next', name: 'Read', input: input.tool_input }] } });
  write(f, rows);
  return input;
}

const events = (f: GuardFixture) => readOwnedClaudePublicTranscript(f.transcript, f.cwd, f.sessionId).events;
const identities = (f: GuardFixture) => events(f).filter(e => e.kind === 'use' || e.kind === 'result').map(e => `${e.kind}:${(e as any).toolUseId}`);

describe('#3107 post-compaction copies', () => {
  test('a synthesized 2.1.293 post-compaction journal passes; the copies add no events', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    const before = events(f).length;
    const copies = compact(f);
    expect(copies.length).toBeGreaterThan(8);
    expect(copies.filter(toolResult).every(c => rowsOf(f).some(r => r.uuid === c.parentUuid && !copies.includes(r)))).toBe(true);
    expect(events(f)).toHaveLength(before);
    expect(new Set(identities(f)).size).toBe(identities(f).length);
    expect(events(f).filter(e => e.kind === 'user_turn')).toHaveLength(1);
    // The phase entry hangs under the last copy: ancestry through skipped copies stays owned.
    expect(await f.hook(enterNext(f))).toEqual(OWNED_READ_APPROVAL);
  });

  test('the payload path (phase entry not yet journaled) passes after copies of the last three tool calls', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f); compact(f, { select: kept(3) });
    expect(await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }))).toEqual(OWNED_READ_APPROVAL);
  });

  test('a copy whose tool result changed still fails tool_identity', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    compact(f, { change: c => { if (toolResult(c) && c.message.content[0].tool_use_id === 'close') c.message.content[0].content = 'A different result.'; } });
    expect(identities(f).filter(id => id === 'result:close')).toHaveLength(2);
    expect(codeOf(await f.hook(enterNext(f)))).toBe('tool_identity');
  });

  test('a copy whose tool input changed still fails tool_identity', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    compact(f, { change: c => { if (toolUse(c) && c.message.content[0].id === 'entry') c.message.content[0].input = { ...c.message.content[0].input, limit: 1 }; } });
    expect(codeOf(await f.hook(enterNext(f)))).toBe('tool_identity');
  });

  test('a duplicate identity with no compact boundary between the records still fails tool_identity', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    compact(f, { boundary: false, select: kept(3) });
    expect(codeOf(await f.hook(enterNext(f)))).toBe('tool_identity');
  });

  test('a copy differing only in another field (here isMeta) is kept and fails closed', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    compact(f, { select: kept(3), change: c => { if (toolResult(c)) c.isMeta = true; } });
    expect(codeOf(await f.hook(enterNext(f)))).toBe('tool_identity');
  });

  test('a copied /autoplan prompt does not re-initialize the guard (no init_own)', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    compact(f, { select: kept(0) });
    expect(rowsOf(f).filter(r => typeof r.message?.content === 'string' && r.message.content.includes('/autoplan'))).toHaveLength(2);
    expect(events(f).filter(e => e.kind === 'user_turn')).toHaveLength(1);
    expect(await f.hook(enterNext(f))).toEqual(OWNED_READ_APPROVAL);
  });

  test('a copied end turn with its typed prompt does not disarm the guard', async () => {
    const f = fixture('ceo', { opening: 'skill' });
    // Earlier work ended its turn before the typed request that ran /autoplan; the Phase 1 report is not published.
    f.journal(undefined, at => at === -1 ? [
      { type: 'user', message: { role: 'user', content: 'Earlier work in this session.' }, extra: { origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID() } },
      { type: 'assistant', message: { role: 'assistant', id: 'msg_earlier', content: [{ type: 'text', text: 'Done with the earlier work.' }], stop_reason: 'end_turn' } },
    ] : []);
    withUsage(f);
    expect(codeOf(await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') })))).toBe('publication_missing');
    compact(f, { select: kept(0) });
    expect(events(f).filter(e => e.kind === 'end_turn')).toHaveLength(1);
    expect(codeOf(await f.hook(enterNext(f)))).toBe('publication_missing');
  });

  test('a double compaction collapses copies of copies', async () => {
    const f = fixture(); f.publish(); f.journal(); withUsage(f);
    const before = events(f).length;
    compact(f); compact(f);
    expect(rowsOf(f).filter(r => r.subtype === 'compact_boundary')).toHaveLength(2);
    expect(events(f)).toHaveLength(before);
    expect(await f.hook(enterNext(f))).toEqual(OWNED_READ_APPROVAL);
  });
});

describe('the fail-open disarm path (phase-publication-hook disarmedAt)', () => {
  test('a real end turn and a later typed request release the invocation; the guard allows and logs it', async () => {
    const f = fixture(); f.journal();
    const unpublished = await f.hook(f.input('next', 'Read', { file_path: section('design-phase.md') }));
    expect(codeOf(unpublished)).toBe('publication_missing');
    const rows = rowsOf(f), last = rows.at(-1)!;
    const end = { ...last, uuid: randomUUID(), parentUuid: last.uuid, type: 'assistant', toolUseResult: undefined,
      message: { role: 'assistant', id: f.nextMessage(), content: [{ type: 'text', text: 'Stopping here.' }], stop_reason: 'end_turn' } };
    const typed = { ...last, uuid: randomUUID(), parentUuid: end.uuid, type: 'user', toolUseResult: undefined,
      origin: { kind: 'human' }, promptSource: 'typed', promptId: randomUUID(), message: { role: 'user', content: 'Read the design section for me.' } };
    write(f, [...rows, end, typed]);
    expect(denial(await f.hook(enterNext(f)))).toBeUndefined();
    expect(f.log().at(-1)).toMatchObject({ decision: 'allow' });
  });

  test('the same end turn without a later typed request keeps the guard armed', async () => {
    const f = fixture(); f.journal();
    const rows = rowsOf(f), last = rows.at(-1)!;
    write(f, [...rows, { ...last, uuid: randomUUID(), parentUuid: last.uuid, type: 'assistant', toolUseResult: undefined,
      message: { role: 'assistant', id: f.nextMessage(), content: [{ type: 'text', text: 'Stopping here.' }], stop_reason: 'end_turn' } }]);
    expect(codeOf(await f.hook(enterNext(f)))).toBe('publication_missing');
  });
});
