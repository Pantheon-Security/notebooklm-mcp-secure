/**
 * Unit tests for file-lock utility (src/utils/file-lock.ts).
 *
 * Covers withLock serialisation, isLocked, forceUnlock, stale detection,
 * and concurrent increment correctness. See ISSUES.md I291.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock, isLocked, forceUnlock } from "../src/utils/file-lock.js";

let TMP_DIR: string;

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-lock-test-"));
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("withLock", () => {
  it("executes the callback and returns its value", async () => {
    const target = path.join(TMP_DIR, "test.json");
    const result = await withLock(target, async () => 42);
    expect(result).toBe(42);
  });

  it("releases lock after callback completes", async () => {
    const target = path.join(TMP_DIR, "test.json");
    await withLock(target, async () => "done");
    expect(isLocked(target)).toBe(false);
  });

  it("releases lock even when callback throws", async () => {
    const target = path.join(TMP_DIR, "test.json");
    await expect(withLock(target, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(isLocked(target)).toBe(false);
  });

  it("serialises concurrent operations — counter increments exactly N times", async () => {
    const counterPath = path.join(TMP_DIR, "counter.json");
    fs.writeFileSync(counterPath, JSON.stringify({ count: 0 }));

    const increment = () => withLock(counterPath, async () => {
      const data = JSON.parse(fs.readFileSync(counterPath, "utf-8")) as { count: number };
      data.count++;
      fs.writeFileSync(counterPath, JSON.stringify(data));
    }, { timeout: 5000 });

    const N = 10;
    await Promise.all(Array.from({ length: N }, () => increment()));

    const final = JSON.parse(fs.readFileSync(counterPath, "utf-8")) as { count: number };
    expect(final.count).toBe(N);
  });

  it("throws when lock cannot be acquired within timeout", async () => {
    const target = path.join(TMP_DIR, "stuck.json");

    // Hold the lock in a never-resolving operation with a very short timeout on the waiter
    const slowOp = withLock(target, () => new Promise<void>((_resolve) => {
      // intentionally never resolves during the test
      setTimeout(_resolve, 2000);
    }), { timeout: 10000 });

    // Second caller with a very short timeout should fail fast
    await expect(
      withLock(target, async () => {}, { timeout: 50, retryInterval: 10 })
    ).rejects.toThrow(/lock/i);

    // Let the slow op finish to avoid dangling timer
    await slowOp;
  });
});

describe("isLocked", () => {
  it("returns false when no lock file exists", () => {
    const target = path.join(TMP_DIR, "absent.json");
    expect(isLocked(target)).toBe(false);
  });

  it("returns true when a valid lock file exists", async () => {
    const target = path.join(TMP_DIR, "held.json");
    let release!: () => void;
    const prom = withLock(target, () => new Promise<void>((res) => { release = res; }));
    // Wait a tick so the lock is acquired
    await new Promise((r) => setTimeout(r, 20));
    expect(isLocked(target)).toBe(true);
    release();
    await prom;
  });

  it("treats a stale lock (expired) as unlocked", () => {
    const target = path.join(TMP_DIR, "stale.json");
    const lockPath = target + ".lock";
    // Write a lock file with a very old timestamp
    const oldLock = {
      pid: 99999,
      lockId: "old",
      acquired: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    };
    fs.writeFileSync(lockPath, JSON.stringify(oldLock));
    // staleThreshold of 1 second → 10-min-old lock is stale
    expect(isLocked(target, 1000)).toBe(false);
  });

  it("treats a corrupt lock file as locked (I295)", () => {
    const target = path.join(TMP_DIR, "corrupt.json");
    fs.writeFileSync(target + ".lock", "{not-json");
    expect(isLocked(target)).toBe(true);
  });
});

describe("forceUnlock", () => {
  it("returns false when lock file does not exist", () => {
    const target = path.join(TMP_DIR, "absent.json");
    expect(forceUnlock(target)).toBe(false);
  });

  it("removes a stale lock file", () => {
    const target = path.join(TMP_DIR, "stale.json");
    const lockPath = target + ".lock";
    const oldLock = {
      pid: 99999,
      lockId: "old",
      acquired: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(oldLock));
    const removed = forceUnlock(target);
    expect(removed).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
