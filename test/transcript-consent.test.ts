/**
 * lib/transcript-consent.ts: the value grammar, the multi-root policy, the
 * per-session and per-page scope checks, and the parity of the bash validator
 * and remote canonicalizer in bin/gstack-config with their TS twins.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { canonicalizeRemote } from '../lib/gstack-memory-helpers';
import {
  describeTranscriptPolicy,
  pageExclusion,
  parseTranscriptMode,
  readTranscriptConsent,
  reposHash,
  sessionExclusion,
  type TranscriptConsent,
} from '../lib/transcript-consent';

const CONFIG_BIN = join(import.meta.dir, '..', 'bin', 'gstack-config');
const TS = '2026-10-03T17:00:00Z';

/** Every grammar combination: base x (cutoff | none) x (+repos | none). */
function combinations(): Array<{ value: string; valid: boolean }> {
  const out: Array<{ value: string; valid: boolean }> = [];
  for (const base of ['recent', 'all', 'off', 'new']) {
    for (const at of ['', `@${TS}`]) {
      for (const marker of ['', '+repos']) {
        const valid = (base === 'new') === (at !== '') && !(base === 'off' && marker !== '');
        out.push({ value: `${base}${at}${marker}`, valid });
      }
    }
  }
  return out;
}

const INVALID_FORMS = [
  `new@2026-10-03T17:00:00+00:00`, // offsets are rejected; only Z
  `new@2026-10-03T17:00:00.000Z`, // milliseconds are not part of the grammar
  `new@2026-10-03 17:00:00Z`,
  `new@2026-10-03`,
  `new@2026-02-30T00:00:00Z`, // not a real day
  `new@2026-13-01T00:00:00Z`,
  `new@2026-10-03T24:00:00Z`,
  `new+repos@${TS}`, // @ precedes +repos
  `new@`,
  'recent+repo',
  'yes',
  'A',
  'incremental',
  '',
];

describe('grammar', () => {
  test('every base x cutoff x marker combination', () => {
    for (const { value, valid } of combinations()) {
      const parsed = parseTranscriptMode(value);
      expect({ value, valid: parsed !== null }).toEqual({ value, valid });
      if (parsed) {
        expect(parsed.base).toBe(value.split(/[@+]/)[0] as never);
        expect(parsed.cutoff).toBe(value.includes('@') ? TS : null);
        expect(parsed.repos).toBe(value.endsWith('+repos'));
      }
    }
  });

  test('readers are case-insensitive; offsets, bad dates and misplaced parts are rejected', () => {
    expect(parseTranscriptMode(`NEW@2026-10-03t17:00:00z+REPOS`)).toEqual({ base: 'new', cutoff: TS, repos: true });
    expect(parseTranscriptMode('  Recent ')).toEqual({ base: 'recent', cutoff: null, repos: false });
    expect(parseTranscriptMode('new@2028-02-29T00:00:00Z')).not.toBeNull();
    for (const value of INVALID_FORMS) expect({ value, parsed: parseTranscriptMode(value) }).toEqual({ value, parsed: null });
  });

  test('gstack-config set accepts exactly the canonical valid forms and rejects the rest with the file unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'gstack-grammar-'));
    try {
      const env = { ...process.env, GSTACK_STATE_ROOT: root };
      const run = (...args: string[]) => spawnSync('bash', [CONFIG_BIN, ...args], { encoding: 'utf-8', timeout: 30_000, env });
      expect(run('set', 'transcript_repos', 'github.com/acme/app').status).toBe(0);
      for (const { value, valid } of combinations()) {
        const r = run('set', 'transcript_ingest_mode', value);
        expect({ value, status: r.status }).toEqual({ value, status: valid ? 0 : 1 });
      }
      run('set', 'transcript_ingest_mode', 'recent');
      for (const value of [...INVALID_FORMS.filter(Boolean), 'Recent', `new@2026-10-03t17:00:00z`]) {
        const r = run('set', 'transcript_ingest_mode', value);
        expect({ value, status: r.status }).toEqual({ value, status: 1 });
        expect(r.stderr).toContain(`Error: transcript_ingest_mode '${value}' not recognized. Valid values: recent, all, off. Existing value left unchanged.`);
        expect(r.stderr).toContain('new@<YYYY-MM-DDTHH:MM:SSZ>');
      }
      expect(run('get', 'transcript_ingest_mode').stdout).toBe('recent+repos');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the bash remote canonicalizer matches canonicalizeRemote', () => {
    const inputs = [
      'https://github.com/Acme/App.git',
      'git@github.com:acme/app.git',
      'ssh://git@github.com/acme/app',
      'http://user@gitlab.example.com/group/sub/repo.git/',
      ' "github.com/acme/app/" ',
      'github.com//acme///app',
      '/srv/git/repo/.git',
      'file:///srv/git/repo',
    ];
    const script = `. /dev/null; source <(sed -n '/^canonical_remote() {/,/^}/p' "${CONFIG_BIN}"); for x in "$@"; do canonical_remote "$x"; echo; done`;
    const r = spawnSync('bash', ['-c', script, 'bash', ...inputs], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n').slice(0, inputs.length)).toEqual(inputs.map((i) => canonicalizeRemote(i)));
  });
});

/** The normalizer shipped before this change (bin/gstack-memory-ingest.ts at v1.91.16.0), verbatim in behavior. */
function olderNormalizerConsents(value: string | null): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return value !== null && (v === 'recent' || v === 'all');
}

describe('fail-closed encoding', () => {
  test('a gstack without new@ or allowlist support reads every new value form as no consent', () => {
    for (const value of [`new@${TS}`, `new@${TS}+repos`, 'recent+repos', 'all+repos']) {
      expect({ value, consents: olderNormalizerConsents(value) }).toEqual({ value, consents: false });
    }
  });

  test('the current normalizer treats any unrecognized value as no consent', () => {
    const root = mkdtempSync(join(tmpdir(), 'gstack-consent-'));
    try {
      for (const value of ['yes', 'new', `recent@${TS}`, 'off+repos', 'new@tomorrow', 'recent+repos+repos']) {
        writeFileSync(join(root, 'config.yaml'), `transcript_ingest_mode: ${value}\n`);
        expect(readTranscriptConsent([root])).toMatchObject({ affirmative: false, reason: 'unrecognized', value });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('effective consent across state roots', () => {
  const roots: string[] = [];
  const root = (yaml: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), 'gstack-root-'));
    roots.push(dir);
    if (yaml !== null) writeFileSync(join(dir, 'config.yaml'), yaml);
    return dir;
  };
  const cleanup = () => roots.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));

  test('off in one root plus new@ in another gives no consent', () => {
    try {
      const p = readTranscriptConsent([root(`transcript_ingest_mode: new@${TS}\n`), root('transcript_ingest_mode: off\n')]);
      expect(p).toMatchObject({ affirmative: false, reason: 'off', cutoff: TS });
      const q = readTranscriptConsent([root('transcript_ingest_mode: off\n'), root(`transcript_ingest_mode: new@${TS}\n`)]);
      expect(q).toMatchObject({ affirmative: false, reason: 'off' });
    } finally {
      cleanup();
    }
  });

  test('time constraints stack: the latest cutoff and any 90-day window', () => {
    try {
      const later = '2026-11-01T00:00:00Z';
      expect(readTranscriptConsent([root(`transcript_ingest_mode: new@${TS}\n`), root(`transcript_ingest_mode: new@${later}\n`)]))
        .toMatchObject({ affirmative: true, window: 'new', reason: 'new', cutoff: later });
      expect(readTranscriptConsent([root('transcript_ingest_mode: all\n'), root(`transcript_ingest_mode: new@${TS}\n`)]))
        .toMatchObject({ affirmative: true, window: 'new', cutoff: TS });
      expect(readTranscriptConsent([root(`transcript_ingest_mode: new@${TS}\n`), root('transcript_ingest_mode: recent\n')]))
        .toMatchObject({ affirmative: true, window: 'recent', cutoff: TS });
      const all = readTranscriptConsent([root('transcript_ingest_mode: all\n'), root(null)]);
      expect(all).toMatchObject({ affirmative: true, window: 'all' });
      expect(all.cutoff).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test('allowlists intersect; disjoint lists give EMPTY and nothing is ingested', () => {
    try {
      const a = root('transcript_ingest_mode: recent+repos\ntranscript_repos: github.com/acme/app,github.com/acme/api\n');
      const b = root('transcript_repos: https://github.com/acme/api.git,github.com/acme/web\n');
      expect(readTranscriptConsent([a, b])).toMatchObject({ affirmative: true, repos: ['github.com/acme/api'], roots: [a, b] });
      const c = root('transcript_ingest_mode: all+repos\ntranscript_repos: github.com/other/x\n');
      const empty = readTranscriptConsent([a, c]);
      expect(empty.repos).toEqual([]);
      for (const remote of ['github.com/acme/app', 'github.com/other/x', '']) {
        expect(sessionExclusion(empty, { startedAt: TS, remote })).toBe('not-allowlisted');
      }
    } finally {
      cleanup();
    }
  });

  test('a +repos marker without a readable allowlist denies', () => {
    try {
      for (const yaml of ['transcript_ingest_mode: recent+repos\n', 'transcript_ingest_mode: recent+repos\ntranscript_repos: \n', 'transcript_ingest_mode: all+repos\ntranscript_repos: ,\n']) {
        expect(readTranscriptConsent([root(yaml)])).toMatchObject({ affirmative: false, reason: 'repos-unreadable', repos: [] });
      }
    } finally {
      cleanup();
    }
  });

  test('the resolved root must hold the consent; other roots only restrict', () => {
    try {
      expect(readTranscriptConsent([root(null), root('transcript_ingest_mode: all\n')])).toMatchObject({ affirmative: false, reason: 'not-set' });
      expect(readTranscriptConsent([root('transcript_ingest_mode: recent\n'), root('transcript_ingest_mode: A\n')])).toMatchObject({ affirmative: false, reason: 'legacy' });
    } finally {
      cleanup();
    }
  });
});

describe('scope checks', () => {
  const scoped: TranscriptConsent = { affirmative: true, window: 'new', reason: 'new', value: `new@${TS}+repos`, cutoff: TS, repos: ['github.com/acme/app'] };

  test('sessions: the cutoff uses the start time; the allowlist uses the canonical remote', () => {
    expect(sessionExclusion(scoped, { startedAt: '2026-10-03T16:59:59Z', remote: 'github.com/acme/app' })).toBe('pre-cutoff');
    expect(sessionExclusion(scoped, { startedAt: TS, remote: 'git@github.com:Acme/App.git' })).toBeNull();
    expect(sessionExclusion(scoped, { startedAt: '', remote: 'github.com/acme/app' })).toBe('missing-start');
    expect(sessionExclusion(scoped, { startedAt: 'not a date', remote: 'github.com/acme/app' })).toBe('missing-start');
    expect(sessionExclusion(scoped, { startedAt: '2026-10-04T00:00:00Z', remote: 'github.com/acme/web' })).toBe('not-allowlisted');
    expect(sessionExclusion({ affirmative: true, window: 'recent', reason: 'recent', value: 'recent' }, { startedAt: null, remote: null })).toBeNull();
  });

  test('pages: frontmatter decides; artifact pages are never excluded; no consent excludes every transcript page', () => {
    const page = (fm: string) => `---\n${fm}\n---\n\nbody\n`;
    expect(pageExclusion(scoped, page(`type: transcript\nsession_started_at: 2026-10-04T00:00:00.000Z\ngit_remote: github.com/acme/app`))).toBeNull();
    expect(pageExclusion(scoped, page(`type: transcript\nstart_time: 2026-09-01T00:00:00Z\ngit_remote: github.com/acme/app`))).toBe('pre-cutoff');
    expect(pageExclusion(scoped, page('type: transcript\ngit_remote: github.com/acme/app'))).toBe('missing-start');
    expect(pageExclusion(scoped, page('type: learning'))).toBeNull();
    expect(pageExclusion(scoped, '# no frontmatter\n')).toBe('missing-start');
    const recent: TranscriptConsent = { affirmative: true, window: 'recent', reason: 'recent', value: 'recent' };
    expect(pageExclusion(recent, '# no frontmatter\n')).toBeNull();
    const off: TranscriptConsent = { affirmative: false, window: null, reason: 'off', value: 'off' };
    expect(pageExclusion(off, page('type: transcript'))).toBe('not-consented');
  });

  test('the allowlist hash is order-independent', () => {
    expect(reposHash(['b', 'a'])).toBe(reposHash(['a', 'b']));
    expect(reposHash(['a'])).not.toBe(reposHash(['a', 'b']));
  });
});

describe('consent in words', () => {
  test('window or cutoff, up to three repos then +N more, contributing roots', () => {
    const base = { affirmative: true, reason: 'new' as const, value: 'x', roots: ['/r1', '/r2'] };
    expect(describeTranscriptPolicy({ ...base, window: 'recent', reason: 'recent' })).toBe('sessions from the last 90 days; every repo your repo policy allows; config: /r1, /r2');
    expect(describeTranscriptPolicy({ ...base, window: 'new', cutoff: TS, repos: ['a/b/c', 'd/e/f', 'g/h/i', 'j/k/l', 'm/n/o'] }))
      .toBe('sessions that started after 2026-10-03 17:00:00 UTC; repos a/b/c, d/e/f, g/h/i +2 more; config: /r1, /r2');
    expect(describeTranscriptPolicy({ ...base, window: 'all', reason: 'all', repos: ['a/b/c'], roots: [] })).toBe('all history; repo a/b/c');
  });
});

describe('CLI', () => {
  test('--check exits 0 only when transcript pages may sync', () => {
    const root = mkdtempSync(join(tmpdir(), 'gstack-check-'));
    mkdirSync(join(root, 'legacy'));
    try {
      const check = () =>
        spawnSync('bun', ['run', join(import.meta.dir, '..', 'lib', 'transcript-consent.ts'), '--check'], {
          encoding: 'utf-8',
          timeout: 30_000,
          env: { ...process.env, GSTACK_STATE_ROOT: root, GSTACK_TEST_LEGACY_ROOT: join(root, 'legacy') },
        }).status;
      expect(check()).toBe(1);
      for (const [yaml, status] of [
        ['transcript_ingest_mode: recent\n', 0],
        [`transcript_ingest_mode: new@${TS}\n`, 0],
        ['transcript_ingest_mode: off\n', 1],
        ['transcript_ingest_mode: recent+repos\n', 1],
        ['transcript_ingest_mode: recent+repos\ntranscript_repos: github.com/a/b\n', 0],
      ] as const) {
        writeFileSync(join(root, 'config.yaml'), yaml);
        expect({ yaml, status: check() }).toEqual({ yaml, status });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
