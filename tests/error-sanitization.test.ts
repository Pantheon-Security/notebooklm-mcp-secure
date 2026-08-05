/**
 * Regression gate: error-message sanitisation across BOTH dispatch paths
 * (FX-022).
 *
 * src/index.ts strips absolute paths and stack fragments from an error before
 * it crosses the MCP boundary (I328). But the compliance dispatcher
 * short-circuits ahead of that wrapper and built its own
 * `Error executing ${toolName}: ${errorMessage}` from the RAW message — so
 * every compliance tool leaked fs paths and usernames to the client.
 *
 * The fix hoists the sanitiser into src/utils/security.ts as the single
 * implementation. These tests pin (a) its behaviour, byte for byte against the
 * regexes that were inline in index.ts, and (b) that the compliance path
 * actually calls it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeErrorMessage } from "../src/utils/security.js";

/**
 * The exact transformation that was inline at src/index.ts:500-503 before this
 * ticket. sanitizeErrorMessage must remain identical to it — the point of the
 * ticket is to stop the two paths drifting, not to change what either does.
 */
function legacyInlineSanitizer(raw: string): string {
  return raw
    .replace(/(?:\/[^\s/:,'"]+)+/g, "[path]")
    .replace(/\bat\s+\S+\s+\(\S+:\d+:\d+\)/g, "")
    .trim();
}

describe("FX-022 — sanitizeErrorMessage", () => {
  const samples = [
    "ENOENT: no such file or directory, open '/home/ross/.config/notebooklm/settings.json'",
    "Failed to read /Users/someone/Library/Application Support/nlmcp/library.json",
    "boom\n    at handleThing (/srv/app/dist/index.js:42:17)",
    "EACCES: permission denied, mkdir '/var/lib/nlmcp/audit'",
    "no paths in this one at all",
    "",
    "relative/path/only.json",
  ];

  it("is byte-identical to the sanitizer that was inline in index.ts", () => {
    for (const sample of samples) {
      expect(sanitizeErrorMessage(sample)).toBe(legacyInlineSanitizer(sample));
    }
  });

  it("replaces an absolute path with [path]", () => {
    const out = sanitizeErrorMessage(
      "ENOENT: no such file or directory, open '/home/ross/.config/nlmcp/settings.json'"
    );
    expect(out).toContain("[path]");
    expect(out).not.toContain("/home/ross");
    expect(out).not.toContain("ross");
  });

  it("strips stack-frame fragments", () => {
    const out = sanitizeErrorMessage("boom\n    at handleThing (/srv/app/dist/index.js:42:17)");
    expect(out).not.toMatch(/at handleThing/);
  });

  it("leaves a message with nothing sensitive alone", () => {
    expect(sanitizeErrorMessage("Notebook not found")).toBe("Notebook not found");
  });
});

describe("FX-022 — the compliance dispatch path sanitises too", () => {
  const LEAKY_PATH = "/home/ross/.local/share/notebooklm-mcp/compliance/policies.json";
  const LEAKY_MESSAGE = `ENOENT: no such file or directory, open '${LEAKY_PATH}'`;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("does not return a raw fs path when a compliance handler throws", async () => {
    // handleGetPolicy calls getPolicyDocManager().getPolicy(id). Make that
    // throw an fs-shaped error and inspect exactly what the dispatcher hands
    // back to the MCP client.
    const policyDocs = await import("../src/compliance/policy-docs.js");
    vi.spyOn(policyDocs, "getPolicyDocManager").mockReturnValue({
      getPolicy: async () => {
        throw new Error(LEAKY_MESSAGE);
      },
    } as unknown as ReturnType<typeof policyDocs.getPolicyDocManager>);

    const { handleComplianceToolCall } = await import(
      "../src/compliance/compliance-tools.js"
    );

    const content = await handleComplianceToolCall("get_policy", {
      policy_id: "privacy-policy",
    });
    const text = content.map(c => String(c.text ?? "")).join("\n");

    // The error still surfaces — it just must not carry the path.
    expect(text).toMatch(/Error executing get_policy/);
    expect(text).not.toContain(LEAKY_PATH);
    expect(text).not.toContain("/home/ross");
    expect(text).toContain("[path]");
  });

  it("keeps the RAW message in the local audit log", async () => {
    // The audit log is local and must stay precise — sanitisation is for the
    // client boundary only.
    const policyDocs = await import("../src/compliance/policy-docs.js");
    vi.spyOn(policyDocs, "getPolicyDocManager").mockReturnValue({
      getPolicy: async () => {
        throw new Error(LEAKY_MESSAGE);
      },
    } as unknown as ReturnType<typeof policyDocs.getPolicyDocManager>);

    const auditModule = await import("../src/utils/audit-logger.js");
    const auditSpy = vi
      .spyOn(auditModule.audit, "tool")
      .mockResolvedValue(undefined as never);

    const { handleComplianceToolCall } = await import(
      "../src/compliance/compliance-tools.js"
    );
    await handleComplianceToolCall("get_policy", { policy_id: "privacy-policy" });

    // audit.tool(name, args, success, duration_ms, error?)
    const failureCall = auditSpy.mock.calls.find(call => call[2] === false);
    expect(failureCall).toBeDefined();
    expect(String(failureCall?.[4])).toContain(LEAKY_PATH);
  });
});
