// src/squadron/fileLock.js
// Provides file locking mechanism to prevent race conditions in concurrent file operations

const fs = require('fs');
const path = require('path');

// In-memory lock tracking
const fileLocks = new Map();
const LOCK_TIMEOUT_MS = 30000; // 30 seconds max lock hold time

/**
 * Wait for a file lock to be available
 * @param {string} filePath - Path to the file
 * @param {number} timeout - Max time to wait for lock (ms)
 * @returns {Promise<boolean>} True if lock acquired, false if timeout
 */
async function acquireLock(filePath, timeout = 5000) {
  const startTime = Date.now();
  
  while (true) {
    // Check if lock exists
    const lockInfo = fileLocks.get(filePath);
    
    if (!lockInfo) {
      // No lock exists, try to acquire
      const newLockInfo = {
        acquiredAt: Date.now(),
        pid: process.pid,
        stack: new Error().stack,
      };
      fileLocks.set(filePath, newLockInfo);
      return true;
    }
    
    // Check if lock is stale (held too long)
    const lockAge = Date.now() - lockInfo.acquiredAt;
    if (lockAge > LOCK_TIMEOUT_MS) {
      console.warn(`[WARN] Clearing stale lock on ${filePath} (held for ${Math.round(lockAge/1000)}s)`);
      fileLocks.delete(filePath);
      continue;
    }
    
    // Check if we've timed out waiting
    if (Date.now() - startTime > timeout) {
      console.warn(`[WARN] Timeout waiting for lock on ${filePath}`);
      return false;
    }
    
    // Wait a bit before retrying
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Release a file lock
 * @param {string} filePath - Path to the file
 */
function releaseLock(filePath) {
  fileLocks.delete(filePath);
}

/**
 * Execute an operation with a file lock
 * @param {string} filePath - Path to the file
 * @param {Function} operation - Async function to execute
 * @param {number} timeout - Lock timeout (ms)
 * @returns {Promise<any>} Result of the operation
 */
async function withFileLock(filePath, operation, timeout = 5000) {
  const acquired = await acquireLock(filePath, timeout);
  if (!acquired) {
    throw new Error(`Failed to acquire lock for ${filePath}`);
  }
  
  try {
    return await operation();
  } finally {
    releaseLock(filePath);
  }
}

/**
 * Get lock statistics
 * @returns {Object} Lock stats
 */
function getLockStats() {
  const now = Date.now();
  const locks = [];
  
  for (const [filePath, lockInfo] of fileLocks.entries()) {
    locks.push({
      filePath,
      heldFor: now - lockInfo.acquiredAt,
      pid: lockInfo.pid,
    });
  }
  
  return {
    activeLocks: locks.length,
    locks,
  };
}

/**
 * Clear all locks (use with caution, only for recovery)
 */
function clearAllLocks() {
  const count = fileLocks.size;
  fileLocks.clear();
  console.log(`[INFO] Cleared ${count} file locks`);
  return count;
}

module.exports = {
  acquireLock,
  releaseLock,
  withFileLock,
  getLockStats,
  clearAllLocks,
  LOCK_TIMEOUT_MS,
};
