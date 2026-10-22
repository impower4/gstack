import * as fs from 'node:fs';
import { dlopen, FFIType, ptr } from 'bun:ffi';

/**
 * Process identity is `<platform>:<start time>` for a live PID. A recorded
 * identity that differs from the PID's current identity proves the PID was
 * recycled. Linux reads /proc start ticks; Windows reads the creation FILETIME
 * through GetProcessTimes; macOS reads proc_bsdinfo's start time. An
 * unreadable identity is `undefined`, never a guess.
 */
export const PROCESS_IDENTITY = /^(?:linux|win32|darwin):\d{1,20}$/;
const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;

type Win32Api = {
  OpenProcess: (access: number, inherit: number, pid: number) => number | bigint;
  GetProcessTimes: (handle: number | bigint, ...times: unknown[]) => number;
  CloseHandle: (handle: number | bigint) => number;
};
type DarwinApi = { proc_pidinfo: (...args: unknown[]) => number };
let win32Api: Win32Api | null | undefined, darwinApi: DarwinApi | null | undefined;

function readLinux(pid: number): string | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'),
      tail = raw
        .slice(raw.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
    return /^\d+$/.test(tail[19] ?? '') ? `linux:${tail[19]}` : undefined;
  } catch {
    return;
  }
}
function readWin32(pid: number): string | undefined {
  if (win32Api === undefined)
    try {
      win32Api = dlopen('kernel32.dll', {
        OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
        GetProcessTimes: {
          args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      }).symbols as unknown as Win32Api;
    } catch {
      win32Api = null;
    }
  if (!win32Api) return;
  const handle = win32Api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!handle) return;
  try {
    const times = new BigUint64Array(4);
    if (!win32Api.GetProcessTimes(handle, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24)))
      return;
    return times[0] > 0n ? `win32:${times[0]}` : undefined;
  } finally {
    win32Api.CloseHandle(handle);
  }
}
/** proc_bsdinfo: pbi_pid at byte 12, pbi_start_tvsec at 120, pbi_start_tvusec at 128. */
export function darwinIdentityFromBsdInfo(info: Uint8Array, pid: number): string | undefined {
  if (info.byteLength < PROC_BSDINFO_SIZE) return;
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength),
    seconds = view.getBigUint64(120, true),
    micros = view.getBigUint64(128, true);
  if (view.getUint32(12, true) !== pid || seconds === 0n || micros >= 1_000_000n) return;
  return `darwin:${seconds * 1_000_000n + micros}`;
}
function readDarwin(pid: number): string | undefined {
  if (darwinApi === undefined)
    try {
      darwinApi = dlopen('/usr/lib/libSystem.B.dylib', {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      }).symbols as unknown as DarwinApi;
    } catch {
      darwinApi = null;
    }
  if (!darwinApi) return;
  const info = new Uint8Array(PROC_BSDINFO_SIZE);
  if (darwinApi.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(info), PROC_BSDINFO_SIZE) !== PROC_BSDINFO_SIZE)
    return;
  return darwinIdentityFromBsdInfo(info, pid);
}
/** Wall-clock start (ms since the Unix epoch) encoded by a win32 or darwin identity; Linux ticks are boot-relative. */
export function identityStartedAtMs(identity: string): number | undefined {
  const match = identity.match(/^(win32|darwin):(\d{1,20})$/);
  if (!match) return;
  const value = BigInt(match[2]);
  return Number(match[1] === 'win32' ? value / 10_000n - FILETIME_UNIX_EPOCH_MS : value / 1_000n);
}
/** Mutable so tests can substitute another platform's identity source. */
export const processIdentitySource = {
  read(pid: number): string | undefined {
    if (!Number.isInteger(pid) || pid <= 1) return;
    try {
      if (process.platform === 'linux') return readLinux(pid);
      if (process.platform === 'win32') return readWin32(pid);
      if (process.platform === 'darwin') return readDarwin(pid);
    } catch {}
    return;
  },
};
