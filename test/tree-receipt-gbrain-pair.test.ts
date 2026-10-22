/**
 * Field list 2, W1 acceptance: gstack-tree-receipt proves a real gbrain stamp
 * commit (gbrain 3ffce57b27, "v0.60.270.0 chore(release): restamp onto master
 * v0.60.269.0", 14 one-line stamps) is `same-modulo-stamps` against its
 * parent under gbrain's committed .gstack/ship-policy.json (stamp_files plus
 * stamp_patterns), with negative controls: a non-stamp byte inside a stamp
 * file and a file outside stamp_files are both `changed`. Fixture:
 * test/fixtures/ship-queue/gbrain-stamp-pair.json.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { cleanup, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { gbrainPairRepo } from './helpers/ship-queue-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

function receipt(repo: FixtureRepo, gated: string, current: string) {
  const r = runBin(repo, 'gstack-tree-receipt', ['--gated', gated, '--current', current, '--base', 'main', '--json']);
  return { ...r, json: JSON.parse(r.out) };
}

describe('gbrain stamp pair under gbrain\'s committed policy', () => {
  test('the real stamp commit is same-modulo-stamps, every file a stamp by gbrain\'s rule', () => {
    const { repo, gated, stamp } = gbrainPairRepo();
    repos.push(repo);
    expect(runBin(repo, 'gstack-ship-policy', ['validate', '--policy-from', 'base', '--base', 'main']).out).toMatch(/^POLICY_VALID: origin\/main@/m);
    const head = stamp();
    const { json } = receipt(repo, gated, head);
    expect(json.old_version).toBe('0.60.269.0');
    expect(json.new_version).toBe('0.60.270.0');
    expect(json.tree).toBe('same-modulo-stamps');
    expect(json.residual).toEqual([]);
    expect(json.files.map((f: any) => `${f.path}:${f.verdict}:${f.rule}`).sort()).toEqual([
      '.claude-plugin/plugin.json:stamp:stamp_files', '.codex-plugin/plugin.json:stamp:stamp_files', 'BOOTSTRAP_FOR_AGENTS.md:stamp:stamp_files',
      'VERSION:stamp:version-file', 'openclaw.plugin.json:stamp:stamp_files', 'package.json:stamp:manifest-version',
      'plugin-variants/gbrain-coding/.claude-plugin/plugin.json:stamp:stamp_files', 'plugin-variants/gbrain-coding/.codex-plugin/plugin.json:stamp:stamp_files',
      'plugin-variants/gbrain-coding/README.md:stamp:stamp_files', 'plugin-variants/gbrain-daily/.claude-plugin/plugin.json:stamp:stamp_files',
      'plugin-variants/gbrain-daily/.codex-plugin/plugin.json:stamp:stamp_files', 'plugin-variants/gbrain-daily/README.md:stamp:stamp_files',
      'plugin/README.md:stamp:stamp_files', 'templates/bootstrap/template-repo/README.md:stamp:stamp_files',
    ]);
  }, 120_000);

  test('negative controls: a non-stamp byte in a stamp file, and a file outside stamp_files, are changes', () => {
    const { repo, gated, stamp } = gbrainPairRepo();
    repos.push(repo);
    stamp();
    const manifest = path.join(repo.work, '.claude-plugin', 'plugin.json');
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('Personal knowledge brain', 'Personal knowledge Brain'));
    repo.git('commit', '-qam', 'edit description');
    const edited = receipt(repo, gated, repo.git('rev-parse', 'HEAD'));
    expect(edited.status).toBe(EXIT.fail);
    expect(edited.json.tree).toBe('changed');
    expect(edited.json.residual).toEqual(['.claude-plugin/plugin.json']);
    fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'src', 'version.ts'), "export const VERSION = '0.60.270.0';\n");
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'add a file');
    const added = receipt(repo, gated, repo.git('rev-parse', 'HEAD'));
    expect(added.json.residual).toContain('src/version.ts');
  }, 120_000);
});
