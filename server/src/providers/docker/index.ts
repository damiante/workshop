import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import Docker from 'dockerode';
import type { ProviderInfo } from '../../api-types.ts';
import type { ContainerState, Environment, HostSpecs, LogLine, StepSpec } from '../types.ts';
import { tar } from './tar.ts';

export interface DockerConfig {
  mode: 'socket' | 'ssh' | 'tls';
  socketPath?: string;
  host?: string;
  port?: number;
  username?: string;
  /** SHA-256 of the SSH host key, pinned on first successful connection. */
  hostKey?: string;
  slots: number;
  cpus?: number;
  memoryGb?: number;
}

export interface DockerSecret {
  sshKey?: string;
  ca?: string;
  cert?: string;
  key?: string;
}

export const dockerInfo: ProviderInfo = {
  id: 'docker',
  kind: 'environment',
  name: 'Docker host',
  description: 'A machine running Docker (or Podman with its Docker-compatible API) where agent containers run.',
  fields: [
    {
      key: 'mode',
      label: 'Connect with',
      type: 'select',
      required: true,
      defaultValue: 'ssh',
      options: [
        { value: 'ssh', label: 'SSH (recommended for other machines)' },
        { value: 'socket', label: 'Local socket (this machine)' },
        { value: 'tls', label: 'TCP with mutual TLS' },
      ],
    },
    { key: 'socketPath', label: 'Socket path', type: 'text', placeholder: '/var/run/docker.sock', showIf: { key: 'mode', equals: ['socket'] }, help: 'Mount the socket into the Workshop container. This gives Workshop root-equivalent access to the machine.' },
    { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'build-box.local', showIf: { key: 'mode', equals: ['ssh', 'tls'] } },
    { key: 'port', label: 'Port', type: 'number', placeholder: '22 for SSH, 2376 for TLS', showIf: { key: 'mode', equals: ['ssh', 'tls'] } },
    { key: 'username', label: 'SSH user', type: 'text', required: true, showIf: { key: 'mode', equals: ['ssh'] }, help: 'Must be allowed to use Docker (for example, in the docker group). The host needs the docker CLI installed.' },
    { key: 'sshKey', label: 'SSH private key', type: 'textarea', secret: true, required: true, showIf: { key: 'mode', equals: ['ssh'] }, help: 'An unencrypted key used only by Workshop, e.g. from ssh-keygen -t ed25519 -N "". Add its public half to the user\'s ~/.ssh/authorized_keys.' },
    { key: 'ca', label: 'CA certificate', type: 'textarea', secret: true, required: true, showIf: { key: 'mode', equals: ['tls'] } },
    { key: 'cert', label: 'Client certificate', type: 'textarea', secret: true, required: true, showIf: { key: 'mode', equals: ['tls'] } },
    { key: 'key', label: 'Client key', type: 'textarea', secret: true, required: true, showIf: { key: 'mode', equals: ['tls'] } },
    { key: 'slots', label: 'Agents at once', type: 'number', required: true, defaultValue: 1, help: 'How many agent containers may run here at the same time.' },
    { key: 'cpus', label: 'CPUs per agent', type: 'number', defaultValue: 2 },
    { key: 'memoryGb', label: 'Memory per agent (GB)', type: 'number', defaultValue: 4 },
  ],
};

/** Splits a byte stream into lines, calling `onLine` for each one after the first `skip`. */
function lineWriter(stream: LogLine['stream'], counter: { seen: number; skip: number }, onLine: (l: LogLine) => void) {
  let pending = '';
  const emit = (text: string) => {
    if (counter.seen++ >= counter.skip) onLine({ stream, text });
  };
  return new Writable({
    write(chunk: Buffer, _enc, done) {
      pending += chunk.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, nl).replace(/\r$/, ''));
        pending = pending.slice(nl + 1);
      }
      done();
    },
    final(done) {
      if (pending) emit(pending);
      done();
    },
  });
}

const ignore = (...codes: number[]) => (err: { statusCode?: number }) => {
  if (!codes.includes(err.statusCode ?? 0)) throw err;
};

export class DockerEnvironment implements Environment {
  private docker: Docker;

  constructor(cfg: DockerConfig, secret: DockerSecret, onHostKey?: (fingerprint: string) => void) {
    if (cfg.mode === 'ssh') {
      this.docker = new Docker({
        protocol: 'ssh',
        host: cfg.host,
        port: cfg.port || 22,
        username: cfg.username,
        sshOptions: {
          privateKey: secret.sshKey,
          hostHash: 'sha256',
          // Trust on first use, then refuse a changed host key.
          hostVerifier: (fingerprint: string) => {
            if (!cfg.hostKey) {
              onHostKey?.(fingerprint);
              return true;
            }
            return fingerprint === cfg.hostKey;
          },
        },
      } as Docker.DockerOptions);
    } else if (cfg.mode === 'tls') {
      this.docker = new Docker({ protocol: 'https', host: cfg.host, port: cfg.port || 2376, ca: secret.ca, cert: secret.cert, key: secret.key });
    } else {
      this.docker = new Docker({ socketPath: cfg.socketPath || '/var/run/docker.sock' });
    }
  }

  async ping() {
    await this.docker.ping();
  }

  async describe(): Promise<HostSpecs> {
    const info = await this.docker.info();
    return {
      name: info.Name,
      cpus: info.NCPU,
      memoryMb: Math.round(info.MemTotal / 1048576),
      os: info.OperatingSystem,
      arch: info.Architecture,
      version: info.ServerVersion,
    };
  }

  async ensureImage(image: string) {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      const stream = await this.docker.pull(image);
      await new Promise((resolve, reject) => this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve(null))));
    }
  }

  async imageLabels(image: string) {
    const info = await this.docker.getImage(image).inspect().catch(ignore(404));
    return info?.Config?.Labels ?? {};
  }

  async createVolume(name: string, labels: Record<string, string>) {
    // Docker reuses an existing volume; Podman answers 409. Either way the volume exists.
    await this.docker.createVolume({ Name: name, Labels: labels }).catch(ignore(409));
  }

  async removeVolume(name: string) {
    await this.docker.getVolume(name).remove().catch(ignore(404));
  }

  async start(spec: StepSpec) {
    const container = await this.docker.createContainer({
      Image: spec.image,
      Cmd: spec.cmd,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: spec.labels,
      HostConfig: {
        Init: true,
        Mounts: spec.volume ? [{ Type: 'volume', Source: spec.volume, Target: '/work' }] : [],
        NanoCpus: spec.cpus ? Math.round(spec.cpus * 1e9) : undefined,
        Memory: spec.memoryMb ? Math.round(spec.memoryMb * 1048576) : undefined,
      },
    });
    if (spec.files) await container.putArchive(tar(spec.files), { path: '/work' });
    await container.start();
    return container.id;
  }

  async follow(id: string, skip: number, onLine: (line: LogLine) => void) {
    // No timestamps: Docker splits lines over 16 KB and would stamp each fragment, corrupting long JSON lines.
    const stream = (await this.docker.getContainer(id).logs({ follow: true, stdout: true, stderr: true })) as unknown as NodeJS.ReadableStream;
    const counter = { seen: 0, skip };
    const out = lineWriter('stdout', counter, onLine);
    const err = lineWriter('stderr', counter, onLine);
    this.docker.modem.demuxStream(stream, out, err);
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    out.end();
    err.end();
    await Promise.all([finished(out), finished(err)]);
  }

  async wait(id: string): Promise<ContainerState> {
    const container = this.docker.getContainer(id);
    const result = await container.wait();
    const info = await container.inspect();
    return { running: false, exitCode: result.StatusCode, oomKilled: info.State.OOMKilled };
  }

  async inspect(id: string): Promise<ContainerState | null> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return { running: info.State.Running, exitCode: info.State.ExitCode, oomKilled: info.State.OOMKilled };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async kill(id: string) {
    await this.docker.getContainer(id).kill().catch(ignore(304, 404, 409));
  }

  async remove(id: string) {
    await this.docker.getContainer(id).remove({ force: true }).catch(ignore(404));
  }

  async list(labels: Record<string, string>) {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) },
    });
    return containers.map((c) => ({ id: c.Id, labels: c.Labels, running: c.State === 'running' }));
  }
}
