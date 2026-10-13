import { afterAll, describe, expect, it } from 'vitest';
import { DockerEnvironment } from '../src/providers/docker/index.ts';
import type { LogLine } from '../src/providers/types.ts';

// Opt-in: WORKSHOP_TEST_DOCKER_SOCKET=/var/run/docker.sock (or a Podman socket) npm test --workspace server
const socketPath = process.env.WORKSHOP_TEST_DOCKER_SOCKET;
const IMAGE = 'docker.io/library/alpine:3.22';

describe.skipIf(!socketPath)('DockerEnvironment against a real engine', () => {
  const env = new DockerEnvironment({ mode: 'socket', socketPath, slots: 1 }, {});
  const volume = `workshop-test-${Date.now()}`;
  afterAll(() => env.removeVolume(volume)); // also when the test fails

  it('writes files into a volume, streams both outputs (long lines intact), and re-attaches by skipping lines', async () => {
    await env.ensureImage(IMAGE);
    await env.createVolume(volume, { 'workshop.test': '1' });
    await env.createVolume(volume, {}); // idempotent
    const long = 'x'.repeat(50_000);
    const id = await env.start({
      image: IMAGE,
      cmd: ['sh', '-c', `cat /work/.workshop/prompt.md; echo oops >&2; printf '%s\\n' ${long}; echo done`],
      env: { GREETING: 'hi' },
      volume,
      labels: { 'workshop.test': '1' },
      files: { '.workshop/': '', '.workshop/prompt.md': 'hello\nworld\n' },
      memoryMb: 256,
    });

    const lines: LogLine[] = [];
    await env.follow(id, 0, (l) => lines.push(l));
    expect(await env.wait(id)).toMatchObject({ exitCode: 0, oomKilled: false });
    expect(lines.filter((l) => l.stream === 'stdout').map((l) => l.text)).toEqual(['hello', 'world', long, 'done']);
    expect(lines.filter((l) => l.stream === 'stderr').map((l) => l.text)).toEqual(['oops']);

    const rest: LogLine[] = [];
    await env.follow(id, 3, (l) => rest.push(l));
    expect(rest.map((l) => l.text)).toEqual([long, 'done']);

    expect((await env.list({ 'workshop.test': '1' })).map((c) => c.id)).toContain(id);
    await env.remove(id);
    expect(await env.inspect(id)).toBeNull();
  }, 120_000);
});
