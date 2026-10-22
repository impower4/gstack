import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { ECHO_LIMIT, sanitizeEcho } from '../lib/sanitize-echo';

// The one echo sanitizer: lib/sanitize-echo.ts and its Bash twin
// bin/gstack-sanitize-echo.sh must agree byte for byte on every row, in every
// shell that sources the twin (the Bun floor check runs in zsh tool shells).

const ROOT = path.resolve(import.meta.dir, '..');
const TWIN = path.join(ROOT, 'bin', 'gstack-sanitize-echo.sh');
const hasZsh = spawnSync('zsh', ['-c', 'true'], { timeout: 10_000 }).status === 0;
const SHELLS: Array<[string, string[]]> = [['bash', ['bash']], ['bash --posix', ['bash', '--posix']], ...(hasZsh ? [['zsh', ['zsh']] as [string, string[]]] : [])];

const TABLE: Array<[string, string, string]> = [
  ['plain text', 'Bun 1.4.2', 'Bun 1.4.2'],
  ['a newline cannot start a state-file key', 'tar: failed\nstages=setup\nreason=x', 'tar: failed stages=setup reason=x'],
  ['CR, LF and TAB flatten', 'a\r\nb\tc', 'a b c'],
  ['ESC and other control bytes are removed', '\x1b[31mred\x1b[0m \x07bell\x7f', '[31mred[0m bell'],
  ['runs of spaces collapse and ends are trimmed', '   a  \n\n  b   ', 'a b'],
  ['empty', '', ''],
  ['only control bytes', '\x01\x02\x1b\x7f', ''],
  ['a path with spaces and non-ASCII letters is kept', "/Users/José Núñez/it's/.bun/bin/bun", "/Users/José Núñez/it's/.bun/bin/bun"],
  ['capped at 200 bytes', 'x'.repeat(300), 'x'.repeat(200)],
  ['a cap on a character boundary keeps the character', 'é'.repeat(150), 'é'.repeat(100)],
  ['a 2-byte character cut by the cap is dropped', `a${'é'.repeat(150)}`, `a${'é'.repeat(99)}`],
  ['a 3-byte character cut after 1 byte is dropped', `a${'€'.repeat(100)}`, `a${'€'.repeat(66)}`],
  ['a 3-byte character cut after 2 bytes is dropped', `${'€'.repeat(100)}`, `${'€'.repeat(66)}`],
  ['a 4-byte character cut after 3 bytes is dropped', `ab${'😀'.repeat(60)}`, `ab${'😀'.repeat(49)}`],
  ['a space before the cut is trimmed', `${'x'.repeat(199)} tail`, 'x'.repeat(199)],
];

function twin(shell: string[], text: string, viaStdin = false): string {
  const script = viaStdin ? '. "$1"; gstack_sanitize_echo' : '. "$1"; gstack_sanitize_echo "$2"';
  const r = spawnSync(shell[0]!, [...shell.slice(1), '-c', script, '_', TWIN, ...(viaStdin ? [] : [text])], {
    input: viaStdin ? text : undefined, encoding: 'utf8', timeout: 10_000,
  });
  expect(r.status).toBe(0);
  expect(r.stdout.endsWith('\n')).toBe(true);
  return r.stdout.slice(0, -1);
}

describe('sanitizeEcho (TypeScript)', () => {
  for (const [name, input, expected] of TABLE) test(name, () => expect(sanitizeEcho(input)).toBe(expected));
  test('output never exceeds the limit and is always valid UTF-8', () => {
    for (const [, input] of TABLE) {
      const out = sanitizeEcho(input);
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(ECHO_LIMIT);
      expect(out).not.toContain('\uFFFD');
    }
  });
});

describe.skipIf(process.platform === 'win32')('gstack_sanitize_echo (Bash twin)', () => {
  for (const [label, shell] of SHELLS) {
    test(`${label}: every row matches the TypeScript twin`, () => {
      expect(TABLE.map(([, input]) => twin(shell, input))).toEqual(TABLE.map(([, , expected]) => expected));
    });
  }
  test('stdin form strips NUL bytes too', () => {
    expect(twin(['bash'], 'a\0b\nc', true)).toBe(sanitizeEcho('a\0b\nc'));
    expect(sanitizeEcho('a\0b\nc')).toBe('ab c');
  });
});
