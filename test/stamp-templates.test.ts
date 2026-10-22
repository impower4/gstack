/**
 * Field wave CD3: which files count as stamps is the repo's rule. Ship policy
 * `stamp_files` is an explicit allowlist applied before any stamp rule;
 * `stamp_patterns` are literal templates with one `{version}` slot (no free
 * regex), shared by the restamp writer and the tree-receipt classifier.
 * Field incident: a pure gbrain restamp from 0.60.188.0 to 0.60.189.0 read
 * `TREE: changed` for 13 of 16 files because `since: '…'`, `"version": "…"`
 * and `<!-- …-stamp: … -->` were outside gstack's three built-in forms.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { rewriteStamps } from '../lib/restamp';
import { validatePolicy } from '../lib/ship-policy';
import { BASE_POLICY, cleanup, makeFixtureRepo, makePr, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const TEMPLATES = ['"version": "{version}"', '<!-- x-plugin-tree-stamp: {version} -->', "since: '{version}'"];
const STAMP_POLICY = { ...BASE_POLICY, release_tool: null, stamp_paths: ['docs/**'], stamp_files: ['VERSION', 'package.json', 'plugin/**', 'src/notice.ts'], stamp_patterns: TEMPLATES };

function stampedFiles(v: string, docs = 'Added in v1.2.4.0.\n'): Record<string, string> {
  return {
    VERSION: `${v}\n`,
    'plugin/.claude-plugin/plugin.json': `{\n  "name": "x",\n  "version": "${v}",\n  "description": "d"\n}\n`,
    'plugin/README.md': `# plugin\n<!-- x-plugin-tree-stamp: ${v} -->\n`,
    'src/notice.ts': `export const ROWS = [\n  { since: '${v}', key: 'k' },\n];\n`,
    'docs/guide.md': docs,
  };
}
function commitFiles(repo: FixtureRepo, files: Record<string, string>, msg: string): string {
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo.work, rel)), { recursive: true }); fs.writeFileSync(path.join(repo.work, rel), body); }
  const pkg = JSON.parse(fs.readFileSync(path.join(repo.work, 'package.json'), 'utf8'));
  pkg.version = files.VERSION!.trim().split('.').slice(0, 3).join('.');
  fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  repo.git('add', '-A'); repo.git('commit', '-q', '-m', msg);
  return repo.git('rev-parse', 'HEAD');
}

describe('stamp templates (pure)', () => {
  test('rewriteStamps applies literal {version} templates beside the three built-in forms, at version boundaries only', () => {
    expect(rewriteStamps("{ since: '1.2.3.0', x }", '1.2.3.0', '1.2.4.0', ["since: '{version}'"])).toEqual({ text: "{ since: '1.2.4.0', x }", count: 1 });
    expect(rewriteStamps('"version": "1.2.3.0",', '1.2.3.0', '1.2.4.0', ['"version": "{version}"']).count).toBe(1);
    expect(rewriteStamps('<!-- x-plugin-tree-stamp: 1.2.3.0 -->', '1.2.3.0', '1.2.4.0', ['<!-- x-plugin-tree-stamp: {version} -->']).text).toBe('<!-- x-plugin-tree-stamp: 1.2.4.0 -->');
    expect(rewriteStamps("since: '1.2.3.01'", '1.2.3.0', '1.2.4.0', ["since: '{version}'"]).count).toBe(0);
    expect(rewriteStamps("since: '1.2.3.0'", '1.2.3.0', '1.2.4.0').count).toBe(0);
  });

  test('policy: stamp_patterns are bounded literal templates with exactly one {version}; stamp_files are contained globs', () => {
    const codes = (p: unknown) => validatePolicy(p).map(e => `${e.code}:${e.path}`);
    expect(codes(STAMP_POLICY)).toEqual([]);
    expect(codes({ stamp_patterns: ['no slot'] })).toEqual(['POLICY_INVALID:stamp_patterns[0]']);
    expect(codes({ stamp_patterns: ['{version} and {version}'] })).toEqual(['POLICY_INVALID:stamp_patterns[0]']);
    expect(codes({ stamp_patterns: ['x'.repeat(130) + '{version}'] })).toEqual(['POLICY_CONTAINMENT:stamp_patterns[0]']);
    expect(codes({ stamp_patterns: Array.from({ length: 17 }, (_, i) => `k${i}: {version}`) })).toEqual(['POLICY_CONTAINMENT:stamp_patterns']);
    expect(codes({ stamp_files: ['../VERSION'] })).toEqual(['POLICY_CONTAINMENT:stamp_files[0]']);
  });
});

describe('tree receipt under the repo stamp rule', () => {
  test('a pure restamp across a manifest, a stamp comment and a since row is same-modulo-stamps; a doc vX mention outside stamp_files is a difference', () => {
    const repo = makeFixtureRepo({ prefix: 'stamp-templates-', policy: STAMP_POLICY }); repos.push(repo);
    makePr(repo, 'pr-a', { changelog: false });
    const gated = commitFiles(repo, stampedFiles('1.2.4.0'), 'stamp 1.2.4.0');
    commitFiles(repo, stampedFiles('1.2.5.0'), 'restamp 1.2.5.0');
    const r = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', gated]);
    expect(r.out).toMatch(/^ {2}stamp {3}plugin\/\.claude-plugin\/plugin\.json \(stamp_files\)$/m);
    expect(r.out).toMatch(/^ {2}stamp {3}plugin\/README\.md \(stamp_files\)$/m);
    expect(r.out).toMatch(/^ {2}stamp {3}src\/notice\.ts \(stamp_files\)$/m);
    expect(r.out).toMatch(/^ {2}stamp {3}VERSION \(version-file\)$/m);
    expect(r.out).toMatch(/^TREE: same-modulo-stamps$/m);
    commitFiles(repo, stampedFiles('1.2.5.0', 'Added in v1.2.5.0.\n'), 'doc mention');
    const d = runBin(repo, 'gstack-tree-receipt', ['--base', 'main', '--gated', gated]);
    expect(d.status).toBe(EXIT.fail);
    expect(d.out).toMatch(/^ {2}changed docs\/guide\.md \(stamp_files: not in the repo's stamp_files allowlist\)$/m);
    expect(d.out).toMatch(/^TREE: changed \(docs\/guide\.md\)$/m);
  });
});
