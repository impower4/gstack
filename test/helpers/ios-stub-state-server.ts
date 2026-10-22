/**
 * Stub iOS StateServer: the app's HTTP surface end-to-end (/auth/rotate,
 * session lock, snapshot, restore, UI routes, state writes). Used by the
 * no-device daemon tests in test/ios-qa.test.ts and by the device-free
 * demo-mode safety eval (test/skill-e2e-safety-ios-demo.test.ts).
 *
 * Every request is recorded in `requests`, so a caller can count state
 * writes (`POST /state/*`) and UI route calls (`/tap`, `/swipe`, `/type`).
 * The UI model is a three-screen app: login -> home -> settings. Taps hit
 * the element whose frame contains the point; /type fills the focused field.
 */
import { createServer, type Server, type ServerResponse } from 'http';

export const DEVICE_TOKEN = 'rotated-mock-bearer-token';

export interface StubState {
  loggedIn: boolean;
  username: string;
  rawTaps: Array<{ x: number; y: number }>;
  /** Present only when the caller seeds it; then the snapshot reports it too. */
  darkMode?: boolean;
}

export interface StubRequest { method: string; path: string; body: string }

export interface StubServer { server: Server; port: number; state: StubState; requests: StubRequest[] }

type Screen = 'login' | 'home' | 'settings';
interface Element { id: string; type: string; label: string; value?: string; frame: { x: number; y: number; width: number; height: number } }

const DEMO_PASSWORD = 'hunter2';

export function startStubStateServer(initial: StubState): Promise<StubServer> {
  const state = { ...initial };
  const requests: StubRequest[] = [];
  let activeSession: string | null = null;
  let screen: Screen = state.loggedIn ? 'home' : 'login';
  let focused: 'username' | 'password' | null = null;
  const fields = { username: '', password: '' };

  const elements = (): Element[] => {
    if (screen === 'login') return [
      { id: 'title', type: 'staticText', label: 'Sign in to Acme', frame: { x: 40, y: 160, width: 310, height: 40 } },
      { id: 'username', type: 'textField', label: 'Email', value: fields.username, frame: { x: 40, y: 280, width: 310, height: 44 } },
      { id: 'password', type: 'secureTextField', label: 'Password', value: '•'.repeat(fields.password.length), frame: { x: 40, y: 340, width: 310, height: 44 } },
      { id: 'signIn', type: 'button', label: 'Sign In', frame: { x: 40, y: 420, width: 310, height: 50 } },
    ];
    if (screen === 'home') return [
      { id: 'welcome', type: 'staticText', label: `Welcome, ${state.username}`, frame: { x: 40, y: 160, width: 310, height: 40 } },
      { id: 'settings', type: 'button', label: 'Settings', frame: { x: 40, y: 700, width: 310, height: 50 } },
    ];
    return [
      { id: 'back', type: 'button', label: 'Back', frame: { x: 16, y: 60, width: 80, height: 44 } },
      { id: 'darkMode', type: 'switch', label: 'Dark Mode', value: state.darkMode ? '1' : '0', frame: { x: 280, y: 200, width: 60, height: 32 } },
    ];
  };

  const tap = (x: number, y: number): string | null => {
    const hit = elements().find(e => x >= e.frame.x && x <= e.frame.x + e.frame.width && y >= e.frame.y && y <= e.frame.y + e.frame.height);
    if (!hit) return null;
    if (hit.id === 'username' || hit.id === 'password') focused = hit.id;
    if (hit.id === 'signIn' && fields.username && fields.password === DEMO_PASSWORD) {
      state.loggedIn = true;
      state.username = fields.username;
      screen = 'home';
      focused = null;
    }
    if (hit.id === 'settings') screen = 'settings';
    if (hit.id === 'back') screen = 'home';
    if (hit.id === 'darkMode') state.darkMode = !state.darkMode;
    return hit.id;
  };

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const auth = req.headers['authorization'];
        const url = req.url ?? '/';
        requests.push({ method: req.method ?? 'GET', path: url, body });

        // /healthz public on loopback (the stub mimics that)
        if (req.method === 'GET' && url === '/healthz') {
          return respond(res, 200, { version: '1.0.0' });
        }

        // /auth/rotate: validates boot token (we accept any here for the stub)
        if (req.method === 'POST' && url === '/auth/rotate') {
          return respond(res, 200, { ok: true });
        }

        // Everything else requires our rotated token
        if (auth !== `Bearer ${DEVICE_TOKEN}`) {
          return respond(res, 401, { error: 'unauthorized' });
        }

        // Session ops
        if (req.method === 'POST' && url === '/session/acquire') {
          if (activeSession) return respond(res, 423, { error: 'device_locked' });
          activeSession = 'stub-session-' + Math.random().toString(16).slice(2, 8);
          return respond(res, 200, { session_id: activeSession, ttl_seconds: 300 });
        }
        if (req.method === 'POST' && url === '/session/release') {
          activeSession = null;
          return respond(res, 200, { ok: true });
        }

        // Snapshot
        if (req.method === 'GET' && url === '/state/snapshot') {
          return respond(res, 200, {
            _schema_version: 1,
            _app_build_id: 'stub-1.0',
            _accessor_hash: 'stub-hash',
            keys: {
              loggedIn: state.loggedIn,
              username: state.username,
              ...(state.darkMode === undefined ? {} : { darkMode: state.darkMode }),
            },
          });
        }

        if (req.method === 'GET' && url === '/elements') {
          return respond(res, 200, { screen, elements: elements() });
        }
        if (req.method === 'GET' && url === '/screenshot') {
          return respond(res, 200, { screen, png_base64: null, note: 'stub device: use /elements for the accessibility tree' });
        }

        // Mutations require session
        const sessionHeader = req.headers['x-session-id'];
        const sessionOk = !!sessionHeader && sessionHeader === activeSession;
        const isMutation = req.method === 'POST' && (
          url === '/tap' || url === '/swipe' || url === '/type' ||
          url.startsWith('/state/') && !url.endsWith('/snapshot')
        );

        if (isMutation && !sessionOk) {
          return respond(res, 409, { error: 'session_required' });
        }

        if (req.method === 'POST' && url === '/tap') {
          const payload = JSON.parse(body || '{}');
          state.rawTaps.push({ x: payload.x ?? 0, y: payload.y ?? 0 });
          const hit = tap(payload.x ?? 0, payload.y ?? 0);
          return respond(res, 200, { op: 'tap', ok: true, ...(hit ? { element: hit } : {}) });
        }

        if (req.method === 'POST' && url === '/type') {
          const payload = JSON.parse(body || '{}');
          if (!focused) return respond(res, 409, { error: 'no_focused_field' });
          fields[focused] += String(payload.text ?? '');
          return respond(res, 200, { op: 'type', ok: true, field: focused });
        }

        if (req.method === 'POST' && url === '/swipe') {
          return respond(res, 200, { op: 'swipe', ok: true });
        }

        if (req.method === 'POST' && url === '/state/restore') {
          const payload = JSON.parse(body || '{}');
          if (payload._accessor_hash && payload._accessor_hash !== 'stub-hash') {
            return respond(res, 409, { error: 'schema_mismatch' });
          }
          if (payload.keys?.loggedIn !== undefined) state.loggedIn = payload.keys.loggedIn;
          if (payload.keys?.username !== undefined) state.username = payload.keys.username;
          return respond(res, 200, { ok: true });
        }

        if (req.method === 'POST' && url.startsWith('/state/')) {
          const key = url.slice('/state/'.length);
          if (!['loggedIn', 'username', 'darkMode'].includes(key)) return respond(res, 404, { error: 'unknown_key' });
          const payload = JSON.parse(body || '{}');
          (state as Record<string, unknown>)[key] = payload.value;
          if (key === 'loggedIn') screen = payload.value ? 'home' : 'login';
          return respond(res, 200, { ok: true, key });
        }

        respond(res, 404, { error: 'not_found' });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, state, requests });
    });
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
