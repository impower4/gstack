/**
 * Reviewer-written checks for the docs/no-tests empty lane (#3215, cherry-picked
 * with its author's commits): the edges the contributor's tests do not reach.
 * A declared [] labels only Markdown; template sources, unread test-tree
 * Markdown and code still fail closed; renames and deletions of Markdown are
 * docs; and an empty_lanes key the branch adds to its own pregate.json is
 * not honoured, because only the base branch's copy is (the C1 trust
 * boundary). Real gstack-pregate subprocesses on fixture repos.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });
const fixture = (pregate: Record<string, unknown> | null) => { const r = makeFixtureRepo({ pregate }); repos.push(r); return r; };
const lanes = (repo: FixtureRepo) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--only', 'lanes', '--explain']);

describe('docs/no-tests empty lane: reviewer edges (#3215)', () => {
  test('a [] declaration labels Markdown as docs/no-tests and leaves a declared non-Markdown file unlabeled', () => {
    const repo = fixture(BASE_PREGATE);
    commit(repo, { 'docs/guide.md': '# guide\n', 'docs/diagram.svg': '<svg/>\n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('lanes: docs/no-tests (empty lane): docs/guide.md');
    expect(r.out).not.toMatch(/docs\/no-tests \(empty lane\):.*diagram\.svg/);
    expect(r.out).toMatch(/docs\/no-tests: 1 documentation file\(s\)/);
  });

  test('without a pin file, a template source and an unread test-tree Markdown file still fail closed; a renamed or deleted Markdown file is docs', () => {
    const repo = fixture(null);
    repo.git('checkout', '-q', 'main');
    commit(repo, { 'notes/old.md': '# old\n', 'notes/gone.md': '# gone\n' }, 'notes');
    repo.git('push', '-q', 'origin', 'main');
    repo.git('checkout', '-q', 'feature');
    repo.git('merge', '-q', '--ff-only', 'main');
    repo.git('mv', 'notes/old.md', 'notes/new.md');
    commit(repo, { 'notes/gone.md': null }, 'rename and delete');
    const docs = lanes(repo);
    expect(docs.status).toBe(EXIT.ok);
    expect(docs.out).toContain('notes/new.md: docs/no-tests (empty lane)');
    expect(docs.out).toContain('notes/gone.md: docs/no-tests (empty lane)');
    commit(repo, { 'skills/review/SKILL.md.tmpl': '# {{PREAMBLE}}\n', 'test/notes.md': '# notes no test reads\n' });
    const r = lanes(repo);
    expect(r.status).toBe(EXIT.fail);
    expect(r.err).toContain('(PREGATE_NO_LANE)');
    expect(r.out).toContain('FAIL lanes — skills/review/SKILL.md.tmpl has no test lane');
    expect(r.out).toContain('FAIL lanes — test/notes.md has no test lane');
  });

  test('empty_lanes is read from the base branch only: the same key added on the branch does not clear a file', () => {
    const repo = fixture({ ...BASE_PREGATE, empty_lanes: ['**'] });
    commit(repo, { 'scripts/gen.sh': '#!/bin/sh\necho gen\n' });
    const code = lanes(repo);
    expect(code.status).toBe(EXIT.fail);
    expect(code.out).toContain('FAIL lanes — scripts/gen.sh has no test lane');
    const branch = fixture(BASE_PREGATE);
    commit(branch, { '.gstack/pregate.json': JSON.stringify({ ...BASE_PREGATE, empty_lanes: ['notes/**/*.txt'] }, null, 2) + '\n', 'notes/sketch.txt': 'not markdown\n' });
    const r = lanes(branch);
    expect(r.status).toBe(EXIT.fail);
    expect(r.out).toContain('FAIL lanes — notes/sketch.txt has no test lane');
  });
});
