import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/utils/audit-logger.js", () => ({
  audit: {
    session: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../src/utils/logger.js", () => ({
  log: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { SessionTimeoutManager } from "../src/session/session-timeout.js";

describe("SessionTimeoutManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("isExpired returns not expired for a newly started session", () => {
    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 60_000,
      inactivityTimeoutMs: 30_000,
      warningBeforeMs: 5_000,
    });

    try {
      manager.startSession("session-new");

      expect(manager.isExpired("session-new")).toEqual({ expired: false });
    } finally {
      manager.stop();
    }
  });

  it("isExpired returns inactivity after the inactivity timeout elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 60_000,
      inactivityTimeoutMs: 10_000,
      warningBeforeMs: 1_000,
    });

    try {
      manager.startSession("session-inactive");
      vi.advanceTimersByTime(10_001);

      expect(manager.isExpired("session-inactive")).toEqual({
        expired: true,
        reason: "inactivity",
      });
    } finally {
      manager.stop();
      vi.useRealTimers();
    }
  });

  it("isExpired returns lifetime after the maximum lifetime elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 10_000,
      inactivityTimeoutMs: 60_000,
      warningBeforeMs: 1_000,
    });

    try {
      manager.startSession("session-lifetime");
      vi.advanceTimersByTime(10_001);

      expect(manager.isExpired("session-lifetime")).toEqual({
        expired: true,
        reason: "lifetime",
      });
    } finally {
      manager.stop();
      vi.useRealTimers();
    }
  });

  it("touchSession resets inactivity tracking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 60_000,
      inactivityTimeoutMs: 10_000,
      warningBeforeMs: 1_000,
    });

    try {
      manager.startSession("session-touch");
      vi.advanceTimersByTime(9_000);
      manager.touchSession("session-touch");
      vi.advanceTimersByTime(2_000);

      expect(manager.isExpired("session-touch")).toEqual({ expired: false });
    } finally {
      manager.stop();
      vi.useRealTimers();
    }
  });

  it("periodic check expires sessions within the tightened polling interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 60_000,
      inactivityTimeoutMs: 1_000,
      warningBeforeMs: 100,
    });
    const onTimeout = vi.fn().mockResolvedValue(undefined);
    manager.setTimeoutCallback(onTimeout);

    try {
      manager.startSession("session-periodic");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(onTimeout).toHaveBeenCalledWith("session-periodic", "inactivity");
    } finally {
      manager.stop();
      vi.useRealTimers();
    }
  });

  it("removeSession stops tracking the session", () => {
    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 60_000,
      inactivityTimeoutMs: 30_000,
      warningBeforeMs: 5_000,
    });

    try {
      manager.startSession("session-removed");
      manager.removeSession("session-removed");

      expect(manager.isExpired("session-removed")).toEqual({ expired: false });
    } finally {
      manager.stop();
    }
  });

  it("getConfig reflects values changed by updateConfig", () => {
    const manager = new SessionTimeoutManager({
      maxLifetimeMs: 60_000,
      inactivityTimeoutMs: 30_000,
      warningBeforeMs: 5_000,
      enableHardTimeout: true,
      enableInactivityTimeout: true,
    });

    try {
      manager.updateConfig({ inactivityTimeoutMs: 45_000 });

      expect(manager.getConfig()).toMatchObject({
        maxLifetimeMs: 60_000,
        inactivityTimeoutMs: 45_000,
        warningBeforeMs: 5_000,
        enableHardTimeout: true,
        enableInactivityTimeout: true,
      });
    } finally {
      manager.stop();
    }
  });
});
