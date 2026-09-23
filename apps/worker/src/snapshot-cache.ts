/**
 * On-demand snapshot loading shared by every endpoint (providers, overrides,
 * inspect). One source descriptor is fetched and compiled once; all views
 * are derived from that single immutable snapshot.
 *
 * Layers (all best effort — this is a cache, not persistent storage):
 *  1. a bounded in-isolate LRU plus in-flight request coalescing;
 *  2. an optional persistent store (Workers Cache API), per data center.
 * Neither layer is a cross-isolate or cross-data-center lock, and there is
 * no cross-request atomicity between different providers.
 *
 * Freshness is tracked by the application, not by HTTP headers:
 *  - `validatedAt` is the time of the last successful validation (200+compile
 *    or a 304 answered for the validators we hold);
 *  - a failure never updates `validatedAt`, so it cannot extend the stale
 *    window, and never replaces a good snapshot;
 *  - within `freshMs` the snapshot is served without upstream contact;
 *  - after that, a bounded revalidation runs; if it fails and the snapshot is
 *    younger than `staleMs`, it is served marked stale, otherwise the error
 *    surfaces as a non-2xx response.
 */
import type { Diagnostic, InputFormat, Limits, Snapshot } from '@ruhomo/core';
import { COMPILER_VERSION, compile, sha256Hex } from '@ruhomo/core';
import type { FetchOutcome, Validators } from './source-fetcher.ts';
import { SourceError } from './source-fetcher.ts';

export interface SourceDescriptor {
  url: string;
  format: InputFormat;
}

export interface CachedSnapshot {
  key: string;
  compilerVersion: string;
  snapshot: Snapshot;
  validatedAt: number;
  etag?: string | undefined;
  lastModified?: string | undefined;
}

export interface ErrorSummary {
  code: string;
  message: string;
}

export type CacheStatus = 'hit' | 'miss' | 'revalidated' | 'stale';

export interface SnapshotResult {
  entry: CachedSnapshot;
  stale: boolean;
  cacheStatus: CacheStatus;
  lastError?: ErrorSummary;
}

/** Thrown when no usable snapshot exists; carries compile diagnostics if any. */
export class SnapshotUnavailableError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnostics: Diagnostic[];
  constructor(code: string, status: number, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'SnapshotUnavailableError';
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

export interface PersistentStore {
  get(key: string): Promise<CachedSnapshot | undefined>;
  put(entry: CachedSnapshot, ttlSeconds: number): Promise<void>;
}

/** Minimal subset of the Workers Cache interface. */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

/** Persists complete successful snapshots in the Workers Cache API. */
export class CacheApiStore implements PersistentStore {
  private readonly cache: CacheLike;
  private readonly keyBase: string;
  constructor(cache: CacheLike, keyBase: string) {
    this.cache = cache;
    this.keyBase = `${keyBase.replace(/\/+$/, '')}/__ruhomo-snapshot/v1/`;
  }

  async get(key: string): Promise<CachedSnapshot | undefined> {
    const res = await this.cache.match(this.keyBase + key);
    if (!res) return undefined;
    const value = (await res.json()) as Partial<CachedSnapshot>;
    if (
      value.key !== key ||
      value.compilerVersion !== COMPILER_VERSION ||
      typeof value.validatedAt !== 'number' ||
      typeof value.snapshot !== 'object'
    ) {
      return undefined;
    }
    return value as CachedSnapshot;
  }

  async put(entry: CachedSnapshot, ttlSeconds: number): Promise<void> {
    await this.cache.put(
      this.keyBase + entry.key,
      new Response(JSON.stringify(entry), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${Math.max(1, ttlSeconds)}` },
      }),
    );
  }
}

class BoundedLru<V> {
  private readonly map = new Map<string, { value: V; size: number }>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, size = 1): void {
    const prev = this.map.get(key);
    if (prev) {
      this.bytes -= prev.size;
      this.map.delete(key);
    }
    if (size > this.maxBytes) return;
    this.map.set(key, { value, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value as string;
      this.bytes -= this.map.get(oldest)!.size;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    const prev = this.map.get(key);
    if (!prev) return;
    this.bytes -= prev.size;
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

export interface LoaderOptions {
  fetchSource: (descriptor: SourceDescriptor, validators: Validators | undefined) => Promise<FetchOutcome>;
  limits: Limits;
  limitsFingerprint: string;
  now?: () => number;
  freshMs: number;
  staleMs: number;
  store?: PersistentStore | undefined;
  memoryEntries?: number;
  memoryBytes?: number;
  /** Minimum delay between upstream attempts after a failure, per source. */
  failureBackoffMs?: number;
  log?: (event: Record<string, string | number | boolean | undefined>) => void;
}

function approximateSize(entry: CachedSnapshot): number {
  let size = 512;
  for (const t of entry.snapshot.targets) size += t.body.length * 2 + t.target.length * 2 + t.sourceIndexes.length * 8;
  size += entry.snapshot.diagnostics.length * 256;
  return size;
}

function summarize(error: unknown): ErrorSummary {
  if (error instanceof SnapshotUnavailableError || error instanceof SourceError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: '内部错误' };
}

export class SnapshotLoader {
  private readonly opts: LoaderOptions;
  private readonly memory: BoundedLru<CachedSnapshot>;
  private readonly failures: BoundedLru<{ at: number; error: unknown }>;
  private readonly inflight = new Map<string, Promise<SnapshotResult>>();
  private readonly now: () => number;

  constructor(opts: LoaderOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.memory = new BoundedLru(opts.memoryEntries ?? 64, opts.memoryBytes ?? 32 * 1024 * 1024);
    this.failures = new BoundedLru(256, Number.MAX_SAFE_INTEGER);
  }

  cacheKey(d: SourceDescriptor): string {
    return sha256Hex(`${COMPILER_VERSION}\n${this.opts.limitsFingerprint}\n${d.format}\n${d.url}`);
  }

  private log(event: Record<string, string | number | boolean | undefined>): void {
    this.opts.log?.(event);
  }

  private async readEntry(key: string): Promise<CachedSnapshot | undefined> {
    const mem = this.memory.get(key);
    if (mem) return mem;
    if (!this.opts.store) return undefined;
    try {
      const stored = await this.opts.store.get(key);
      if (stored) this.memory.set(key, stored, approximateSize(stored));
      return stored;
    } catch {
      this.log({ evt: 'cache_store_get_failed', key: key.slice(0, 12) });
      return undefined;
    }
  }

  async load(d: SourceDescriptor): Promise<SnapshotResult> {
    const key = this.cacheKey(d);
    const entry = await this.readEntry(key);
    const now = this.now();
    if (entry && now - entry.validatedAt < this.opts.freshMs) {
      return { entry, stale: false, cacheStatus: 'hit' };
    }

    const failure = this.failures.get(key);
    if (failure && now - failure.at < (this.opts.failureBackoffMs ?? 5000)) {
      return this.fallback(entry, failure.error, now);
    }

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.revalidate(key, d, entry).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (!this.failures.get(key) || this.failures.get(key)!.error !== error) {
        this.failures.set(key, { at: this.now(), error });
      }
      return this.fallback(entry, error, this.now());
    }
  }

  private fallback(entry: CachedSnapshot | undefined, error: unknown, now: number): SnapshotResult {
    if (entry && now - entry.validatedAt < this.opts.staleMs) {
      this.log({ evt: 'snapshot_stale', key: entry.key.slice(0, 12), code: summarize(error).code });
      return { entry, stale: true, cacheStatus: 'stale', lastError: summarize(error) };
    }
    throw error;
  }

  private async revalidate(key: string, d: SourceDescriptor, entry: CachedSnapshot | undefined): Promise<SnapshotResult> {
    const validators = entry ? { etag: entry.etag, lastModified: entry.lastModified } : undefined;
    const outcome = await this.opts.fetchSource(d, validators);
    let next: CachedSnapshot;
    if (outcome.kind === 'not-modified') {
      if (!entry) throw new SnapshotUnavailableError('UPSTREAM_UNEXPECTED_304', 502, '上游返回 304，但本服务没有对应的有效快照');
      next = { ...entry, validatedAt: this.now() };
    } else {
      const result = compile(outcome.text, d.format, this.opts.limits);
      if (!result.ok) {
        throw new SnapshotUnavailableError('SOURCE_INVALID', 422, '源内容未通过转换校验', result.diagnostics);
      }
      next = {
        key,
        compilerVersion: COMPILER_VERSION,
        snapshot: result.snapshot,
        validatedAt: this.now(),
        etag: outcome.etag,
        lastModified: outcome.lastModified,
      };
    }
    this.failures.delete(key);
    this.memory.set(key, next, approximateSize(next));
    if (this.opts.store) {
      const ttl = Math.ceil((this.opts.staleMs + this.opts.freshMs) / 1000);
      try {
        await this.opts.store.put(next, ttl);
      } catch {
        this.log({ evt: 'cache_store_put_failed', key: key.slice(0, 12) });
      }
    }
    this.log({ evt: 'snapshot_validated', key: key.slice(0, 12), kind: outcome.kind });
    return { entry: next, stale: false, cacheStatus: entry ? 'revalidated' : 'miss' };
  }

  /** Test hook: number of snapshots held in memory. */
  get memorySize(): number {
    return this.memory.size;
  }
}
