import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createApp } from '../../apps/worker/src/app.ts';
import { binaryPath } from '../../scripts/fetch-mihomo.mjs';

export const MIHOMO_BIN: string = process.env.MIHOMO_BIN ?? binaryPath;
export const SOURCE_URL = 'https://raw.githubusercontent.com/ruhomo-test/fixtures/main/rules.txt';

export interface Upstream {
  status: number;
  body: string;
}

/** The real Worker app on a loopback HTTP server, with an in-memory upstream. */
export async function startService(upstream: Upstream) {
  const app = createApp({
    upstreamFetch: (async (input: string | URL | Request) => {
      if (String(input) !== SOURCE_URL) return new Response('not found', { status: 404 });
      return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }) as typeof fetch,
    log: () => {},
  });
  const env: Record<string, string> = { CACHE_FRESH_SECONDS: '0', CACHE_STALE_SECONDS: '0' };
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const response = await app.request(url, { method: req.method ?? 'GET', headers }, env);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.PUBLIC_BASE_URL = base;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export function baseConfig(): Record<string, unknown> {
  return {
    'mixed-port': 0,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'debug',
    ipv6: false,
    'geo-auto-update': false,
    'find-process-mode': 'off',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    dns: { enable: false },
    proxies: [],
    'proxy-groups': [
      { name: '示例代理', type: 'select', proxies: ['DIRECT'] },
      { name: '默认代理', type: 'select', proxies: ['DIRECT', 'REJECT'] },
    ],
    rules: ['DOMAIN-SUFFIX,original.example,DIRECT', 'MATCH,默认代理'],
  };
}

export interface Kernel {
  dir: string;
  logs: () => string;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<{ status: number; body: T }>;
  pid: number | undefined;
  stop: () => Promise<void>;
}

/** Checks a config with `mihomo -t` in an isolated home directory. */
export function testConfig(config: Record<string, unknown>): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ruhomo-mihomo-t-'));
  try {
    writeFileSync(join(dir, 'config.yaml'), stringify(config));
    const r = spawnSync(MIHOMO_BIN, ['-d', dir, '-f', join(dir, 'config.yaml'), '-t'], { encoding: 'utf8', timeout: 30_000 });
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Starts an isolated kernel with a random-secret controller on loopback. */
export async function startKernel(config: Record<string, unknown>): Promise<Kernel> {
  const dir = mkdtempSync(join(tmpdir(), 'ruhomo-mihomo-'));
  const port = await freePort();
  const secret = randomBytes(16).toString('hex');
  writeFileSync(join(dir, 'config.yaml'), stringify({ ...config, 'external-controller': `127.0.0.1:${port}`, secret }));
  let output = '';
  const child: ChildProcess = spawn(MIHOMO_BIN, ['-d', dir, '-f', join(dir, 'config.yaml')], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d) => (output += String(d)));
  child.stderr!.on('data', (d) => (output += String(d)));
  const api = async <T,>(path: string, init: RequestInit = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${secret}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: body as T };
  };
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`mihomo exited early:\n${output}`);
    try {
      if ((await api('/version')).status === 200) break;
    } catch {
      // controller not up yet
    }
    if (Date.now() > deadline) throw new Error(`mihomo controller did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    dir,
    logs: () => output,
    api,
    pid: child.pid,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ProviderInfo {
  name: string;
  ruleCount: number;
  vehicleType: string;
  behavior: string;
  format: string;
}

export async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
