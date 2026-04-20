import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-data-inventory-test-")),
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

// Mock data-classifier so autoDiscover doesn't add extra entries
const dataClassifier = vi.hoisted(() => ({
  buildInventoryEntry: vi.fn(() => null),
  classify: vi.fn(() => null),
  getLegalBasis: vi.fn(() => "legitimate_interest" as const),
  getProcessingPurposes: vi.fn(() => ["service_provision"]),
  getRetentionPolicy: vi.fn(() => "30_days"),
  requiresEncryption: vi.fn(() => false),
  requiresAudit: vi.fn(() => false),
  isExportable: vi.fn(() => true),
  isErasable: vi.fn(() => true),
}));

vi.mock("../src/compliance/data-classification.js", () => ({
  getDataClassifier: () => dataClassifier,
  DataClassification: {
    PUBLIC: "public",
    INTERNAL: "internal",
    CONFIDENTIAL: "confidential",
    RESTRICTED: "restricted",
    REGULATED: "regulated",
  },
}));

// Mock compliance-logger used in register()
const complianceLogger = vi.hoisted(() => ({
  log: vi.fn(async () => ({
    id: "mock-id",
    timestamp: new Date().toISOString(),
    category: "data_processing" as const,
    event_type: "data_type_registered",
    actor: { type: "system" as const },
    outcome: "success" as const,
    hash: "0".repeat(64),
    previous_hash: "0".repeat(64),
    retention_days: 2555,
  })),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

import {
  DataInventory,
  getDataInventory,
} from "../src/compliance/data-inventory.js";
import { DataClassification } from "../src/compliance/types.js";

function resetDataInventory(): DataInventory {
  (DataInventory as unknown as { instance?: DataInventory }).instance = undefined;
  return getDataInventory();
}

function inventoryFilePath(): string {
  return path.join(TMP_ROOT, "data-inventory.json");
}

describe("DataInventory", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetDataInventory();
  });

  afterEach(() => {
    resetDataInventory();
  });

  it("register (addDataCategory) adds an entry and persists it to disk", async () => {
    const inventory = getDataInventory();
    const entry = await inventory.register(
      "custom_notebook_data",
      "/path/to/notebooks",
      {
        description: "User notebook data",
        classification: DataClassification.CONFIDENTIAL,
        retentionDays: 365,
      }
    );

    expect(entry.id).toEqual(expect.any(String));
    expect(entry.data_type).toBe("custom_notebook_data");
    expect(entry.description).toBe("User notebook data");
    expect(entry.classification).toBe(DataClassification.CONFIDENTIAL);
    expect(entry.retention_days).toBe(365);
    expect(entry.storage_location).toBe("/path/to/notebooks");
    expect(entry.last_updated).toEqual(expect.any(String));

    // Verify disk persistence
    expect(fs.existsSync(inventoryFilePath())).toBe(true);
    const raw = JSON.parse(fs.readFileSync(inventoryFilePath(), "utf-8")) as {
      entries: Array<{ id: string; data_type: string }>;
    };
    expect(raw.entries.some(e => e.id === entry.id)).toBe(true);
    expect(raw.entries.find(e => e.id === entry.id)?.data_type).toBe("custom_notebook_data");
  });

  it("getAll (getDataCategories) returns all registered entries", async () => {
    const inventory = getDataInventory();
    await inventory.register("type_a", "/path/a", { description: "Type A" });
    await inventory.register("type_b", "/path/b", { description: "Type B" });

    const all = await inventory.getAll();
    const types = all.map(e => e.data_type);
    expect(types).toContain("type_a");
    expect(types).toContain("type_b");
  });

  it("update (updateRetentionPolicy) modifies an existing entry", async () => {
    const inventory = getDataInventory();
    const entry = await inventory.register("session_logs", "/logs", {
      retentionDays: 30,
    });

    const updated = await inventory.update(entry.id, {
      retention_days: 90,
      description: "Updated description",
    });

    expect(updated).not.toBeNull();
    expect(updated?.retention_days).toBe(90);
    expect(updated?.description).toBe("Updated description");
    expect(updated?.data_type).toBe("session_logs"); // Immutable
    expect(updated?.last_updated).toEqual(expect.any(String)); // Timestamp is set

    // Verify the update is on disk
    const raw = JSON.parse(fs.readFileSync(inventoryFilePath(), "utf-8")) as {
      entries: Array<{ id: string; retention_days: number }>;
    };
    const persisted = raw.entries.find(e => e.id === entry.id);
    expect(persisted?.retention_days).toBe(90);
  });

  it("update returns null for a non-existent entry", async () => {
    const inventory = getDataInventory();
    const result = await inventory.update("non-existent-id", { description: "Won't work" });
    expect(result).toBeNull();
  });

  it("remove deletes an entry and returns true", async () => {
    const inventory = getDataInventory();
    const entry = await inventory.register("temp_data", "/tmp", {});
    const removed = await inventory.remove(entry.id);

    expect(removed).toBe(true);
    const all = await inventory.getAll();
    expect(all.find(e => e.id === entry.id)).toBeUndefined();
  });

  it("remove returns false for a non-existent entry", async () => {
    const inventory = getDataInventory();
    const result = await inventory.remove("does-not-exist");
    expect(result).toBe(false);
  });

  it("getById returns the correct entry", async () => {
    const inventory = getDataInventory();
    const entry = await inventory.register("targeted_type", "/target", {
      description: "Specific entry",
    });

    const found = await inventory.getById(entry.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(entry.id);
    expect(found?.data_type).toBe("targeted_type");
  });

  it("getById returns null for an unknown ID", async () => {
    const inventory = getDataInventory();
    const result = await inventory.getById("unknown-id");
    expect(result).toBeNull();
  });

  it("getByDataType returns only entries of the specified type", async () => {
    const inventory = getDataInventory();
    await inventory.register("shared_type", "/path1", {});
    await inventory.register("shared_type", "/path2", {});
    await inventory.register("other_type", "/path3", {});

    const results = await inventory.getByDataType("shared_type");
    expect(results).toHaveLength(2);
    expect(results.every(e => e.data_type === "shared_type")).toBe(true);
  });

  it("disk round-trip: second instance loads entries persisted by first", async () => {
    // First instance registers entries
    const inv1 = getDataInventory();
    const entry = await inv1.register("persistent_type", "/persistent/path", {
      description: "Should survive restart",
      retentionDays: 180,
    });

    // Reset singleton to simulate a new process
    resetDataInventory();

    // Second instance loads from disk
    const inv2 = getDataInventory();
    const all = await inv2.getAll();

    const reloaded = all.find(e => e.id === entry.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.data_type).toBe("persistent_type");
    expect(reloaded?.description).toBe("Should survive restart");
    expect(reloaded?.retention_days).toBe(180);
  });

  it("getSummary returns accurate counts", async () => {
    const inventory = getDataInventory();
    await inventory.register("count_me_1", "/p1", {
      classification: DataClassification.CONFIDENTIAL,
      exportable: true,
      erasable: true,
    });
    await inventory.register("count_me_2", "/p2", {
      classification: DataClassification.INTERNAL,
      exportable: false,
      erasable: true,
    });

    const summary = await inventory.getSummary();
    expect(summary.total_entries).toBeGreaterThanOrEqual(2);
    expect(summary.erasable_count).toBeGreaterThanOrEqual(2);
  });

  it("logConsent is called on register (compliance logger integration)", async () => {
    const inventory = getDataInventory();
    await inventory.register("logged_type", "/logged/path", {});

    expect(complianceLogger.log).toHaveBeenCalledWith(
      "data_processing",
      "data_type_registered",
      { type: "system" },
      "success",
      expect.objectContaining({
        resource: { type: "logged_type" },
        details: { storage_location: "/logged/path" },
      })
    );
  });
});
