import type { CacheAdapter } from './types.js';

interface MemoryCacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Simple in-memory TTL cache used by default when no custom `CacheAdapter` is supplied. */
export class MemoryCache<T = unknown> implements CacheAdapter<T> {
  private readonly store = new Map<string, MemoryCacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options?: { maxEntries?: number; now?: () => number }) {
    this.maxEntries = options?.maxEntries ?? 500;
    this.now = options?.now ?? (() => Date.now());
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (!this.store.has(key) && this.store.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.store.set(key, {
      expiresAt: this.now() + ttlMs,
      value,
    });
  }

  clear(): void {
    this.store.clear();
  }

  private evictOldest(): void {
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
      }
    }
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }
}
