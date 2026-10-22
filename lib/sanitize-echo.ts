/**
 * The one sanitizer for an external string gstack echoes into a message, a log
 * line or a key=value state file: command output, stderr, a version string, a
 * path. Carriage returns, newlines and tabs become spaces, every other ASCII
 * control byte (ESC included) and DEL is removed, runs of spaces collapse, and
 * the result is at most ECHO_LIMIT bytes of valid UTF-8 with no leading or
 * trailing space. bin/gstack-sanitize-echo.sh is the Bash twin;
 * test/sanitize-echo.test.ts runs both on one table.
 */
export const ECHO_LIMIT = 200;

const SPACE = 0x20;

export function sanitizeEcho(text: string): string {
  const out: number[] = [];
  for (const byte of Buffer.from(text, 'utf8')) {
    const b = byte === 0x0d || byte === 0x0a || byte === 0x09 ? SPACE : byte;
    if (b < SPACE || b === 0x7f) continue;
    if (b === SPACE && (out.length === 0 || out[out.length - 1] === SPACE)) continue;
    out.push(b);
  }
  let bytes = out.slice(0, ECHO_LIMIT);
  const lead = (b: number | undefined, min: number) => b !== undefined && b >= min;
  const cont = (b: number | undefined) => b !== undefined && b >= 0x80 && b <= 0xbf;
  const n = bytes.length;
  if (lead(bytes[n - 3], 0xf0) && cont(bytes[n - 2]) && cont(bytes[n - 1])) bytes = bytes.slice(0, -3);
  else if (lead(bytes[n - 2], 0xe0) && cont(bytes[n - 1])) bytes = bytes.slice(0, -2);
  else if (lead(bytes[n - 1], 0xc0)) bytes = bytes.slice(0, -1);
  if (bytes[bytes.length - 1] === SPACE) bytes = bytes.slice(0, -1);
  return Buffer.from(bytes).toString('utf8');
}
