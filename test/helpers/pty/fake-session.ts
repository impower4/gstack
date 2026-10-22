/**
 * Test-only fake PTY session driver. Feeds scripted frames on an injectable
 * clock through the runners' launch seam (`PtyDriver`), so the plan-skill
 * runners can be exercised without a CLI, a PTY, a model or real timers.
 *
 * A frame is shown when its trigger fires: `onInput` (the runner sent a
 * matching input) or `afterMs` of fake time since the previous frame. Shown
 * frames accumulate in the raw/visible history; the latest one is the
 * current viewport. Never import this from production helpers.
 */
import type { ClaudePtyOptions, ClaudePtySession } from './launch';
import type { PtyDriver } from './session';

export interface FakeSessionContext {
  /** Options the runner passed to `driver.launch`. */
  launch: ClaudePtyOptions;
  /** Current fake wall clock (ms since epoch). */
  now: number;
  /** Isolated CLAUDE_CONFIG_DIR stand-in, or null. */
  configDir: string | null;
  sent: readonly string[];
}

export interface FakeFrame {
  /** Viewport text shown by this frame; also appended to the session history. */
  screen: string;
  /** Show when the runner sends this exact input (string) or a matching one (RegExp). */
  onInput?: string | RegExp;
  /** Otherwise show after this much fake time since the previous frame. Default 0. */
  afterMs?: number;
  /** Side effect when shown, e.g. appending native transcript records. */
  effect?: (ctx: FakeSessionContext) => void;
  /** End the fake process with this exit code when shown. */
  exit?: number;
}

export interface FakePtyScript {
  frames: FakeFrame[];
  /** Directory exposed as `session.hermeticConfigDir`. Default null. */
  configDir?: string | null;
  /** Fake wall-clock start. Default: the real clock when the driver is created. */
  startAt?: number;
  /** Extra session fields (e.g. pending hook files) merged into the fake session. */
  session?: Partial<ClaudePtySession>;
}

export interface FakePtyDriver {
  driver: PtyDriver;
  /** Every input the runner sent, in order. */
  sent: string[];
  /** Every launch request, in order. */
  launches: ClaudePtyOptions[];
  /** Number of `close()` calls. */
  closes(): number;
  now(): number;
}

export function createFakePtyDriver(script: FakePtyScript): FakePtyDriver {
  const startAt = script.startAt ?? Date.now();
  const configDir = script.configDir ?? null;
  const sent: string[] = [];
  const launches: ClaudePtyOptions[] = [];
  let now = startAt;
  let closes = 0;
  let next = 0;
  let lastShownAt = startAt;
  let history = '';
  let screen = '';
  let lastMark = 0;
  let exitCode: number | null = null;
  let launched: ClaudePtyOptions | undefined;

  const context = (): FakeSessionContext => ({ launch: launched!, now, configDir, sent });
  const show = (frame: FakeFrame) => {
    next++;
    lastShownAt = now;
    screen = frame.screen;
    history += (history ? '\n' : '') + frame.screen;
    frame.effect?.(context());
    if (frame.exit !== undefined) exitCode = frame.exit;
  };
  const dueAt = (frame: FakeFrame | undefined) =>
    !launched || !frame || frame.onInput !== undefined || exitCode !== null ? Infinity : lastShownAt + (frame.afterMs ?? 0);
  const showDue = () => { while (dueAt(script.frames[next]) <= now) show(script.frames[next]!); };
  const advance = (ms: number) => {
    const target = now + Math.max(0, ms);
    while (dueAt(script.frames[next]) <= target) { now = Math.max(now, dueAt(script.frames[next])); show(script.frames[next]!); }
    now = target;
  };

  const session: ClaudePtySession = {
    send(data: string) {
      if (exitCode !== null) return;
      sent.push(data);
      const frame = script.frames[next];
      const trigger = frame?.onInput;
      if (trigger !== undefined && (typeof trigger === 'string' ? trigger === data : trigger.test(data))) show(frame!);
      showDue();
    },
    sendKey(key) {
      const keys = { Enter: '\r', Up: '\x1b[A', Down: '\x1b[B', Esc: '\x1b', Tab: '\t', ShiftTab: '\x1b[Z', CtrlC: '\x03' };
      session.send(keys[key]);
    },
    rawOutput: () => history,
    visibleText: () => history,
    currentScreen: async () => screen,
    currentScreenFrame: async () => ({ text: screen, rawEnd: history.length, styledText: [] }),
    mark: () => (lastMark = history.length),
    visibleSince: (marker?: number) => history.slice(marker ?? lastMark),
    async waitForOutput(since: number, timeoutMs: number) {
      if (history.length > since || exitCode !== null) return;
      const until = now + timeoutMs;
      while (history.length <= since && exitCode === null && now < until) advance(Math.min(until, dueAt(script.frames[next])) - now);
    },
    async waitForAny(patterns, opts) {
      const until = now + (opts?.timeoutMs ?? 60_000);
      for (;;) {
        if (exitCode !== null) throw new Error(`claude exited (code=${exitCode}) before any pattern matched.`);
        const visible = opts?.since !== undefined ? history.slice(opts.since) : history;
        for (const matched of patterns) {
          const index = typeof matched === 'string' ? visible.indexOf(matched) : visible.search(matched);
          if (index >= 0) return { matched, index };
        }
        if (now >= until) throw new Error(`Timed out after ${opts?.timeoutMs ?? 60_000}ms waiting for fake output`);
        advance(Math.min(opts?.pollMs ?? 250, until - now));
      }
    },
    async waitFor(pattern, opts) { await session.waitForAny([pattern], opts); },
    pid: () => undefined,
    exited: () => exitCode !== null,
    exitCode: () => exitCode,
    hermeticConfigDir: configDir,
    async close() { closes++; },
    ...script.session,
  };

  const driver: PtyDriver = {
    async launch(opts) {
      launches.push(opts);
      launched = opts;
      lastShownAt = now;
      showDue();
      return session;
    },
    now: () => now,
    monotonic: () => now - startAt,
    async sleep(ms: number) { advance(ms); },
  };
  return { driver, sent, launches, closes: () => closes, now: () => now };
}
