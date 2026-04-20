import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-privacy-notice-test-")) };
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
  log: vi.fn(async () => undefined),
  logConsent: vi.fn(async () => undefined),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

import { ConsentManager, getConsentManager } from "../src/compliance/consent-manager.js";
import {
  PrivacyNoticeManager,
  getPrivacyNoticeManager,
} from "../src/compliance/privacy-notice.js";

function resetPrivacyNoticeManager(): PrivacyNoticeManager {
  (PrivacyNoticeManager as unknown as { instance?: PrivacyNoticeManager }).instance = undefined;
  return getPrivacyNoticeManager();
}

function resetConsentManager(): ConsentManager {
  (ConsentManager as unknown as { instance?: ConsentManager }).instance = undefined;
  return getConsentManager();
}

function acknowledgmentFilePath(): string {
  return path.join(TMP_ROOT, "privacy-acknowledgment.json");
}

describe("PrivacyNoticeManager", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetConsentManager();
    resetPrivacyNoticeManager();
  });

  afterEach(() => {
    resetConsentManager();
    resetPrivacyNoticeManager();
  });

  it("needsDisplay returns true when no acknowledgment is recorded", async () => {
    expect(await getPrivacyNoticeManager().needsDisplay()).toBe(true);
    expect(await getPrivacyNoticeManager().isFirstRun()).toBe(true);
  });

  it("acknowledge records an acknowledgment", async () => {
    await getPrivacyNoticeManager().acknowledge("api");

    const history = await getPrivacyNoticeManager().getAcknowledgmentHistory();
    const persisted = JSON.parse(fs.readFileSync(acknowledgmentFilePath(), "utf-8")) as {
      acknowledgments: Array<{ method: string; version: string }>;
    };

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ method: "api" });
    expect(persisted.acknowledgments).toHaveLength(1);
    expect(persisted.acknowledgments[0]).toMatchObject({ method: "api" });
    expect(complianceLogger.log).toHaveBeenCalledWith(
      "consent",
      "privacy_notice_acknowledged",
      { type: "user" },
      "success",
      expect.objectContaining({
        details: expect.objectContaining({ method: "api" }),
      })
    );
  });

  it("needsDisplay returns false after acknowledgment", async () => {
    await getPrivacyNoticeManager().acknowledge("cli");

    expect(await getPrivacyNoticeManager().needsDisplay()).toBe(false);
    expect(await getPrivacyNoticeManager().hasAcknowledgedVersion(
      getPrivacyNoticeManager().getCurrentVersion()
    )).toBe(true);
  });

  it("preserves acknowledgment state after reset and reload from disk", async () => {
    await getPrivacyNoticeManager().acknowledge("auto");

    resetConsentManager();
    resetPrivacyNoticeManager();

    const status = await getPrivacyNoticeManager().getStatus();

    expect(status.needsDisplay).toBe(false);
    expect(status.isFirstRun).toBe(false);
    expect(status.lastAcknowledgment).toMatchObject({
      method: "auto",
      version: getPrivacyNoticeManager().getCurrentVersion(),
    });
  });
});
