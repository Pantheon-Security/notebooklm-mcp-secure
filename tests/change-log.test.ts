import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-change-log-test-")),
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

const complianceLogger = vi.hoisted(() => ({
  logPolicyChange: vi.fn(async () => undefined),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

import { ChangeLog, getChangeLog } from "../src/compliance/change-log.js";

function resetChangeLog(): ChangeLog {
  (ChangeLog as unknown as { instance?: ChangeLog }).instance = undefined;
  return getChangeLog();
}

describe("ChangeLog", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetChangeLog();
  });

  afterEach(() => {
    resetChangeLog();
  });

  it("recordChange persists an entry to disk", async () => {
    const log = getChangeLog();
    const record = await log.recordChange("auth", "timeout", 30, 60, {
      changedBy: "admin",
      method: "cli",
      impact: "medium",
    });

    expect(record.id).toEqual(expect.any(String));
    expect(record.component).toBe("auth");
    expect(record.setting).toBe("timeout");
    expect(record.old_value).toBe(30);
    expect(record.new_value).toBe(60);
    expect(record.changed_by).toBe("admin");
    expect(record.method).toBe("cli");
    expect(record.impact).toBe("medium");

    // Verify the JSONL file on disk contains the record
    const changesDir = path.join(TMP_ROOT, "compliance", "changes");
    const files = fs.readdirSync(changesDir).filter(f => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const content = fs.readFileSync(path.join(changesDir, files[0]!), "utf-8");
    const parsed = JSON.parse(content.trim()) as typeof record;
    expect(parsed.id).toBe(record.id);
    expect(parsed.component).toBe("auth");
  });

  it("getAllChanges reads back persisted entries", async () => {
    const log = getChangeLog();
    await log.recordChange("session", "max_age", 3600, 7200);
    await log.recordChange("encryption", "algorithm", "AES-128", "AES-256");

    const changes = await log.getAllChanges();
    expect(changes).toHaveLength(2);

    // getAllChanges returns most recent first (lines reversed)
    const settings = changes.map(c => c.setting);
    expect(settings).toContain("max_age");
    expect(settings).toContain("algorithm");
  });

  it("getChangesByComponent returns the correct subset", async () => {
    const log = getChangeLog();
    await log.recordChange("auth", "timeout", 30, 60);
    await log.recordChange("auth", "max_retries", 3, 5);
    await log.recordChange("session", "lifetime", 1800, 3600);

    const authChanges = await log.getChangesByComponent("auth");
    expect(authChanges).toHaveLength(2);
    expect(authChanges.every(c => c.component === "auth")).toBe(true);

    const sessionChanges = await log.getChangesByComponent("session");
    expect(sessionChanges).toHaveLength(1);
    expect(sessionChanges[0]?.component).toBe("session");
  });

  it("getAllChanges then filtering by changed_by returns correct subset", async () => {
    const log = getChangeLog();
    await log.recordChange("auth", "timeout", 30, 60, { changedBy: "admin" });
    await log.recordChange("session", "lifetime", 1800, 3600, { changedBy: "system" });
    await log.recordChange("encryption", "level", 1, 2, { changedBy: "admin" });

    const allChanges = await log.getAllChanges();
    const adminChanges = allChanges.filter(c => c.changed_by === "admin");
    const systemChanges = allChanges.filter(c => c.changed_by === "system");

    expect(adminChanges).toHaveLength(2);
    expect(adminChanges.every(c => c.changed_by === "admin")).toBe(true);
    expect(systemChanges).toHaveLength(1);
    expect(systemChanges[0]?.changed_by).toBe("system");
  });

  it("two sequential recordChange calls both persist (no entries lost)", async () => {
    const log = getChangeLog();

    await log.recordChange("auth", "timeout", 30, 60);
    await log.recordChange("auth", "max_retries", 3, 5);

    const changes = await log.getAllChanges();
    expect(changes).toHaveLength(2);

    const settings = changes.map(c => c.setting);
    expect(settings).toContain("timeout");
    expect(settings).toContain("max_retries");
  });

  it("complianceLogger.logPolicyChange is called for each recordChange", async () => {
    const log = getChangeLog();
    await log.recordChange("auth", "timeout", 30, 60, { changedBy: "user" });

    expect(complianceLogger.logPolicyChange).toHaveBeenCalledOnce();
    expect(complianceLogger.logPolicyChange).toHaveBeenCalledWith(
      "timeout",
      30,
      60,
      "user"
    );
  });
});
