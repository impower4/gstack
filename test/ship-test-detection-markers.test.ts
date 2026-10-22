/**
 * Regression: /ship Step 4 test-framework detection was blind to Django.
 *
 * A real Django project (manage.py + <app>/tests.py, green `python manage.py
 * test`, no pytest.ini and no tests/ directory) read as "no test framework",
 * so /ship bootstrapped pytest on top of a working suite. Same blindness hit
 * any config-less-but-tested project (Go *_test.go, in-source Rust #[test],
 * package.json with only a test script).
 *
 * These run the resolver's OWN emitted detection block against fixtures, so
 * the shell is checked, not just the prose — and the test is independent of
 * generated-SKILL.md regen state.
 *
 * Ported from time-attack/gstack commit e3259078 (GStack 2), adapted from the
 * fork's generated-markdown target to our resolver source of truth.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateTestBootstrap, generateTestCoverageAuditShip } from '../scripts/resolvers/testing';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { HOST_PATHS } from '../scripts/resolvers/types';

const section = generateTestBootstrap({} as never);

/** The detection block the skill tells the agent to run (first bash fence). */
function detectionScript(from: string = section): string {
  const open = from.indexOf('```bash\n');
  expect(open).toBeGreaterThan(-1);
  const start = open + '```bash\n'.length;
  const end = from.indexOf('```', start);
  return from.slice(start, end);
}

/** Run the detection block in a throwaway git repo laid out by `files`. */
function detect(files: Record<string, string>, script: string = detectionScript()): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-detect-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    const scriptPath = path.join(dir, '.detect.sh');
    fs.writeFileSync(scriptPath, script);
    const git = (...args: string[]) => execFileSync('git', args, { timeout: 30_000, cwd: dir });
    git('init', '-q', '.');
    git('add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
    // The block's last line is a `[ -f marker ] && echo`, so a clean project
    // exits 1 by design — read stdout, don't trust the status.
    return execFileSync('bash', [scriptPath], { timeout: 30_000, cwd: dir, encoding: 'utf-8' });
  } catch (err: unknown) {
    const e = err as { stdout?: string };
    if (typeof e.stdout === 'string') return e.stdout;
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const testFileCount = (out: string): number =>
  Number(/^TESTFILES:(\d+)$/m.exec(out)?.[1] ?? -1);

describe('/ship Step 4 detection is multi-ecosystem', () => {
  test('Django project reports manage.py and its existing tests', () => {
    const out = detect({
      'manage.py': '#!/usr/bin/env python\n',
      'requirements.txt': 'Django==5.0\n',
      'polls/tests.py': 'from django.test import TestCase\n',
    });
    expect(out).toContain('MARKER:manage.py');
    expect(out).toContain('FRAMEWORK:django');
    expect(testFileCount(out)).toBeGreaterThan(0);
  });

  test('config-less projects with tests still report test evidence', () => {
    expect(testFileCount(detect({
      'go.mod': 'module x\n',
      'x_test.go': 'package x\n',
    }))).toBeGreaterThan(0);

    const node = detect({
      'package.json': '{"name":"n","scripts":{"test":"node --test"}}\n',
    });
    expect(node).toContain('SCRIPT:package.json test');

    const rust = detect({
      'Cargo.toml': '[package]\nname="x"\n',
      'src/lib.rs': '#[cfg(test)]\nmod t{ #[test] fn x(){} }\n',
    });
    expect(rust).toContain('TESTS:rust in-source');
  });

  test('Dart and Flutter report their runtime, the Flutter SDK, and *_test.dart outside test/', () => {
    const flutter = detect({
      'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
      'lib/src/theme_test.dart': 'void main() {}\n',
    });
    expect(flutter).toContain('RUNTIME:dart');
    expect(flutter).toContain('FRAMEWORK:flutter');
    expect(testFileCount(flutter)).toBe(1);

    // A commented-out Flutter dependency is not Flutter.
    const dart = detect({ 'pubspec.yaml': 'name: x\n#  flutter:\n#    sdk: flutter\n', 'lib/x.dart': 'int x = 1;\n' });
    expect(dart).toContain('RUNTIME:dart');
    expect(dart).not.toContain('FRAMEWORK:flutter');
    expect(testFileCount(dart)).toBe(0);

    // dart_test.yaml can move discovery off *_test.dart (paths/filename), so it is test evidence on its own.
    const configured = detect({ 'pubspec.yaml': 'name: x\n', 'dart_test.yaml': 'paths: [checks]\n', 'checks/test_math.dart': 'void main() {}\n' });
    expect(configured).toContain('dart_test.yaml');
  });

  // Value: protects=the Step 7 coverage audit sees a Dart project and its *_test.dart files, like bootstrap does;
  //   fails_when=the coverage-audit block drops RUNTIME:dart or `dart` from its _test regex; why_new=only the
  //   bootstrap block was run; seam=none; no_claim=none beyond protects
  test('the Step 7 coverage-audit detection block agrees with bootstrap on Dart', () => {
    const audit = generateTestCoverageAuditShip({ host: 'claude', skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', paths: HOST_PATHS.claude } as never);
    const block = audit.slice(audit.indexOf('Test Framework Detection'));
    const out = detect({ 'pubspec.yaml': 'name: x\n', 'lib/src/theme_test.dart': 'void main() {}\n' }, detectionScript(block));
    expect(out).toContain('RUNTIME:dart');
    expect(testFileCount(out)).toBe(1);
  });

  test('a genuinely untested project reports no test evidence', () => {
    const out = detect({ 'go.mod': 'module x\n', 'x.go': 'package x\n' });
    expect(out).toContain('RUNTIME:go');
    expect(testFileCount(out)).toBe(0);
    expect(out).not.toContain('TESTS:');
  });

  test('every ecosystem marker maps to a command to OFFER, not to run blind', () => {
    expect(section).toContain('never a command to run blind');
    for (const marker of ['manage.py', 'go.mod', 'Cargo.toml', 'pom.xml',
      'build.gradle', 'mix.exs', 'composer.json', 'Gemfile', 'pytest.ini', 'pubspec.yaml']) {
      expect(section).toContain(marker);
    }
    // The ask-and-persist contract, not a hardcoded project command.
    expect(section).toContain('AskUserQuestion');
    expect(section).toContain('persist the answer to CLAUDE.md');
  });
});

// Value: protects=review-army STACK/TEST_FW name Dart and tell flutter_test from dart test; fails_when=the pubspec.yaml lines
//   are dropped or the Flutter grep matches any `sdk:` (environment.sdk), a comment, or misses a quoted value; why_new=no free test runs the review-army
//   detection lines; seam=none; no_claim=specialist selection from these values (only the emitted lines run)
describe('review-army stack detection names Dart and Flutter', () => {
  const block = generateReviewArmy({ host: 'claude', skillName: 'ship', tmplPath: 'ship/SKILL.md.tmpl', paths: HOST_PATHS.claude });
  const lines = (from: string, to: string): string => {
    const start = block.indexOf(from);
    const end = block.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return block.slice(start, block.indexOf('\n', end));
  };
  const script = `${lines('STACK=""', 'echo "STACK:')}\n${lines('TEST_FW=""', 'echo "TEST_FW:')}\n`;

  function stack(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-army-stack-'));
    try {
      for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
      return execFileSync('bash', ['-c', script], { timeout: 30_000, cwd: dir, encoding: 'utf-8' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('Flutter app, pure Dart package, and a Dart SDK constraint that is not Flutter', () => {
    // Quoted `sdk: "flutter"` is the same YAML value.
    const flutter = stack({ 'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: "flutter"\n' });
    expect(flutter).toContain('STACK: dart');
    expect(flutter).toContain('TEST_FW: flutter-test');

    const dart = stack({ 'pubspec.yaml': 'name: x\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n#    sdk: flutter\n' });
    expect(dart).toContain('STACK: dart');
    expect(dart).toContain('TEST_FW: dart-test');

    const none = stack({ 'README.md': 'x\n' });
    expect(none).toContain('STACK: unknown');
    expect(none).toContain('TEST_FW: unknown');
  });
});
