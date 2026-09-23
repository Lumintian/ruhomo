#!/usr/bin/env node
// Downloads the pinned Mihomo test kernel into .cache/mihomo/ and verifies
// its SHA-256 against the digest published on the GitHub release. The binary
// is only used by tests/integration; it is never installed system-wide.
//
// Set MIHOMO_BIN to use an existing binary instead (its version is still
// checked by the integration suite).
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const MIHOMO_VERSION = 'v1.19.31';
// Tag v1.19.31 -> commit ab405bad5beeeac8b003bb01f60f134f6df54471.
// Digests copied from the release asset metadata (sha256 of the .gz file).
const ASSETS = {
  'linux-x64': ['mihomo-linux-amd64-compatible-v1.19.31.gz', '04cf9f09671704f839ddbee2e93069dc831a4123a75281e725d1d96ab9ac1afc'],
  'linux-arm64': ['mihomo-linux-arm64-v1.19.31.gz', '9e0f11afbf38426b8bd88fdc594678f8161c57eccb4e1b77acb12b493904f1d4'],
  'darwin-arm64': ['mihomo-darwin-arm64-v1.19.31.gz', 'd131f44b3deb2a8356f7ac75048ad67a10d53243323951c4f3cda7b672922963'],
  'darwin-x64': ['mihomo-darwin-amd64-compatible-v1.19.31.gz', 'fb6fca0e105b4310a21eaacd3a8d3853d3d8b87fa4c69737bea52a30a435aac7'],
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const cacheDir = join(root, '.cache', 'mihomo', MIHOMO_VERSION);
export const binaryPath = join(cacheDir, 'mihomo');

async function main() {
  if (process.env.MIHOMO_BIN) {
    console.log(`[fetch-mihomo] using MIHOMO_BIN=${process.env.MIHOMO_BIN}`);
    return;
  }
  const key = `${process.platform}-${process.arch}`;
  const asset = ASSETS[key];
  if (!asset) {
    console.error(`[fetch-mihomo] no pinned Mihomo asset for ${key}; set MIHOMO_BIN to a ${MIHOMO_VERSION} binary`);
    process.exit(1);
  }
  const [name, sha256] = asset;
  const stamp = join(cacheDir, 'SHA256');
  if (existsSync(binaryPath) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === sha256) {
    console.log(`[fetch-mihomo] cached ${name} (sha256 ${sha256.slice(0, 12)}…)`);
    return;
  }
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${name}`;
  console.log(`[fetch-mihomo] downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(gz).digest('hex');
  if (actual !== sha256) throw new Error(`sha256 mismatch for ${name}: expected ${sha256}, got ${actual}`);
  mkdirSync(cacheDir, { recursive: true });
  const tmp = `${binaryPath}.tmp`;
  writeFileSync(tmp, gunzipSync(gz));
  chmodSync(tmp, 0o755);
  renameSync(tmp, binaryPath);
  writeFileSync(stamp, `${sha256}\n`);
  console.log(`[fetch-mihomo] verified and extracted to ${binaryPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[fetch-mihomo] ${e.message}`);
    process.exit(1);
  });
}
