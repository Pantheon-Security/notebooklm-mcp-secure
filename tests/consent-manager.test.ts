import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-consent-manager-test-")) };
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
  logConsent: vi.fn(async () => undefined),
  logDataDeletion: vi.fn(async () => undefined),
}));

vi.mock("../src/compliance/compliance-logger.js", () => ({
  getComplianceLogger: () => complianceLogger,
}));

import {
  ConsentManager,
  getConsentManager,
  grantConsent,
  hasConsent,
  revokeConsent,
} from "../src/compliance/consent-manager.js";

function resetConsentManager(): ConsentManager {
  (ConsentManager as unknown as { instance?: ConsentManager }).instance = undefined;
  return getConsentManager();
}

function consentFilePath(): string {
  return path.join(TMP_ROOT, "consent.json");
}

describe("ConsentManager", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetConsentManager();
  });

  afterEach(() => {
    resetConsentManager();
  });

  it("grantConsent stores a record", async () => {
    const consent = await grantConsent(["usage_analytics"], {
      evidence: "Unit test",
      method: "explicit",
    });

    const history = await getConsentManager().getConsentHistory();
    const persisted = JSON.parse(fs.readFileSync(consentFilePath(), "utf-8")) as {
      consents: Array<{ id: string; purposes: string[] }>;
    };

    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe(consent.id);
    expect(history[0]?.purposes).toEqual(["usage_analytics"]);
    expect(persisted.consents).toHaveLength(1);
    expect(persisted.consents[0]?.id).toBe(consent.id);
    expect(complianceLogger.logConsent).toHaveBeenCalledWith(
      "granted",
      { type: "user" },
      ["usage_analytics"],
      true,
      expect.objectContaining({ consent_id: consent.id, legal_basis: "consent" })
    );
  });

  it("revokeConsent marks a consent revoked", async () => {
    const consent = await grantConsent(["usage_analytics"]);

    const revoked = await revokeConsent(consent.id, "user request");
    const history = await getConsentManager().getConsentHistory();

    expect(revoked).toBe(true);
    expect(history[0]?.revoked).toBe(true);
    expect(history[0]?.revocation_reason).toBe("user request");
    expect(history[0]?.revoked_at).toEqual(expect.any(String));
    expect(complianceLogger.logConsent).toHaveBeenCalledWith(
      "revoked",
      { type: "user" },
      ["usage_analytics"],
      true,
      expect.objectContaining({ consent_id: consent.id, reason: "user request" })
    );
  });

  it("hasConsent returns the correct boolean for explicit consent state", async () => {
    expect(await hasConsent("usage_analytics")).toBe(false);

    const consent = await grantConsent(["usage_analytics"]);
    expect(await hasConsent("usage_analytics")).toBe(true);

    await revokeConsent(consent.id);
    expect(await hasConsent("usage_analytics")).toBe(false);
  });

  it("preserves consent state after reset and reload from disk", async () => {
    await grantConsent(["usage_analytics"], { evidence: "persist me" });

    resetConsentManager();

    expect(await getConsentManager().hasConsent("usage_analytics")).toBe(true);
    expect(await getConsentManager().getConsentHistory()).toHaveLength(1);
  });

  it("handles an invalid empty purpose without crashing", async () => {
    await expect(
      getConsentManager().grantConsent(["" as never], { evidence: "invalid purpose" })
    ).resolves.toMatchObject({
      purposes: [""],
      legal_basis: "legitimate_interest",
    });

    expect(fs.existsSync(consentFilePath())).toBe(true);
    expect(await getConsentManager().getConsentHistory()).toHaveLength(1);
  });
});
