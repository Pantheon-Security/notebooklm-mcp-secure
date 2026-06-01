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
 * Single shared stale-lock threshold (L15).
 *
 * The async FileLock util and the synchronous shutdown-flush path in
 * audit-logger.ts (writeWithSyncLock) lock the SAME audit-*.jsonl files, so they
 * MUST agree on when a lock is stale. They previously diverged (900_000ms here vs
 * a hardcoded 30_000ms in the sync path): the sync path could steal a lock at 30s
 * that the async owner still considered live (900s), and both would then write the
 * same audit file concurrently — corrupting the very log the lock protects.
 *
 * Unified UP to 900_000ms (15 min): losing a best-effort shutdown flush (the sync
 * path only waits 10s total anyway) is strictly less bad than corrupting the audit
 * log. Overridable via NLMCP_LOCK_STALE_MS.
 */
export const STALE_LOCK_THRESHOLD_MS = parseIntegerEnv("NLMCP_LOCK_STALE_MS", 900_000);

/**
 * Default lock options
 */
const DEFAULT_OPTIONS: Required<LockOptions> = {
  timeout: parseIntegerEnv("NLMCP_LOCK_TIMEOUT_MS", 10000),
  retryInterval: 100,
  staleThreshold: STALE_LOCK_THRESHOLD_MS,
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
        // Check for a stale or corrupted lock. Never blind-unlink by mere
        // existence: a concurrent process may have replaced a stale lock with
        // its own fresh one. Use compare-and-delete — re-read the lock
        // immediately before unlinking and only remove the EXACT bytes we
        // observed. The atomic `wx` create below is the real backstop: if the
        // file is recreated between our delete and our create, it EEXISTs and
        // we simply loop.
        let observed: string | null = null;
        try {
          observed = fs.readFileSync(this.lockPath, "utf-8");
        } catch (err) {
          // ENOENT (no lock present) is the common, expected case — fall through
          // to the create attempt below.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            log.debug(`file-lock: reading lock file in acquire: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (observed !== null) {
          let removable = false;
          try {
            const existing = JSON.parse(observed) as LockContent;
            const age = Date.now() - existing.timestamp;

            if (age > opts.staleThreshold) {
              log.warning(`🔓 Removing stale lock (age: ${Math.round(age / 1000)}s, pid: ${existing.pid})`);
              removable = true;
            }
          } catch (err) {
            log.debug(`file-lock: reading/parsing lock file content in acquire: ${err instanceof Error ? err.message : String(err)}`);
            // Corrupted lock file — eligible for removal, but still only if the
            // exact corrupted bytes are unchanged when we re-read below.
            removable = true;
          }

          if (removable) {
            try {
              // Compare-and-delete: re-read and confirm the content is byte-for-byte
              // identical to what we observed before unlinking, so we never delete
              // a different process's freshly-written lock.
              const reread = fs.readFileSync(this.lockPath, "utf-8");
              if (reread === observed) {
                fs.unlinkSync(this.lockPath);
              }
            } catch (err) {
              log.debug(`file-lock: compare-and-delete stale lock in acquire: ${err instanceof Error ? err.message : String(err)}`);
              // Another process already changed or removed it — let the wx create decide.
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

    try {
      // Compare-and-delete: read the lock once and only remove it if it is
      // still ours. If another process validly stole the lock after the stale
      // threshold, we leave it untouched rather than clobbering it (the old
      // temp-file rename dance could overwrite a newer owner's lock with our
      // stale content).
      const content = fs.readFileSync(this.lockPath, "utf-8");
      const existing = JSON.parse(content) as LockContent;

      if (existing.lockId === this.lockId) {
        fs.unlinkSync(this.lockPath);
      } else {
        log.warning(`⚠️ Lock owned by different process, not releasing`);
      }
    } catch (err) {
      // ENOENT (already gone), parse errors, or a concurrent unlink — nothing to do.
      log.debug(`file-lock: compare-and-delete in release: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.acquired = false;
    }
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
  } catch (err) {
    log.debug(`file-lock: reading lock file in isLocked: ${err instanceof Error ? err.message : String(err)}`);
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

    let lockPid: number | undefined;
    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const existing = JSON.parse(content) as LockContent;

      if (!Number.isInteger(existing.pid) || existing.pid <= 0) {
        throw new Error(`Invalid lock file PID: ${existing.pid}`);
      }

      lockPid = existing.pid;
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
      // EPERM means the process exists but is owned by another user — still alive (I296)
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        throw new Error(
          `Cannot force-unlock: owning process ${lockPid} is still alive (EPERM).`
        );
      }
      // ESRCH means the process is gone — safe to remove the orphaned lock
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
