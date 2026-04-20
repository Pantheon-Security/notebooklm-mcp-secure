/**
 * Cross-Platform File Locking for NotebookLM MCP Server
 *
 * Provides advisory file locking to prevent race conditions when
 * multiple concurrent sessions access shared state files.
 *
 * Features:
 * - Cross-platform (Linux, macOS, Windows)
 * - Stale lock detection and cleanup
 * - Timeout with retry
 * - Process ID tracking
 *
 * Used for:
 * - Quota file updates (prevent concurrent increment race)
 * - Auth state save/load (prevent corruption)
 * - Browser context creation (prevent parallel recreations)
 */

import fs from "fs";
import path from "path";
import { log } from "./logger.js";

/**
 * Lock options
 */
export interface LockOptions {
  /** Max time to wait for lock (ms) */
  timeout?: number;
  /** Time between retry attempts (ms) */
  retryInterval?: number;
  /** Lock considered stale after this time (ms) */
  staleThreshold?: number;
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Default lock options
 */
const DEFAULT_OPTIONS: Required<LockOptions> = {
  timeout: parseIntegerEnv("NLMCP_LOCK_TIMEOUT_MS", 10000),
  retryInterval: 100,
  staleThreshold: parseIntegerEnv("NLMCP_LOCK_STALE_MS", 900_000),
};

/**
 * Lock file content structure
 */
interface LockContent {
  pid: number;
  lockId: string;
  timestamp: number;
  hostname?: string;
}

/**
 * Generate unique lock ID
 */
function generateLockId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * File Lock Class
 *
 * Simple cross-platform file locking using lock files.
 * Works on Linux, macOS, and Windows.
 */
export class FileLock {
  private lockPath: string;
  private acquired: boolean = false;
  private lockId: string;

  constructor(filePath: string) {
    this.lockPath = filePath + ".lock";
    this.lockId = generateLockId();
  }

  /**
   * Acquire lock with retry and timeout
   */
  async acquire(options?: LockOptions): Promise<boolean> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();
    const lowerLockPath = this.lockPath.toLowerCase();

    if (
      lowerLockPath.includes("/nfs/") ||
      lowerLockPath.includes("/smb/") ||
      this.lockPath.includes("//") ||
      this.lockPath.includes("\\\\")
    ) {
      log.warning("Warning: file lock on network path may be unreliable");
    }

    while (Date.now() - startTime < opts.timeout) {
      try {
        // Check if stale lock exists
        if (fs.existsSync(this.lockPath)) {
          try {
            const content = fs.readFileSync(this.lockPath, "utf-8");
            const existing = JSON.parse(content) as LockContent;
            const age = Date.now() - existing.timestamp;

            if (age > opts.staleThreshold) {
              // Lock is stale, remove it
              log.warning(`🔓 Removing stale lock (age: ${Math.round(age / 1000)}s, pid: ${existing.pid})`);
              try {
                fs.unlinkSync(this.lockPath);
              } catch {
                // Ignore if another process already removed it
              }
            }
          } catch {
            // Corrupted lock file, try to remove it
            try {
              fs.unlinkSync(this.lockPath);
            } catch {
              // Ignore
            }
          }
        }

        // Try to create lock file exclusively
        const lockContent: LockContent = {
          pid: process.pid,
          lockId: this.lockId,
          timestamp: Date.now(),
          hostname: process.env.HOSTNAME || process.env.COMPUTERNAME,
        };

        // Ensure directory exists
        const lockDir = path.dirname(this.lockPath);
        if (!fs.existsSync(lockDir)) {
          fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
        }

        // Try exclusive create (will fail if file exists)
        fs.writeFileSync(this.lockPath, JSON.stringify(lockContent), {
          flag: "wx", // Exclusive create - fails if file exists
          mode: 0o600,
        });

        this.acquired = true;
        return true;
      } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") {
          // Unexpected error
          log.error(`❌ Lock acquisition error: ${err.message}`);
          throw error;
        }

        // Lock exists, wait and retry
        await new Promise((resolve) => setTimeout(resolve, opts.retryInterval));
      }
    }

    // Timeout reached
    log.warning(`⚠️ Lock acquisition timeout for ${this.lockPath}`);
    return false;
  }

  /**
   * Release lock
   */
  release(): void {
    if (!this.acquired) return;

    const tempPath = `${this.lockPath}.${this.lockId}.release`;

    try {
      if (fs.existsSync(this.lockPath)) {
        try {
          const content = fs.readFileSync(this.lockPath, "utf-8");
          const existing = JSON.parse(content) as LockContent;

          if (existing.lockId === this.lockId) {
            fs.writeFileSync(tempPath, content, { mode: 0o600 });

            const verifiedContent = fs.readFileSync(this.lockPath, "utf-8");
            const verified = JSON.parse(verifiedContent) as LockContent;
            if (verified.lockId === this.lockId) {
              fs.renameSync(tempPath, this.lockPath);

              const finalContent = fs.readFileSync(this.lockPath, "utf-8");
              const finalLock = JSON.parse(finalContent) as LockContent;
              if (finalLock.lockId === this.lockId) {
                fs.unlinkSync(this.lockPath);
              } else {
                log.warning(`⚠️ Lock changed before release completed, not deleting`);
              }
            }
          } else {
            log.warning(`⚠️ Lock owned by different process, not releasing`);
          }
        } catch {
          // Ignore errors during release
        }
      }
    } catch {
      // Ignore errors during release
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // Ignore temp cleanup errors
      }
    }

    this.acquired = false;
  }

  /**
   * Check if lock is acquired
   */
  isAcquired(): boolean {
    return this.acquired;
  }
}

/**
 * Execute operation with file lock
 *
 * Acquires lock, executes operation, releases lock.
 * Ensures lock is always released even if operation throws.
 *
 * @param filePath - Path to the file to lock (lock file will be filePath + ".lock")
 * @param operation - Async operation to execute while holding lock
 * @param options - Lock options
 * @returns Result of the operation
 * @throws Error if lock cannot be acquired within timeout
 */
export async function withLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options?: LockOptions
): Promise<T> {
  const lock = new FileLock(filePath);

  if (!(await lock.acquire(options))) {
    throw new Error(`Could not acquire lock for ${filePath} within timeout`);
  }

  try {
    return await operation();
  } finally {
    lock.release();
  }
}

/**
 * Check if a file is currently locked
 *
 * Note: This is a point-in-time check and may be stale immediately after.
 * Only use for informational purposes.
 */
export function isLocked(filePath: string, staleThreshold?: number): boolean {
  const lockPath = filePath + ".lock";
  const threshold = staleThreshold ?? DEFAULT_OPTIONS.staleThreshold;

  if (!fs.existsSync(lockPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(lockPath, "utf-8");
    const existing = JSON.parse(content) as LockContent;
    const age = Date.now() - existing.timestamp;

    // Consider stale locks as not locked
    return age <= threshold;
  } catch {
    log.warning("corrupt lock file — treating as locked");
    return true;
  }
}

/**
 * Force remove a lock file (use with caution)
 *
 * Only use when you're certain the lock is orphaned.
 */
export function forceUnlock(filePath: string): boolean {
  const lockPath = filePath + ".lock";

  try {
    if (!fs.existsSync(lockPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const existing = JSON.parse(content) as LockContent;

      if (!Number.isInteger(existing.pid) || existing.pid <= 0) {
        throw new Error(`Invalid lock file PID: ${existing.pid}`);
      }

      process.kill(existing.pid, 0);
      throw new Error(
        `Cannot force-unlock: owning process ${existing.pid} is still running.`
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Cannot force-unlock:")
      ) {
        throw error;
      }
    }

    fs.unlinkSync(lockPath);
    log.info(`🔓 Force removed lock: ${lockPath}`);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot force-unlock:")) {
      throw error;
    }

    log.error(`❌ Failed to force remove lock: ${error}`);
    return false;
  }
}
