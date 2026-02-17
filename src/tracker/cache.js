// src/tracker/cache.js
// TTL-based in-memory cache for HTTP requests

const { logError } = require('./utils');

// Cache storage: Map<url, { data, timestamp, ttl }>
const __cache = new Map();

// Default TTL in milliseconds
const DEFAULT_TTL_MS = 30_000; // 30 seconds

/**
 * Get a cached value if it exists and hasn't expired
 * @param {string} key - Cache key (usually URL)
 * @returns {*} Cached value or null if not found/expired
 */
function getCache(key) {
  try {
    const entry = __cache.get(key);
    if (!entry) return null;
    
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      // Entry expired, remove it
      __cache.delete(key);
      return null;
    }
    
    return entry.data;
  } catch (e) {
    logError('cache.get', e);
    return null;
  }
}

/**
 * Set a value in the cache with TTL
 * @param {string} key - Cache key
 * @param {*} data - Data to cache
 * @param {number} ttlMs - Time to live in milliseconds (default: 30s)
 */
function setCache(key, data, ttlMs = DEFAULT_TTL_MS) {
  try {
    __cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    });
  } catch (e) {
    logError('cache.set', e);
  }
}

/**
 * Remove a specific key from cache
 * @param {string} key - Cache key to remove
 */
function deleteCache(key) {
  try {
    __cache.delete(key);
  } catch (e) {
    logError('cache.delete', e);
  }
}

/**
 * Clear all cached entries
 */
function clearCache() {
  try {
    __cache.clear();
  } catch (e) {
    logError('cache.clear', e);
  }
}

/**
 * Get cache statistics
 * @returns {{size: number, entries: Array}} Cache stats
 */
function getCacheStats() {
  try {
    const now = Date.now();
    const entries = [];
    let validCount = 0;
    
    for (const [key, entry] of __cache.entries()) {
      const age = now - entry.timestamp;
      const remaining = entry.ttl - age;
      const isExpired = remaining <= 0;
      
      if (!isExpired) validCount++;
      
      entries.push({
        key,
        age: Math.round(age / 1000),
        ttl: entry.ttl,
        remaining: Math.max(0, Math.round(remaining / 1000)),
        expired: isExpired,
      });
    }
    
    return {
      size: __cache.size,
      validCount,
      expiredCount: __cache.size - validCount,
      entries,
    };
  } catch (e) {
    logError('cache.getStats', e);
    return { size: 0, validCount: 0, expiredCount: 0, entries: [] };
  }
}

/**
 * Clean up expired entries from cache
 * @returns {number} Number of entries removed
 */
function cleanupExpired() {
  try {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, entry] of __cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        __cache.delete(key);
        removed++;
      }
    }
    
    if (removed > 0) {
      console.log(`🗑️ Cache: cleaned up ${removed} expired entries`);
    }
    
    return removed;
  } catch (e) {
    logError('cache.cleanupExpired', e);
    return 0;
  }
}

/**
 * Schedule periodic cache cleanup
 * @param {number} intervalMs - Cleanup interval in milliseconds
 * @returns {NodeJS.Timeout} Timer handle
 */
function startCleanupScheduler(intervalMs = 60_000) {
  const timer = setInterval(() => {
    cleanupExpired();
  }, intervalMs);
  
  // Allow process to exit without waiting for timer
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  
  return timer;
}

// Start automatic cleanup every minute
const __cleanupTimer = startCleanupScheduler(60_000);

/**
 * Stop the cleanup scheduler (for graceful shutdown)
 */
function stopCleanupScheduler() {
  try {
    if (__cleanupTimer) {
      clearInterval(__cleanupTimer);
    }
  } catch (e) {
    logError('cache.stopScheduler', e);
  }
}

module.exports = {
  getCache,
  setCache,
  deleteCache,
  clearCache,
  getCacheStats,
  cleanupExpired,
  startCleanupScheduler,
  stopCleanupScheduler,
  DEFAULT_TTL_MS,
};
