/**
 * Unit tests for QuotaManager (src/quota/quota-manager.ts).
 *
 * Covers tier management, query/notebook limits, UTC day rollover,
 * atomic increment under concurrency, and the I243 ChangeLog hook on
 * setTier.
 *
 * See ISSUES.md I284.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Hoisted tmp dir so vi.mock factories share the same path.
const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-quota-test-")) };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT },
  };
});

const changeLogMock = vi.hoisted(() => ({ recordChange: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../src/compliance/change-log.js", () => ({
  getChangeLog: vi.fn(() => changeLogMock),
}));

import { QuotaManager } from "../src/quota/quota-manager.js";

describe("QuotaManager", () => {
  let settingsPath: string;

  beforeEach(() => {
    settingsPath = path.join(TMP_ROOT, "quota.json");
    // Reset state between tests — wipe any settings file + lock.
    try { fs.unlinkSync(settingsPath); } catch { /* no-op */ }
    try { fs.unlinkSync(settingsPath + ".lock"); } catch { /* no-op */ }
    changeLogMock.recordChange.mockClear();
  });

  afterEach(() => {
    try { fs.unlinkSync(settingsPath); } catch { /* no-op */ }
    try { fs.unlinkSync(settingsPath + ".lock"); } catch { /* no-op */ }
  });

  describe("constructor + defaults", () => {
    it("falls back to 'unknown' tier with free-tier-ish limits when no settings file", () => {
      const qm = new QuotaManager();
      const s = qm.getSettings();
      expect(s.tier).toBe("unknown");
      expect(s.limits.notebooks).toBeGreaterThan(0);
      expect(s.usage.notebooks).toBe(0);
      expect(s.usage.queriesUsedToday).toBe(0);
    });

    it("loads persisted settings from disk when present", () => {
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          tier: "pro",
          limits: { notebooks: 100, sourcesPerNotebook: 300, wordsPerSource: 500000, queriesPerDay: 500 },
          usage: {
            notebooks: 7,
            queriesUsedToday: 42,
            lastQueryDate: new Date().toISOString().split("T")[0],
            lastUpdated: new Date().toISOString(),
          },
          autoDetected: true,
        }),
      );
      const qm = new QuotaManager();
      const s = qm.getSettings();
      expect(s.tier).toBe("pro");
      expect(s.usage.notebooks).toBe(7);
      expect(s.usage.queriesUsedToday).toBe(42);
    });
  });

  describe("setTier", () => {
    it("updates tier, limits, and writes a ChangeLog record", async () => {
      const qm = new QuotaManager();
      await qm.setTier("pro");
      const s = qm.getSettings();
      expect(s.tier).toBe("pro");
      expect(s.autoDetected).toBe(false);
      expect(changeLogMock.recordChange).toHaveBeenCalledTimes(1);
      const call = changeLogMock.recordChange.mock.calls[0];
      expect(call[0]).toBe("quota"); // component
      expect(call[1]).toBe("tier"); // setting
      expect(call[3]).toBe("pro"); // newValue
    });

    it("is a no-op when tier is unchanged (no ChangeLog call)", async () => {
      const qm = new QuotaManager();
      await qm.setTier("pro");
      changeLogMock.recordChange.mockClear();
      await qm.setTier("pro");
      expect(changeLogMock.recordChange).not.toHaveBeenCalled();
    });

    it("persists to disk so the next QuotaManager sees the new tier", async () => {
      const first = new QuotaManager();
      await first.setTier("ultra");
      const second = new QuotaManager();
      expect(second.getSettings().tier).toBe("ultra");
    });
  });

  describe("canCreateNotebook", () => {
    it("allows when under limit", () => {
      const qm = new QuotaManager();
      expect(qm.canCreateNotebook().allowed).toBe(true);
    });

    it("denies when at/above limit", async () => {
      const qm = new QuotaManager();
      // Push usage to the limit (await — incrementNotebookCount is async-queued)
      const limit = qm.getSettings().limits.notebooks;
      for (let i = 0; i < limit; i++) await qm.incrementNotebookCount();
      const r = qm.canCreateNotebook();
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/limit reached/i);
    });
  });

  describe("canAddSource", () => {
    it("allows under the sourcesPerNotebook limit", () => {
      const qm = new QuotaManager();
      const limit = qm.getSettings().limits.sourcesPerNotebook;
      expect(qm.canAddSource(limit - 1).allowed).toBe(true);
    });

    it("denies at/above the limit", () => {
      const qm = new QuotaManager();
      const limit = qm.getSettings().limits.sourcesPerNotebook;
      const r = qm.canAddSource(limit);
      expect(r.allowed).toBe(false);
    });
  });

  describe("canMakeQuery", () => {
    it("allows at fresh start", () => {
      const qm = new QuotaManager();
      expect(qm.canMakeQuery().allowed).toBe(true);
    });

    it("denies when daily limit reached", () => {
      const qm = new QuotaManager();
      const limit = qm.getSettings().limits.queriesPerDay;
      // Force usage to the limit without invoking the atomic path (file lock
      // is real filesystem — keeping the test simple).
      for (let i = 0; i < limit; i++) qm.incrementQueryCount();
      const r = qm.canMakeQuery();
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/query limit reached/i);
    });

    it("resets counter on a new UTC day", () => {
      // Seed yesterday's state.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          tier: "pro",
          limits: { notebooks: 100, sourcesPerNotebook: 300, wordsPerSource: 500000, queriesPerDay: 500 },
          usage: {
            notebooks: 0,
            queriesUsedToday: 499,
            lastQueryDate: yesterday,
            lastUpdated: yesterday + "T23:59:00.000Z",
          },
          autoDetected: true,
        }),
      );
      const qm = new QuotaManager();
      // canMakeQuery sees a different date than lastQueryDate and resets
      expect(qm.canMakeQuery().allowed).toBe(true);
    });
  });

  describe("incrementQueryCountAtomic", () => {
    it("increments exactly once per call under serial use", async () => {
      const qm = new QuotaManager();
      await qm.incrementQueryCountAtomic();
      await qm.incrementQueryCountAtomic();
      await qm.incrementQueryCountAtomic();
      await qm.refreshSettings();
      expect(qm.getUsage().queriesUsedToday).toBe(3);
    });

    it("concurrent increments do not lose writes (file lock)", async () => {
      const qm1 = new QuotaManager();
      const qm2 = new QuotaManager();

      // Fire 5 increments on each manager concurrently.
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(qm1.incrementQueryCountAtomic());
        tasks.push(qm2.incrementQueryCountAtomic());
      }
      await Promise.all(tasks);

      const final = await qm1.refreshSettings();
      expect(final.usage.queriesUsedToday).toBe(10);
    });

    it("resets at UTC day rollover", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          tier: "pro",
          limits: { notebooks: 100, sourcesPerNotebook: 300, wordsPerSource: 500000, queriesPerDay: 500 },
          usage: {
            notebooks: 0,
            queriesUsedToday: 100,
            lastQueryDate: yesterday,
            lastUpdated: yesterday + "T23:59:00.000Z",
          },
          autoDetected: true,
        }),
      );
      const qm = new QuotaManager();
      await qm.incrementQueryCountAtomic();
      const s = await qm.refreshSettings();
      expect(s.usage.queriesUsedToday).toBe(1);
      expect(s.usage.lastQueryDate).toBe(new Date().toISOString().split("T")[0]);
    });
  });

  describe("incrementNotebookCount", () => {
    it("increments and persists", async () => {
      const qm = new QuotaManager();
      await qm.incrementNotebookCount();
      await qm.incrementNotebookCount();
      expect(qm.getUsage().notebooks).toBe(2);
      // New manager reads the persisted count.
      const qm2 = new QuotaManager();
      expect(qm2.getUsage().notebooks).toBe(2);
    });
  });
});
