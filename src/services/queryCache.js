// src/services/queryCache.js
//
// In-memory LRU cache for query results.
//
// Why in-memory instead of Redis?
//   Stage 4B constraints say "no new database systems". An in-memory LRU
//   is zero-infrastructure, self-contained, and sufficient for a single
//   process serving hundreds to thousands of queries per minute.
//
// Why LRU (Least Recently Used)?
//   We have a bounded cache size. When full, we evict the entry that hasn't
//   been accessed the longest — the least likely to be needed again soon.
//   This avoids unbounded memory growth without complex configuration.
//
// Limits:
//   - Cache is per-process only. If you later run multiple API instances,
//     each will have its own cache (no cross-instance sharing). At that
//     point, switch to a shared Redis instance.
//   - TTL eviction is lazy (checked on get), not proactive. Memory usage
//     grows up to MAX_SIZE entries then stabilizes via LRU eviction.

const MAX_SIZE = 1000;          // Maximum number of cached entries
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

class LRUCache {
  constructor(maxSize = MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    // Map preserves insertion order, and moving entries on access
    // gives us O(1) LRU behaviour.
    this._cache = new Map();
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Get a cached value. Returns undefined on miss or expired entry.
   */
  get(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }

    // Lazy TTL check
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      this._misses++;
      return undefined;
    }

    // Move to end to mark as recently used
    this._cache.delete(key);
    this._cache.set(key, entry);
    this._hits++;
    return entry.value;
  }

  /**
   * Store a value. Evicts the least recently used entry if at capacity.
   */
  set(key, value) {
    // If key already exists, delete it first so re-insertion puts it at the end
    if (this._cache.has(key)) {
      this._cache.delete(key);
    }

    // Evict LRU entry (first entry in the Map) if at capacity
    if (this._cache.size >= this._maxSize) {
      const lruKey = this._cache.keys().next().value;
      this._cache.delete(lruKey);
    }

    this._cache.set(key, {
      value,
      expiresAt: Date.now() + this._ttlMs,
    });
  }

  /**
   * Remove all entries. Called after writes (POST, DELETE, CSV import)
   * to prevent stale results.
   */
  invalidate() {
    this._cache.clear();
  }

  /**
   * Stats for monitoring/debugging.
   */
  stats() {
    const total = this._hits + this._misses;
    return {
      size: this._cache.size,
      maxSize: this._maxSize,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? `${((this._hits / total) * 100).toFixed(1)}%` : 'n/a',
    };
  }
}

// Single shared cache instance for the whole process
export const queryCache = new LRUCache();
