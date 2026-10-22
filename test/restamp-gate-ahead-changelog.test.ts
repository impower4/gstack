/**
 * GBRA-102 diagnosis (field list 2, W1, premise P-i): a lane gating ahead of a
 * predecessor whose stamped CHANGELOG entry already sits above the base's top
 * entry. The refusal the gbrain coordinator anticipated ("restamp may refuse
 * due to #6754's entry above master") belongs to gbrain's own
 * `bun run release:restamp` (scripts/release-restamp.ts capture(): "this
 * branch has 2 CHANGELOG entries above master's"), which merges into the lane
 * branch itself. gstack-restamp --after merges in a throwaway worktree and
 * resolves the CHANGELOG with lib/changelog-check mergeChangelogs, so that
 * shape stamps cleanly here. The fixture found a different defect instead:
 * when both PRs carried the same tentative stamp (gstack's own queue
 * convention), the merge dropped the branch's entry and re-headed the
 * predecessor's. Real subprocesses on fixture repos, each with a timeout.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EXIT } from '../lib/headless-artifacts';
import { mergeChangelogs } from '../lib/changelog-check';
import { cleanup, makeFixtureRepo, makePr, readFile, restamp, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const headings = (text: string) => text.split('\n').filter(l => l.startsWith('## '));

/** Predecessor #1 stamped at base + PATCH (its entry above the base's), then the lane branch in the given shape. */
function queueOfTwo(shape: 'unreleased' | 'tentative' | 'none'): FixtureRepo {
  const repo = makeFixtureRepo();
  repos.push(repo);
  makePr(repo, 'pr-a');
  expect(restamp(repo, ['--next', '--pr', '1']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp a');
  makePr(repo, 'pr-b', { changelog: shape !== 'none' });
  if (shape === 'tentative') {
    expect(restamp(repo, ['--next', '--pr', '2']).status).toBe(EXIT.ok);
    repo.git('commit', '-qam', 'tentative stamp b');
  }
  return repo;
}

function gatedChangelog(repo: FixtureRepo): { text: string; tree: string } {
  const rec = JSON.parse(readFile(repo, '.gstack/tmp/gate-ahead.json'));
  return { text: repo.git('show', `${rec.gated_head}:CHANGELOG.md`), tree: rec.gated_tree };
}

describe('GBRA-102: gate-ahead over a predecessor entry above the base', () => {
  test('the GBRA-102 shape (predecessor stamped, lane entry under [Unreleased]) stamps N+1 above the predecessor; no refusal', () => {
    const repo = queueOfTwo('unreleased');
    const r = restamp(repo, ['--after', '1', '--predecessor-ref', 'pr-a', '--pr', '2']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('stage changelog: done (Unreleased -> 1.2.5.0)');
    const { text } = gatedChangelog(repo);
    expect(headings(text).map(h => /\[([^\]]+)\]/.exec(h)![1])).toEqual(['1.2.5.0', '1.2.4.0', '1.2.3.0', '1.2.2.0']);
    expect(text).toMatch(/## \[1\.2\.5\.0\][^\n]*\n\n- pr-b change\n\n## \[1\.2\.4\.0\][^\n]*\n\n- pr-a change/);
  }, 120_000);

  test('both PRs carried the same tentative stamp: the lane keeps its own entry and gates the same tree as the [Unreleased] shape', () => {
    const reference = queueOfTwo('unreleased');
    expect(restamp(reference, ['--after', '1', '--predecessor-ref', 'pr-a', '--pr', '2']).status).toBe(EXIT.ok);
    const repo = queueOfTwo('tentative');
    expect(headings(readFile(repo, 'CHANGELOG.md'))[0]).toMatch(/^## \[1\.2\.4\.0\]/);
    const r = restamp(repo, ['--after', '1', '--predecessor-ref', 'pr-a', '--pr', '2']);
    expect(r.status).toBe(EXIT.ok);
    const { text, tree } = gatedChangelog(repo);
    expect(text).toContain('- pr-b change');
    expect(text).toContain('- pr-a change');
    expect(text).toMatch(/## \[1\.2\.5\.0\][^\n]*\n\n- pr-b change\n\n## \[1\.2\.4\.0\][^\n]*\n\n- pr-a change/);
    expect(tree).toBe(gatedChangelog(reference).tree);
  }, 120_000);

  test('a lane with no entry of its own refuses with CHANGELOG_SECTION_MISSING and writes nothing', () => {
    const repo = queueOfTwo('none');
    const head = repo.git('rev-parse', 'HEAD');
    const r = restamp(repo, ['--after', '1', '--predecessor-ref', 'pr-a', '--pr', '2']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/no \[Unreleased\] section; nothing written.*\(CHANGELOG_SECTION_MISSING\)/);
    expect(repo.git('rev-parse', 'HEAD')).toBe(head);
    expect(repo.git('status', '--porcelain')).toBe('');
  }, 120_000);
});

describe('mergeChangelogs: a version heading both sides took', () => {
  const base = '## [1.2.3.0] - d\n\n- base\n';
  test('the branch top entry under the predecessor\'s heading becomes [Unreleased], placed first', () => {
    expect(mergeChangelogs(`# C\n\n## [1.2.4.0] - d\n\n- mine\n\n${base}`, `# C\n\n## [1.2.4.0] - e\n\n- theirs\n\n${base}`))
      .toBe(`# C\n\n## [Unreleased]\n\n- mine\n\n## [1.2.4.0] - e\n\n- theirs\n\n${base}`);
  });
  test('an identical section on both sides is shared history, never the branch entry', () => {
    expect(mergeChangelogs(`# C\n\n## [Unreleased]\n\n- mine\n\n${base}`, `# C\n\n## [1.2.4.0] - e\n\n- theirs\n\n${base}`))
      .toBe(`# C\n\n## [Unreleased]\n\n- mine\n\n## [1.2.4.0] - e\n\n- theirs\n\n${base}`);
  });
  test('a taken heading plus an [Unreleased] block on the branch, or on the predecessor, is a real conflict', () => {
    expect(mergeChangelogs(`# C\n\n## [1.2.4.0] - d\n\n- mine\n\n## [Unreleased]\n\n- more\n\n${base}`, `# C\n\n## [1.2.4.0] - e\n\n- theirs\n\n${base}`)).toBeNull();
    expect(mergeChangelogs(`# C\n\n## [1.2.4.0] - d\n\n- mine\n\n${base}`, `# C\n\n## [Unreleased]\n\n- x\n\n## [1.2.4.0] - e\n\n- theirs\n\n${base}`)).toBeNull();
  });
});
