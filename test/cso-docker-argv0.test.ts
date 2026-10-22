import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { dockerExactImagePresent, runDocker } from '../lib/cso/docker';
import { childEnvironment, runProcess } from '../lib/cso/process';

// OrbStack installs docker as a symlink to a multicall binary that dispatches
// on argv[0]; the CSO resolves the symlink, so it must still pass "docker" as
// argv[0]. A #! script never sees argv[0], so the fake is compiled C.
const FAKE_MULTICALL = String.raw`
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  const char *slash = strrchr(argv[0], '/');
  const char *name = slash ? slash + 1 : argv[0];
  if (strcmp(name, "docker") != 0) {
    fprintf(stderr, "unsupported argv0 \"%s\"\n", name);
    return 127;
  }
  FILE *log = fopen(LOG_PATH, "a");
  if (log) {
    for (int i = 1; i < argc; i++) fprintf(log, "%s%s", i > 1 ? " " : "", argv[i]);
    fputc('\n', log);
    fclose(log);
  }
  if (argc >= 3 && strcmp(argv[1], "context") == 0 && strcmp(argv[2], "show") == 0) {
    puts("orbstack");
    return 0;
  }
  if (argc >= 3 && strcmp(argv[1], "image") == 0 && strcmp(argv[2], "inspect") == 0) {
    printf("{\"Os\":\"linux\",\"Architecture\":\"amd64\",\"Id\":\"sha256:%064d\",\"RepoDigests\":[\"%s\"],\"Config\":{\"Entrypoint\":[\"/opt/cso/entrypoint\"]}}\n", 0, argv[argc - 1]);
    return 0;
  }
  for (int i = 1; i < argc; i++)
    if (strcmp(argv[i], "ps") == 0 && strncmp(argv[argc - 1], "id=", 3) == 0) puts(argv[argc - 1] + 3);
  return 0;
}
`;

describe.skipIf(process.platform === 'win32')('CSO Docker invocation through a multicall binary', () => {
  let root = '';
  let multicall = '';
  let log = '';
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'cso-argv0-')));
    log = join(root, 'docker.log');
    const source = join(root, 'docker-tools.c');
    fs.writeFileSync(source, FAKE_MULTICALL);
    multicall = join(root, 'docker-tools');
    const built = spawnSync('/usr/bin/cc', ['-std=c11', `-DLOG_PATH="${log}"`, source, '-o', multicall], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(built.status).toBe(0);
    fs.symlinkSync('docker-tools', join(root, 'docker'));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the fake refuses its canonical name, as OrbStack does', async () => {
    const r = await runProcess(multicall, ['context', 'show'], {
      cwd: root,
      env: childEnvironment(root),
      raw: true,
    });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('unsupported argv0 "docker-tools"');
  });

  test('runDocker invokes the canonical path as docker', async () => {
    const r = await runDocker(multicall, ['context', 'show'], {
      cwd: root,
      env: childEnvironment(root),
      raw: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('orbstack');
  });

  test('a production image probe admits an image through the multicall binary', async () => {
    const socket = join(root, 'probe.sock');
    const server = net.createServer().listen(socket);
    await new Promise((done) => server.once('listening', done));
    try {
      const stat = fs.statSync(socket);
      const image = `registry.example/cso/semgrep@sha256:${'b'.repeat(64)}`;
      const present = await dockerExactImagePresent(
        { uri: `unix://${socket}`, socket, executable: multicall, device: stat.dev, inode: stat.ino },
        root,
        image,
        'linux/amd64',
      );
      expect(present).toBe(true);
      expect(fs.readFileSync(log, 'utf8')).toContain(`image inspect --format {{json .}} ${image}`);
    } finally {
      server.close();
    }
  });

  test('runProcess refuses an argv0 that is not a bare command name', async () => {
    await expect(
      runProcess(multicall, ['context', 'show'], { cwd: root, env: childEnvironment(root), argv0: '../docker' }),
    ).rejects.toThrow('Invalid child argv0');
  });

  test('the watchdog cleans up through the canonical multicall path', async () => {
    const watchdog = join(root, 'watchdog');
    const built = spawnSync(
      '/usr/bin/cc',
      [
        '-std=c11',
        '-D_POSIX_C_SOURCE=200809L',
        '-O2',
        resolve(import.meta.dir, '../lib/cso/watchdog.c'),
        '-o',
        watchdog,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    expect(built.status).toBe(0);
    const run = join(root, 'run');
    const lease = join(run, 'lease');
    fs.mkdirSync(lease, { recursive: true });
    const token = 'c'.repeat(32);
    fs.writeFileSync(join(lease, 'lease.json'), '{}');
    fs.writeFileSync(join(lease, 'lease.token'), `${token}\n`);
    const id = 'a'.repeat(64);
    fs.writeFileSync(join(run, 'resources.journal'), `container:${id}\n`, { mode: 0o600 });
    const socket = join(run, 'daemon.sock');
    const made = spawnSync('/usr/bin/python3', [
      '-c',
      'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()',
      socket,
    ], { timeout: 30_000 });
    expect(made.status).toBe(0);
    const stat = fs.lstatSync(socket);
    const owner = spawn('/bin/sleep', ['0.2'], { stdio: 'ignore' });
    const child = spawn(
      watchdog,
      [
        '--owner',
        String(owner.pid),
        '--deadline',
        String(Math.ceil((Date.now() + 10_000) / 1000)),
        '--run-dir',
        run,
        '--docker',
        multicall,
        '--endpoint',
        `unix://${socket}`,
        '--socket-device',
        String(stat.dev),
        '--socket-inode',
        String(stat.ino),
        '--run-label',
        'argv0-label',
        '--lease-path',
        lease,
        '--lease-token',
        token,
      ],
      { stdio: 'ignore' },
    );
    expect(await new Promise<number | null>((done) => child.on('close', done))).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain(`rm --force --volumes ${id}`);
    expect(fs.readFileSync(join(run, 'watchdog.event'), 'utf8')).toContain('cleanup complete');
    expect(fs.existsSync(lease)).toBe(false);
  });
});
