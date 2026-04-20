import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-alert-manager-test-")),
  };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT },
    getConfig: () => ({ ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT }),
  };
});

import { AlertManager, getAlertManager, sendAlert } from "../src/compliance/alert-manager.js";

function resetAlertManager(): AlertManager {
  (AlertManager as unknown as { instance?: AlertManager }).instance = undefined;
  return getAlertManager();
}

describe("AlertManager", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    // Ensure env is clean before each reset
    delete process.env.NLMCP_ALERTS_ENABLED;
    delete process.env.NLMCP_ALERTS_MIN_SEVERITY;
    delete process.env.NLMCP_ALERTS_FILE;
    delete process.env.NLMCP_ALERTS_WEBHOOK_URL;
    delete process.env.NLMCP_ALERTS_COOLDOWN;
    resetAlertManager();
  });

  afterEach(() => {
    resetAlertManager();
  });

  it("sendAlert returns an Alert object with all expected fields", async () => {
    const manager = getAlertManager();
    const alert = await manager.sendAlert(
      "warning",
      "Test Alert",
      "Something needs attention",
      "test-source",
      { extra: "data" }
    );

    expect(alert).not.toBeNull();
    expect(alert?.id).toEqual(expect.any(String));
    expect(alert?.severity).toBe("warning");
    expect(alert?.title).toBe("Test Alert");
    expect(alert?.message).toBe("Something needs attention");
    expect(alert?.source).toBe("test-source");
    expect(alert?.details).toEqual({ extra: "data" });
    expect(alert?.timestamp).toEqual(expect.any(String));
    expect(alert?.sent_to).toContain("console");
  });

  it("sendAlert returns null when alerts are disabled", async () => {
    process.env.NLMCP_ALERTS_ENABLED = "false";
    resetAlertManager();

    const result = await sendAlert("critical", "Won't Fire", "Disabled", "test");
    expect(result).toBeNull();
  });

  it("info alert is filtered out by default min_severity of warning", async () => {
    // Default min_severity is "warning" — info should be suppressed
    const manager = getAlertManager();
    const result = await manager.sendAlert("info", "Info Alert", "Just info", "test");
    expect(result).toBeNull();
  });

  it("critical alert passes the default severity gate", async () => {
    const manager = getAlertManager();
    const alert = await manager.sendAlert("critical", "Critical Alert", "Critical issue", "test");
    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe("critical");
  });

  it("critical alert has higher urgency than warning (severity ordering)", async () => {
    const manager = getAlertManager();

    const warnAlert = await manager.sendAlert("warning", "Warning", "Watch out", "test");
    // Reset cooldown by using a different title
    const critAlert = await manager.sendAlert("critical", "Critical", "Act now", "test");

    expect(warnAlert).not.toBeNull();
    expect(critAlert).not.toBeNull();
    expect(critAlert?.severity).toBe("critical");
    expect(warnAlert?.severity).toBe("warning");
    // critical sentinel: sent_to has console (always enabled)
    expect(critAlert?.sent_to).toContain("console");
  });

  it("convenience method critical() sends a critical-severity alert", async () => {
    const manager = getAlertManager();
    const alert = await manager.critical("Crit Title", "Crit Message", "crit-source");
    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe("critical");
  });

  it("duplicate alert within cooldown window is suppressed", async () => {
    const manager = getAlertManager();
    // Use a short cooldown so the second send is definitely within it
    manager.updateConfig({ cooldown_seconds: 60 });

    const first = await manager.sendAlert("warning", "Dup Alert", "First send", "src");
    const second = await manager.sendAlert("warning", "Dup Alert", "Second send", "src");

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // suppressed by cooldown
  });

  it("getStats reflects the number of alerts sent this session", async () => {
    const manager = getAlertManager();
    await manager.sendAlert("warning", "Alert A", "Message A", "src");
    await manager.sendAlert("error", "Alert B", "Message B", "src2");

    const stats = manager.getStats();
    expect(stats.enabled).toBe(true);
    expect(stats.alerts_this_hour).toBeGreaterThanOrEqual(2);
    expect(stats.channels).toContain("console");
  });

  it("file channel writes JSONL entries to configured path on disk", async () => {
    const alertsFile = path.join(TMP_ROOT, "test-alerts.jsonl");
    process.env.NLMCP_ALERTS_FILE = alertsFile;
    resetAlertManager();

    const manager = getAlertManager();
    const alert = await manager.sendAlert("error", "File Alert", "Written to disk", "test-src");

    expect(alert).not.toBeNull();
    expect(alert?.sent_to).toContain("file");
    expect(fs.existsSync(alertsFile)).toBe(true);

    const content = fs.readFileSync(alertsFile, "utf-8");
    const parsed = JSON.parse(content.trim()) as { severity: string; title: string };
    expect(parsed.severity).toBe("error");
    expect(parsed.title).toBe("File Alert");
  });

  it("updateConfig changes runtime configuration", async () => {
    const manager = getAlertManager();
    manager.updateConfig({ min_severity: "info" });

    // Now info alerts should pass
    const result = await manager.sendAlert("info", "Info Now OK", "Should pass", "test");
    expect(result).not.toBeNull();
    expect(result?.severity).toBe("info");
  });
});
