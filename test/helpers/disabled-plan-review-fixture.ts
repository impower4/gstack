/** Isolated real-parent fixture and execution oracle for the plan-review off switch. */
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractSkillSections } from './skill-fixture';
import { claudeOutsideExecutions } from './outside-voice-evidence';

export const OUTSIDE_PLAN_SECTION = 'Outside Voice — Independent Plan Challenge (default-on)';

/** Extract generated instructions; runtime paths are the only content substitution. */
export function installDisabledPlanReviewFixture(rendered: string, repo: string, runtimeRoot: string) {
  const source = join(rendered, 'plan-eng-review');
  const main = readFileSync(join(source, 'SKILL.md'), 'utf8');
  const frontmatter = main.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0];
  if (!frontmatter) throw new Error('Generated plan-eng-review has no frontmatter');
  // The shared plan challenge is lazily loaded. Give the established,
  // fence-aware extractor its frontmatter without copying any workflow prose.
  const input = join(repo, 'outside-plan-source.md');
  writeFileSync(input, frontmatter + readFileSync(join(source, 'sections/review-sections.md'), 'utf8'));
  let generated: string;
  try { generated = extractSkillSections(input, [OUTSIDE_PLAN_SECTION]); }
  finally { unlinkSync(input); }
  symlinkSync(runtimeRoot, join(repo, 'runtime'), 'dir');
  const instructions = generated
    .replaceAll('$HOME/.claude/skills/gstack', '$PWD/runtime')
    .replaceAll('~/.claude/skills/gstack', './runtime');
  const workflowPath = join(repo, 'OUTSIDE-PLAN.md');
  writeFileSync(workflowPath, instructions);

  const stateDir = join(repo, 'gstack-state');
  const configDir = join(repo, 'claude-config');
  const spyDir = join(repo, 'cli-bin');
  const cliDispatchLog = join(repo, 'outside-cli-dispatch.log');
  for (const dir of [stateDir, configDir, spyDir]) mkdirSync(dir, { recursive: true });
  // A forbidden invocation is observable without buying another model call.
  // No prompt/credentials are recorded; even --version/auth probes count.
  writeFileSync(join(spyDir, 'codex'), '#!/bin/sh\nprintf "codex invoked\\n" >> "$GSTACK_DISABLED_CLI_LOG"\nexit 73\n', { mode: 0o755 });
  const env = {
    PATH: `${spyDir}${delimiter}${process.env.PATH ?? ''}`,
    CLAUDE_CONFIG_DIR: configDir,
    GSTACK_HOME: stateDir,
    GSTACK_STATE_ROOT: stateDir,
    GSTACK_DISABLED_CLI_LOG: cliDispatchLog,
    GSTACK_ACTIVE_HOST: 'claude',
    GSTACK_PROJECT_SLUG: 'disabled-plan-fixture',
  };
  const config = spawnSync(join(runtimeRoot, 'bin/gstack-config'), ['set', 'codex_reviews', 'disabled'], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000,
  });
  if (config.status !== 0) throw new Error(`Cannot seed isolated review control: ${config.stderr}`);
  // Seed real historical coverage so the new disabled record must replace it
  // in the dashboard's latest-record view, not merely appear in final prose.
  const prior = {
    skill: 'codex-plan-review', timestamp: new Date(Date.now() - 60_000).toISOString(),
    status: 'clean', source: 'codex', host: 'claude', outside_provider: 'codex',
    outside_status: 'completed', phase: 'plan-review',
  };
  const logged = spawnSync(join(runtimeRoot, 'bin/gstack-review-log'), [JSON.stringify(prior)], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000,
  });
  if (logged.status !== 0) throw new Error(`Cannot seed historical review: ${logged.stderr}`);
  const slug = spawnSync(join(runtimeRoot, 'bin/gstack-slug'), [], {
    cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5_000,
  });
  const branch = /^BRANCH=([a-zA-Z0-9._-]+)$/m.exec(slug.stdout)?.[1];
  if (slug.status !== 0 || !branch) throw new Error('Cannot resolve isolated review-log branch');
  const reviewLogPath = join(stateDir, 'projects', env.GSTACK_PROJECT_SLUG, `${branch}-reviews.jsonl`);
  const priorRecord = JSON.parse(readFileSync(reviewLogPath, 'utf8').trim());
  return { workflowPath, instructions, generated, stateDir, cliDispatchLog, reviewLogPath, priorRecord, env };
}

/** A dated log value belongs to its record, not to the workflow quoting it. */
function preRunLogRecordValue(before: string, nextClause: string): boolean {
  const owner = /^(?:the\s+)?review\s+log\s+(?:already\s+)?(?:held|contained)\s+an?\s+(?:record|entry|line)\b/i.exec(before.trim());
  if (!owner) return false;
  const value = before.trim().slice(owner[0].length);
  // This route requires both an explicit pre-run date and a reported review
  // value. Arbitrary intervening prose cannot switch the reporting subject.
  const datedValue = /^\s*,?\s*(?:timestamped|recorded|written)\s+(?:about\s+)?(?:a|an|one|two|\d+)\s+(?:minute|hour|day|week)s?\s+before\s+(?:this|my)\s+(?:run|session|workflow)\s*,?\s+(?:marking|recording)\s+an?\s+(?:clean|successful|completed)\s+(?:[a-z][a-z-]*\s+)?(?:plan\s+)?review\s+with\s*$/i;
  if (!datedValue.test(value)) return false;
  // The immediately following assertion must keep the same record as its
  // subject and explicitly exclude this workflow as its origin. A later
  // current completion occurrence is still checked independently below.
  return disownsRun(nextClause);
}

/** The next assertion keeps the record as its subject and excludes this run as its origin. */
function disownsRun(nextClause: string): boolean {
  return /^(?:that|the|this)\s+(?:record|entry|line)\s+(?:was|is)\s+not\s+(?:produced|created|written|recorded)\s+(?:by|during|in)\s+(?:this|my)\s+(?:run|session|workflow)\b/i.test(nextClause.trim()) ||
    /^(?:that|the|this)\s+(?:record|entry|line)\s+predates\s+(?:this|my)\s+(?:run|session|workflow)\s+and\s+was\s+not\s+(?:produced|created|written|recorded)\s+by\s+it\b/i.test(nextClause.trim()) ||
    /^(?:that|the|this)\s+(?:record|entry|line)\s+(?:does not|doesn't|cannot)\s+(?:reflect|establish|provide|supply)\s+(?:current\s+)?outside\s+(?:review\s+)?coverage\s+(?:from|for)\s+(?:this|my)\s+(?:run|session|workflow)\b/i.test(nextClause.trim());
}

/** A record named by the retained prior record's own clock, then disowned, owns its reported value. */
function priorClockRecordValue(before: string, nextClause: string, priorRecord?: Record<string, unknown>): boolean {
  const at = /T(\d{2}):(\d{2}):(\d{2})/.exec(String(priorRecord?.timestamp ?? ''));
  if (!at || priorRecord?.outside_status !== 'completed') return false;
  const owner = new RegExp(String.raw`\b(?:earlier|prior|previous|old(?:er)?|historical|pre[- ]existing)\s+(?:review[- ]log\s+)?(?:record|entry|line)\s+(?:from|at|dated|timestamped)\s+${at[1]}:${at[2]}(?::${at[3]}(?:\.\d+)?)?(?![\d:])`, 'i').exec(before);
  if (!owner) return false;
  const value = before.slice(owner.index + owner[0].length);
  return !/\b(?:this|my)\s+(?:run|session|workflow)\b|\b(?:now|currently|current|new|updat\w*|append\w*)\b/i.test(value) && disownsRun(nextClause);
}

/** Structured quotations must belong to the exact retained prior record. */
function withoutAttributedPriorRecordData(output: string, priorRecord?: Record<string, unknown>): string {
  if (!priorRecord || priorRecord.outside_status !== 'completed') return output;
  const fields = new Set(['skill', 'timestamp', 'status', 'source', 'host', 'outside_provider', 'outside_status', 'phase', 'commit']);
  const matchesPrior = (text: string, full: boolean): boolean => {
    let record: Record<string, unknown>;
    try {
      if (full) {
        record = JSON.parse(text);
        const writtenKeys = [...text.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match => JSON.parse(match[1]!));
        if (writtenKeys.length !== new Set(writtenKeys).size) return false;
      }
      else {
        record = {};
        for (const part of text.split(/[,/;]/)) {
          const field = /^\s*["']?([a-z_]+)["']?\s*[:=]\s*["']?([a-z0-9_.:+-]+)["']?\s*$/i.exec(part);
          if (!field || Object.hasOwn(record, field[1]!)) return false;
          record[field[1]!] = field[2]!;
        }
      }
    } catch { return false; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const keys = Object.keys(record);
    return ['status', 'source', 'outside_status'].every(key => Object.hasOwn(record, key))
      && (!full || keys.length === Object.keys(priorRecord).length)
      && keys.every(key => fields.has(key) && Object.hasOwn(priorRecord, key) && record[key] === priorRecord[key]);
  };
  const ownsPriorValue = (prefix: string, fenced: boolean): boolean => {
    const local = prefix.replace(/[*`]/g, '').trimEnd().split(/\r?\n|(?<=[.!?;])\s+/).at(-1) ?? '';
    const owner = [...local.matchAll(/\b(?:earlier|prior|previous|historical|old(?:er)?|pre[- ]existing)\s+(?:(?:review[- ]log|review|log)\s+)?(?:entry|record|line|row)(?:\s+\d+)?\b/gi)].at(-1);
    if (!owner || /\b(?:now|currently|current|today|new|updat\w*|append\w*|chang\w*|mark\w*|set|write|wrote)\b/i.test(local.slice(0, owner.index))) return false;
    let rest = local.slice(owner.index + owner[0].length);
    // An explicit historical owner already establishes prior attribution.
    // A parenthesized timestamp must identify that exact retained record;
    // the redundant pre-run suffix is optional, but arbitrary metadata fails.
    const location = /^\s*\(\s*(?:timestamp\s+)?([^\s,()]+)(?:\s*,\s*before\s+(?:this|my)\s+(?:run|session|workflow)(?:\s+(?:started|began))?)?\s*\)/i.exec(rest);
    if (location) {
      const priorTime = typeof priorRecord.timestamp === 'string' ? Date.parse(priorRecord.timestamp) : NaN;
      const clock = Number.isFinite(priorTime) ? new Date(priorTime).toISOString().slice(11, 19) + 'Z' : '';
      if (location[1] !== priorRecord.timestamp && location[1] !== clock) return false;
      rest = rest.slice(location[0].length);
    }
    // Keep attribution on this record. A subject switch, current mutation,
    // second status or prose inside the data cannot borrow its ownership.
    const report = /^\s*(?:(?:that\s+)?(?:claims?|claiming|shows?|showed|says?|said|records?|recorded|reported)\s*:?)?\s*:\s*$/i;
    const inlineReport = /^\s*(?:that\s+)?(?:claims?|claiming|shows?|showed|says?|said|records?|recorded|reported)\s*:?[ \t]*$/i;
    const notAuthored = /^\s+that\s+(?:I|we)\s+(?:did\s+not|didn't)\s+(?:write|create|produce|record)\s*:\s*$/i;
    return fenced ? report.test(rest) || notAuthored.test(rest) : inlineReport.test(rest);
  };
  const spans: Array<{ start: number; end: number }> = [];
  const fences = /^ {0,3}(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n {0,3}\1[ \t]*(?=\r?\n|$)/gim;
  for (const match of output.matchAll(fences)) {
    if (ownsPriorValue(output.slice(0, match.index), true) && matchesPrior(match[2]!, true)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  // An inline quotation of the retained record's exact status/source/outside_status
  // values is that record when its own sentence names it as pre-existing and
  // makes no current claim; wording order around the quotation does not matter.
  // A named record timestamp must denote the retained record's instant at the precision written.
  const priorMs = typeof priorRecord.timestamp === 'string' ? Date.parse(priorRecord.timestamp) : NaN;
  const sameInstant = (stamp: string): boolean => {
    if (!Number.isFinite(priorMs)) return false;
    const iso = priorMs ? new Date(priorMs).toISOString() : '';
    const clock = /^(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)Z?$/.exec(stamp);
    if (clock) return iso.slice(11, 11 + clock[1]!.length) === clock[1];
    const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/.test(stamp) ? Date.parse(stamp) : NaN;
    return Number.isFinite(at) && iso.slice(0, stamp.includes('.') ? 23 : stamp.length - 1) === new Date(at).toISOString().slice(0, stamp.includes('.') ? 23 : stamp.length - 1);
  };
  const sentenceOwnsPriorValue = (index: number, length: number): boolean => {
    const start = Math.max(output.lastIndexOf('\n', index - 1), ...['. ', '! ', '? ', '; '].map(end => output.lastIndexOf(end, index - 1) + 1)) + 1;
    const ends = ['\n', '. ', '! ', '? ', '; '].map(end => output.indexOf(end, index + length)).filter(at => at >= 0);
    const sentence = (output.slice(start, index) + ' ' + output.slice(index + length, ends.length ? Math.min(...ends) : output.length))
      .replace(/[*`]/g, '').replace(/\b(?:predates|before)\s+(?:this|my)\s+(?:run|session|workflow)(?:\s+(?:started|began))?\b/gi, 'beforehand')
      .replace(/\b(?:I|we)\s+(?:did\s+not|didn't|never)\s+(?:write|create|produce|record)\b/gi, 'unauthored');
    const stamps = [...sentence.matchAll(/\btimestamp(?:ed)?\s+([0-9T:.Z-]+)/gi)].map(stamp => stamp[1]!.replace(/[.,;:]+$/, ''));
    if (stamps.some(stamp => !sameInstant(stamp))) return false;
    return !/\b(?:after|another|other|if|unless)\b/i.test(sentence)
      && /\b(?:earlier|prior|previous|historical|old(?:er)?|pre[- ]existing|stale)\s+(?:(?:review[- ]log|review|log)\s+)?(?:entry|record|line|row)\b/i.test(sentence)
      && !/\b(?:now|currently|current|today|new|updat\w*|append\w*|chang\w*|mark\w*|set|write|wrote|reports?|conclud\w*)\b|\bthis\s+(?:run|session|workflow)\b|\boutside_status\b|\bboth reviewers agree\b/i.test(sentence);
  };
  for (const match of output.matchAll(/`([^`\r\n]+)`/g)) {
    if (spans.some(span => span.start <= match.index && match.index < span.end)) continue;
    if ((ownsPriorValue(output.slice(0, match.index), false) || sentenceOwnsPriorValue(match.index, match[0].length)) && matchesPrior(match[1]!, false)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  // A parenthesized field list right after a pre-existing-record owner is that
  // record when it quotes the record's exact ISO timestamp and every other item
  // is one of its own field values; a current mutation before the owner fails.
  const owned = /\b(?:earlier|prior|previous|historical|old(?:er)?|pre[- ]existing)\s+(?:(?:review[- ]log|review|log)\s+)?(?:entry|record|line|row)\s*\(([^()\r\n]+)\)/gi;
  for (const match of output.matchAll(owned)) {
    const lineStart = output.lastIndexOf('\n', match.index) + 1;
    const local = output.slice(lineStart, match.index).split(/(?<=[.!?;])\s+/).at(-1) ?? '';
    if (/\b(?:now|currently|current|today|new|updat\w*|append\w*|chang\w*|mark\w*|set|write|wrote)\b/i.test(local.replace(/[*`]/g, ''))) continue;
    const items = match[1]!.split(',').map(item => item.replace(/[*`]/g, '').trim());
    const fieldsOk = items.every(item => {
      if (item === priorRecord.timestamp) return true;
      const field = /^["']?([a-z_]+)["']?\s*[:=]\s*["']?([a-z0-9_.:+-]+)["']?$/i.exec(item);
      return !!field && fields.has(field[1]!) && field[1] !== 'timestamp' && priorRecord[field[1]!] === field[2];
    });
    if (!fieldsOk || !items.includes(String(priorRecord.timestamp)) || !items.some(item => /^["']?outside_status\b/i.test(item))) continue;
    const start = match.index + match[0].length - match[1]!.length - 1;
    spans.push({ start, end: start + match[1]!.length + 2 });
  }
  // A quoted fragment carrying the retained record's exact timestamp is that
  // record's data when every field it quotes has that record's value.
  for (const match of output.matchAll(/`([^`\r\n]+)`/g)) {
    if (typeof priorRecord.timestamp !== 'string' || !match[1]!.includes(priorRecord.timestamp)) continue;
    const pairs = [...match[1]!.matchAll(/["']?([a-z_]+)["']?\s*[:=]\s*["']?([^"',}\s]+)["']?/gi)].filter(pair => fields.has(pair[1]!));
    if (!pairs.some(pair => pair[1] === 'outside_status') || pairs.some(pair => priorRecord[pair[1]!] !== pair[2])) continue;
    spans.push({ start: match.index!, end: match.index! + match[0].length });
  }
  // A whole sentence that names the pre-existing record, dates it before this
  // run (its exact instant or an explicit "before this run"), quotes only that
  // record's own field values and makes no current claim is that record's
  // report, however its fields are quoted or split.
  for (const sentence of output.matchAll(/[^\n.!?;]*(?:[.!?;](?=\S)[^\n.!?;]*)*(?:[.!?;](?=\s|$)|\n|$)/g)) {
    const plain = sentence[0].replace(/[*`]/g, '');
    if (!/\boutside_status["']*\s*[:=]\s*["']*completed\b/i.test(plain)) continue;
    if (!/\b(?:earlier|prior|previous|historical|old(?:er)?|pre[- ]existing|stale|seeded)\s+(?:(?:review[- ]log|review|log)\s+)?(?:entry|record|line|row)\b/i.test(plain)) continue;
    const beforeRun = /\b(?:predates|before)\s+(?:this|my)\s+(?:run|session|workflow)(?:\s+(?:started|began))?\b/i;
    const stamps = [...plain.matchAll(/\b(?:\d{4}-\d{2}-\d{2}T)?\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?\b/g)].map(m => m[0]);
    if (stamps.some(stamp => !sameInstant(stamp)) || (!stamps.length && !beforeRun.test(plain))) continue;
    const quoted = [...plain.matchAll(/\b([a-z_]+)["']?\s*[:=]\s*["']?([a-z0-9_.+-]+)["']?/gi)].filter(m => fields.has(m[1]!) && m[1] !== 'timestamp');
    if (!['status', 'source', 'outside_status'].every(key => quoted.some(m => m[1] === key))
      || quoted.some(m => priorRecord[m[1]!] !== m[2])) continue;
    if (/\b(?:now|currently|current|today|new|updat\w*|append\w*|chang\w*|wrote|recorded by me)\b|\bboth reviewers agree\b/i
      .test(plain.replace(beforeRun, ''))) continue;
    spans.push({ start: sentence.index!, end: sentence.index! + sentence[0].length });
  }
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, span.start) + output.slice(span.start, span.end).replace(/[^\r\n]/g, ' ') + output.slice(span.end);
  }
  return output;
}

/** Check each completion mention; a historical record cannot excuse a later current claim. */
function hasUnattributedOutsideCompletion(output: string, priorRecord?: Record<string, unknown>): boolean {
  output = withoutAttributedPriorRecordData(output, priorRecord);
  const marker = /\bboth reviewers agree\b|["']?\boutside_status["']*\s*[:=]\s*["']*completed\b/gi;
  const clauses = output.replace(/[*`]/g, '').split(/\r?\n|(?<=[.!?;])\s+|\b(?:but|however|nevertheless|yet)\b[:,]?\s*/i);
  return clauses.some((clause, clauseIndex) => [...clause.matchAll(marker)].some(match => {
    const before = clause.slice(0, match.index).trimEnd();
    // A quoted phrase is not automatically a denial. Require the local no-claim
    // statement, so a second positive assertion in the same paragraph still fails.
    const denied = /\bno\s*["'“”‘’]*\s*$/i.test(before)
      || /\b(?:(?:do|did|will|would|can|could)\s+not|cannot|can't|won't)\s+(?:claim|say|state|report)\s*["'“”‘’]*\s*$/i.test(before)
      || /\b(?:am|is|are)\s+not\s+(?:claiming|saying|stating|reporting)\s*["'“”‘’]*\s*$/i.test(before);
    if (denied) return false;
    // Agreement is a current prose claim unless explicitly denied; an old
    // log entry only establishes the provenance of its recorded status value.
    if (/^both reviewers agree$/i.test(match[0])) return true;
    // A record explicitly dated before this run is historical even when its
    // subject is "that record" rather than "the earlier record".
    const datedBeforeRun = String.raw`\s+is\s+timestamped\s+(?:about\s+)?(?:a|an|one|two|\d+)\s+(?:minute|hour|day|week)s?\s+before\s+(?:this|my)\s+(?:run|session|workflow)`;
    const recordPattern = new RegExp(String.raw`\b(?:(?:earlier|prior|historical|old(?:er)?)\s+(?:entry|record|line)|(?:that|the)\s+(?:entry|record|line)(?=${datedBeforeRun}))\b`, 'gi');
    if (priorClockRecordValue(before, clauses[clauseIndex + 1] ?? '', priorRecord)) return false;
    const record = [...before.matchAll(recordPattern)].at(-1);
    if (!record) return !preRunLogRecordValue(before, clauses[clauseIndex + 1] ?? '');
    // Bind this occurrence to an old record's reported value. A mere mention
    // of a record, a second status, or a new reporting subject cannot inherit
    // its historical attribution, even without a sentence boundary.
    const prefix = before.slice(record.index + record[0].length);
    // Date metadata still describes this record's own value. Admit explicit
    // clock or pre-run timestamps, not arbitrary prose that can change subjects.
    const clock = String.raw`\s+from\s+(?:[01]\d|2[0-3]):[0-5]\d,?`;
    const beforeRun = String.raw`\s*,?\s*(?:written|recorded)\s+(?:about\s+)?(?:a|an|one|\d+)\s+(?:minute|hour|day|week)s?\s+before\s+this\s+(?:run|session|workflow)(?:\s+(?:started|began))?,?`;
    const timestamp = String.raw`(?:${datedBeforeRun}\s+and|\s*,?\s*timestamped\b[^,;.!?]{1,160},?|${clock}|${beforeRun})`;
    const report = new RegExp(String.raw`^(?:${timestamp})?\s*(?:(?:that\s+)?(?:claims?|claiming|shows?|showed|says?|said|records?|recorded|reported)\b|:)\s*`, 'i').exec(prefix);
    // Only intervening review-log metadata belongs to this reported value.
    // Arbitrary prose could switch to a new subject without an earlier status.
    const field = String.raw`["']?(?:status|source|host|outside_provider|phase|timestamp)["']?\s*[:=]\s*["']?[a-z0-9_.:+-]+["']?`;
    const metadata = new RegExp(String.raw`^(?:${field}\s*(?:,\s*|(?:with|and)\s*))*$`, 'i');
    const reportsOldValue = report !== null && metadata.test(prefix.slice(report[0].length).trim());
    const attribution = clause.slice(record.index).replace(/\bbefore\s+(?:this|my)\s+(?:run|session|workflow)\b/gi, 'beforehand');
    const current = /\b(?:now|currently|current|today|new|updat\w*|append\w*|chang\w*|mark\w*|set|write|wrote)\b|\bthis\s+(?:run|session|workflow)\b/i.test(attribution);
    return !reportsOldValue || current;
  }));
}

/**
 * The run's closing self-report: the last unquoted JSON object with a string
 * "outside_review_this_run". Returns undefined when the output has none.
 */
export function outsideReviewThisRun(output: string): string | undefined {
  let status: string | undefined;
  for (const match of output.matchAll(/\{[^{}]*"outside_review_this_run"[^{}]*\}/g)) {
    const before = output.slice(0, match.index!);
    if (/^\s*>/.test(before.slice(before.lastIndexOf('\n') + 1))) continue;
    try {
      const value = (JSON.parse(match[0]) as { outside_review_this_run?: unknown }).outside_review_this_run;
      if (typeof value === 'string') status = value.trim().toLowerCase();
    } catch { /* not a summary */ }
  }
  return status;
}

export function disabledPlanReviewEvidence(result: {
  exitReason: string; output: string; transcript: any[];
}, cliDispatchLog: string, reviewLog = '', priorRecord?: Record<string, unknown>) {
  const init = result.transcript.find(event => event?.type === 'system' && event.subtype === 'init');
  const terminal = result.transcript.filter(event => event?.type === 'result').at(-1);
  const toolCalls = result.transcript.flatMap(event => event?.type === 'assistant' && Array.isArray(event.message?.content)
    ? event.message.content.filter((block: any) => block.type === 'tool_use') : []);
  const fallbackCalls = toolCalls.filter((call: any) => call.name === 'Agent' || call.name === 'Task');
  // Command text may contain an unexecuted guarded branch. Keep it for
  // diagnostics; only the executable sentinel establishes CLI dispatch.
  const outsideCommandMentions = toolCalls.filter((call: any) => call.name === 'Bash'
    && /\bcodex\s+(?:exec|review)\b|\bgstack-claude-code(?:['"])?\s+--/.test(String(call.input?.command ?? '')));
  const disabledPreflight = claudeOutsideExecutions(result.transcript).filter(call => call.succeeded
    && /gstack-config\b/.test(call.command) && /codex_reviews\b/.test(call.command)
    && /^CODEX_MODE: disabled\s*$/m.test(call.output));
  const completed = result.exitReason === 'success' && terminal?.subtype === 'success'
    && terminal.is_error !== true && typeof terminal.result === 'string' && terminal.result.trim().length > 0;
  // With a closing self-report, the claim about this run is that report plus
  // any undenied "both reviewers agree"; historical record mentions need no
  // attribution parsing. Runs without one keep the prose oracle.
  const summary = outsideReviewThisRun(result.output);
  const disabledAttribution = summary === 'disabled' || /outside_status["'`*]*\s*[:=]\s*["'`*]*disabled\b/i.test(result.output)
    || result.output.split('\n').some(line => /\b(?:outside(?:\s+(?:voice|review))?|codex(?:\s+review)?)\b/i.test(line)
      && /\bdisabled\b/i.test(line) && !/\bnot\s+disabled\b/i.test(line));
  const falseCompletion = summary === undefined ? hasUnattributedOutsideCompletion(result.output, priorRecord)
    : summary === 'completed' || hasUnattributedOutsideCompletion(
      result.output.replace(/["']?\boutside_status["']*\s*[:=]\s*["']*completed\b/gi, match => ' '.repeat(match.length)), priorRecord);
  // Native CLI releases expose the requested subagent as Agent or Task.
  // Availability never permits dispatch: fallbackCalls rejects both names.
  const agentAvailable = Array.isArray(init?.tools) && init.tools.some((tool: unknown) => tool === 'Agent' || tool === 'Task');
  let records: any[] = [];
  let malformedLog = false;
  try { records = reviewLog.trim() ? reviewLog.trim().split('\n').map(line => JSON.parse(line)) : []; }
  catch { malformedLog = true; }
  const planRecords = records.filter(record => record && typeof record === 'object' && record.skill === 'codex-plan-review');
  const priorIndex = priorRecord ? planRecords.findIndex(record => JSON.stringify(record) === JSON.stringify(priorRecord)) : -1;
  const latestRecord = planRecords.at(-1);
  const persistedDisabled = !malformedLog && priorIndex >= 0 && priorIndex < planRecords.length - 1
    && priorRecord?.outside_status === 'completed' && latestRecord.status === 'skipped'
    && latestRecord.source === 'none' && latestRecord.host === 'claude'
    && latestRecord.outside_provider === 'codex' && latestRecord.outside_status === 'disabled'
    && latestRecord.phase === 'plan-review' && typeof latestRecord.timestamp === 'string'
    && typeof priorRecord.timestamp === 'string' && Number.isFinite(Date.parse(latestRecord.timestamp))
    && Date.parse(latestRecord.timestamp) > Date.parse(priorRecord.timestamp);
  return {
    passed: completed && agentAvailable && disabledPreflight.length > 0 && fallbackCalls.length === 0
      && cliDispatchLog.trim() === '' && disabledAttribution && !falseCompletion && persistedDisabled,
    completed, agentAvailable, disabledAttribution, falseCompletion, persistedDisabled, latestRecord, malformedLog,
    disabledPreflight, fallbackCalls, outsideCommandMentions, cliDispatchLog,
  };
}
