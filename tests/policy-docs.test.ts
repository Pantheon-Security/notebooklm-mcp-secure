/**
 * Unit tests for PolicyDocManager (src/compliance/policy-docs.ts).
 *
 * Note: The task description referenced listPolicies() and getPolicyText().
 * The actual API uses getAllPolicies() and getPolicy(id).full_text.
 * Unknown policy ID returns null (does not throw).
 *
 * DEFAULT_POLICIES contains 5 hard-coded entries. The manager has minimal
 * deps (config + file-permissions + logger) — no compliance module mocks needed.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-policy-docs-test-")),
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

vi.mock("../src/utils/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import {
  PolicyDocManager,
  getPolicyDocManager,
  getAllPolicies,
  getPolicy,
  getPoliciesByRegulation,
  getPolicySummary,
} from "../src/compliance/policy-docs.js";

/** Known IDs from DEFAULT_POLICIES */
const KNOWN_POLICY_IDS = [
  "policy_privacy",
  "policy_retention",
  "policy_access_control",
  "policy_encryption",
  "policy_incident_response",
] as const;

function resetPolicyDocManager(): void {
  (PolicyDocManager as unknown as { instance?: PolicyDocManager }).instance = undefined;
}

describe("PolicyDocManager", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    resetPolicyDocManager();
  });

  afterEach(() => {
    resetPolicyDocManager();
  });

  it("getPolicy(id) returns a policy object for a known policy name", async () => {
    const policy = await getPolicy("policy_privacy");

    expect(policy).not.toBeNull();
    expect(policy!.id).toBe("policy_privacy");
    expect(policy!.type).toBe("privacy_policy");
    expect(policy!.title).toBe("Privacy Policy");
    expect(policy!.enforced).toBe(true);
    expect(Array.isArray(policy!.regulations)).toBe(true);
    expect(policy!.regulations).toContain("GDPR");
  });

  it("getPolicy(id) returns a fully populated PolicyDocument", async () => {
    const policy = await getPolicy("policy_encryption");

    expect(policy).not.toBeNull();
    expect(policy!).toHaveProperty("id");
    expect(policy!).toHaveProperty("type");
    expect(policy!).toHaveProperty("version");
    expect(policy!).toHaveProperty("effective_date");
    expect(policy!).toHaveProperty("title");
    expect(policy!).toHaveProperty("description");
    expect(policy!).toHaveProperty("full_text");
    expect(policy!).toHaveProperty("regulations");
    expect(policy!).toHaveProperty("enforced");
    expect(policy!).toHaveProperty("last_reviewed");
    expect(policy!).toHaveProperty("next_review");
    expect(policy!).toHaveProperty("approved_by");
  });

  it("getAllPolicies (listPolicies) returns all default policy entries", async () => {
    const policies = await getAllPolicies();

    expect(Array.isArray(policies)).toBe(true);
    // 5 default policies are always present
    expect(policies.length).toBeGreaterThanOrEqual(5);

    const ids = policies.map(p => p.id);
    for (const knownId of KNOWN_POLICY_IDS) {
      expect(ids).toContain(knownId);
    }
  });

  it("getPoliciesByRegulation returns matching entries", async () => {
    const gdprPolicies = await getPoliciesByRegulation("GDPR");
    const soc2Policies = await getPoliciesByRegulation("SOC2");

    expect(Array.isArray(gdprPolicies)).toBe(true);
    expect(gdprPolicies.length).toBeGreaterThan(0);
    for (const p of gdprPolicies) {
      expect(p.regulations).toContain("GDPR");
    }

    expect(Array.isArray(soc2Policies)).toBe(true);
    expect(soc2Policies.length).toBeGreaterThan(0);
    for (const p of soc2Policies) {
      expect(p.regulations).toContain("SOC2");
    }
  });

  it("getPolicyText (full_text via getPolicy) returns non-empty human-readable text", async () => {
    // The task described getPolicyText(name); the real API returns full_text
    // from the policy object retrieved via getPolicy(id).
    const policy = await getPolicy("policy_privacy");

    expect(policy).not.toBeNull();
    const text = policy!.full_text;
    expect(typeof text).toBe("string");
    expect(text.trim().length).toBeGreaterThan(0);
    // Should contain human-readable headings
    expect(text).toMatch(/privacy/i);
  });

  it("describes post-quantum protection as local at-rest encryption", async () => {
    const privacy = await getPolicy("policy_privacy");
    const encryption = await getPolicy("policy_encryption");

    expect(privacy?.full_text).toMatch(/local at-rest secrets/i);
    expect(encryption?.full_text).toMatch(/offline decryption attempts against locally stored secrets/i);
    expect(encryption?.full_text).not.toMatch(/Future quantum computer attacks/);
  });

  it("unknown policy name returns null (does not throw)", async () => {
    const result = await getPolicy("policy_does_not_exist_xyz");
    expect(result).toBeNull();
  });

  it("getPolicySummary returns correct counts and structure", async () => {
    const summary = await getPolicySummary();

    expect(summary.total_policies).toBeGreaterThanOrEqual(5);
    expect(summary.enforced_policies).toBeGreaterThanOrEqual(5);
    expect(summary).toHaveProperty("by_type");
    expect(summary).toHaveProperty("by_regulation");
    expect(summary).toHaveProperty("due_for_review");

    // All default policies have enforced: true
    expect(summary.enforced_policies).toBe(summary.total_policies);
  });

  it("upsertPolicy persists a custom policy and it appears in getAllPolicies", async () => {
    const manager = getPolicyDocManager();

    const customPolicy = {
      id: "policy_custom_test",
      type: "acceptable_use" as const,
      version: "1.0.0",
      effective_date: "2025-01-01",
      title: "Custom Test Policy",
      description: "A custom policy added by unit tests.",
      full_text: "# Custom Test Policy\n\nThis is a test.",
      regulations: ["SOC2"],
      data_types: [],
      enforced: false,
      enforcement_method: "manual" as const,
      last_reviewed: "2025-01-01",
      next_review: "2026-01-01",
      approved_by: "Test Suite",
    };

    await manager.upsertPolicy(customPolicy);

    const allPolicies = await getAllPolicies();
    const ids = allPolicies.map(p => p.id);
    expect(ids).toContain("policy_custom_test");

    const retrieved = await getPolicy("policy_custom_test");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe("Custom Test Policy");
  });
});
