/**
 * Unit tests for webhook dispatcher (src/webhooks/webhook-dispatcher.ts).
 *
 * Focuses on the URL validator (I269 hardening) and the HMAC signing
 * contract. Fetch/retry integration is exercised via stubbed globalThis.fetch
 * so we don't make real outbound requests during tests.
 *
 * See ISSUES.md I268.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Stub audit logger + compliance change-log + config before importing the
// module under test so constructing the singleton doesn't touch the user's
// real data dirs. vi.hoisted lifts the tmp-dir creation alongside the
// vi.mock factories so both see the same path.
const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return { TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-webhook-test-")) };
});

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, dataDir: TMP_ROOT, configDir: TMP_ROOT },
  };
});

vi.mock("../src/utils/audit-logger.js", () => ({
  audit: {
    auth: vi.fn().mockResolvedValue(undefined),
    security: vi.fn().mockResolvedValue(undefined),
    session: vi.fn().mockResolvedValue(undefined),
    system: vi.fn().mockResolvedValue(undefined),
    tool: vi.fn().mockResolvedValue(undefined),
    compliance: vi.fn().mockResolvedValue(undefined),
    dataAccess: vi.fn().mockResolvedValue(undefined),
    configChange: vi.fn().mockResolvedValue(undefined),
    retention: vi.fn().mockResolvedValue(undefined),
  },
  getAuditLogger: vi.fn(() => ({
    onEvent: vi.fn(() => () => undefined),
    getStats: vi.fn(() => ({ totalEvents: 0 })),
  })),
}));

vi.mock("../src/compliance/change-log.js", () => ({
  getChangeLog: vi.fn(() => ({
    recordChange: vi.fn().mockResolvedValue(undefined),
  })),
}));

import {
  validateWebhookUrl,
  WebhookDispatcher,
} from "../src/webhooks/webhook-dispatcher.js";

beforeEach(() => {
  // DNS lookup makes tests slow and non-hermetic; default off for this
  // suite so we only exercise lexical checks. Individual tests that
  // want to prove DNS-based rejection will re-enable it.
  process.env.NLMCP_WEBHOOK_RESOLVE_DNS = "false";
  delete process.env.NLMCP_WEBHOOK_ALLOW_HTTP;
  delete process.env.NLMCP_WEBHOOK_URL;
  delete process.env.NLMCP_SLACK_WEBHOOK_URL;
  delete process.env.NLMCP_DISCORD_WEBHOOK_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateWebhookUrl", () => {
  describe("scheme rules", () => {
    it("accepts https", async () => {
      const r = await validateWebhookUrl("https://hooks.slack.com/services/AAA/BBB");
      expect(r.ok).toBe(true);
    });

    it("rejects http by default", async () => {
      const r = await validateWebhookUrl("http://hooks.slack.com/services/AAA");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/scheme/i);
    });

    it("accepts http when NLMCP_WEBHOOK_ALLOW_HTTP=true", async () => {
      process.env.NLMCP_WEBHOOK_ALLOW_HTTP = "true";
      const r = await validateWebhookUrl("http://hooks.slack.com/services/AAA");
      expect(r.ok).toBe(true);
    });

    it("rejects ftp and other schemes", async () => {
      const r = await validateWebhookUrl("ftp://example.com/webhook");
      expect(r.ok).toBe(false);
    });
  });

  describe("parse errors", () => {
    it("rejects malformed URLs", async () => {
      const r = await validateWebhookUrl("not a url");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/invalid URL/i);
    });

    it("rejects empty string", async () => {
      const r = await validateWebhookUrl("");
      expect(r.ok).toBe(false);
    });
  });

  describe("private IPv4 ranges (SSRF block)", () => {
    const privateCases = [
      ["169.254.169.254", "AWS/GCP metadata"],
      ["127.0.0.1", "loopback"],
      ["10.0.0.5", "RFC1918 10/8"],
      ["10.255.255.255", "RFC1918 10/8 upper"],
      ["172.16.0.1", "RFC1918 172.16/12 low"],
      ["172.31.255.1", "RFC1918 172.16/12 high"],
      ["192.168.1.1", "RFC1918 192.168"],
      ["100.64.0.1", "CGNAT 100.64/10"],
      ["0.0.0.0", "any-address"],
      ["224.0.0.1", "multicast"],
    ];
    for (const [ip, label] of privateCases) {
      it(`rejects ${label} (${ip})`, async () => {
        const r = await validateWebhookUrl(`https://${ip}/webhook`);
        expect(r.ok).toBe(false);
      });
    }

    it("accepts a public IPv4", async () => {
      const r = await validateWebhookUrl("https://8.8.8.8/webhook");
      expect(r.ok).toBe(true);
    });

    it("accepts 172.32 (outside RFC1918)", async () => {
      const r = await validateWebhookUrl("https://172.32.0.1/webhook");
      expect(r.ok).toBe(true);
    });
  });

  describe("private IPv6 ranges", () => {
    it("rejects IPv6 loopback [::1]", async () => {
      const r = await validateWebhookUrl("https://[::1]/webhook");
      expect(r.ok).toBe(false);
    });

    it("rejects IPv6 link-local fe80::", async () => {
      const r = await validateWebhookUrl("https://[fe80::1]/webhook");
      expect(r.ok).toBe(false);
    });

    it("rejects IPv6 unique-local fc00::", async () => {
      const r = await validateWebhookUrl("https://[fc00::1]/webhook");
      expect(r.ok).toBe(false);
    });

    it("rejects IPv4-mapped IPv6 pointing at metadata", async () => {
      const r = await validateWebhookUrl("https://[::ffff:169.254.169.254]/webhook");
      expect(r.ok).toBe(false);
    });
  });

  describe("hostname string blocks", () => {
    it("rejects localhost", async () => {
      const r = await validateWebhookUrl("https://localhost/webhook");
      expect(r.ok).toBe(false);
    });

    it("rejects *.internal hosts", async () => {
      const r = await validateWebhookUrl("https://server.internal/webhook");
      expect(r.ok).toBe(false);
    });

    it("rejects *.local mDNS hosts", async () => {
      const r = await validateWebhookUrl("https://printer.local/webhook");
      expect(r.ok).toBe(false);
    });
  });
});

describe("WebhookDispatcher", () => {
  let dispatcher: WebhookDispatcher;

  beforeEach(() => {
    dispatcher = new WebhookDispatcher();
  });

  afterEach(() => {
    dispatcher.destroy();
  });

  describe("addWebhook", () => {
    it("persists a valid webhook", async () => {
      const wh = await dispatcher.addWebhook({
        name: "Test Slack",
        url: "https://hooks.slack.com/services/AAA/BBB",
        events: ["*"],
      });
      expect(wh.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(wh.url).toBe("https://hooks.slack.com/services/AAA/BBB");
      expect(dispatcher.listWebhooks().some((w) => w.id === wh.id)).toBe(true);
    });

    it("rejects a private-IP webhook URL", async () => {
      await expect(
        dispatcher.addWebhook({
          name: "Evil Metadata",
          url: "https://169.254.169.254/latest/meta-data",
          events: ["*"],
        }),
      ).rejects.toThrow(/webhook URL rejected/i);
    });

    it("rejects http when not opted in", async () => {
      await expect(
        dispatcher.addWebhook({ name: "HTTP", url: "http://public.example.com/hook", events: ["*"] }),
      ).rejects.toThrow(/scheme/i);
    });
  });

  describe("updateWebhook", () => {
    it("revalidates URL when it changes", async () => {
      const wh = await dispatcher.addWebhook({
        name: "initially-ok",
        url: "https://ok.example.com/hook",
        events: ["*"],
      });
      await expect(
        dispatcher.updateWebhook({ id: wh.id, url: "https://127.0.0.1/hook" }),
      ).rejects.toThrow(/webhook URL rejected/i);
    });

    it("allows non-URL updates without revalidation", async () => {
      const wh = await dispatcher.addWebhook({
        name: "renameable",
        url: "https://ok.example.com/hook",
        events: ["*"],
      });
      const updated = await dispatcher.updateWebhook({ id: wh.id, name: "renamed" });
      expect(updated?.name).toBe("renamed");
      expect(updated?.url).toBe("https://ok.example.com/hook");
    });

    it("returns null when updating an unknown id", async () => {
      const r = await dispatcher.updateWebhook({ id: "00000000-0000-0000-0000-000000000000", name: "x" });
      expect(r).toBeNull();
    });
  });

  describe("removeWebhook", () => {
    it("removes an existing webhook and returns true", async () => {
      const wh = await dispatcher.addWebhook({
        name: "temp",
        url: "https://ok.example.com/hook",
        events: ["*"],
      });
      const removed = await dispatcher.removeWebhook(wh.id);
      expect(removed).toBe(true);
      expect(dispatcher.listWebhooks().some((w) => w.id === wh.id)).toBe(false);
    });

    it("returns false when id is unknown", async () => {
      const r = await dispatcher.removeWebhook("00000000-0000-0000-0000-000000000000");
      expect(r).toBe(false);
    });
  });

  describe("testWebhook dispatch via fetch stub", () => {
    it("sends a signed request with X-Webhook-Signature when a secret is configured", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status: 200 }));

      const wh = await dispatcher.addWebhook({
        name: "signed",
        url: "https://example.com/hook",
        events: ["*"],
        secret: "supersecret",
      });

      const result = await dispatcher.testWebhook(wh.id);
      expect(result.success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const args = fetchSpy.mock.calls[0];
      const init = args[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
      // redirect: "error" must be set to prevent allowlist->metadata pivot
      expect(init.redirect).toBe("error");
    });

    it("records failure when fetch throws", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

      const wh = await dispatcher.addWebhook({
        name: "fails",
        url: "https://example.com/hook",
        events: ["*"],
      });
      const result = await dispatcher.testWebhook(wh.id);
      expect(result.success).toBe(false);
      const stats = dispatcher.getStats();
      expect(stats.failureCount).toBeGreaterThanOrEqual(1);
    });
  });
});
