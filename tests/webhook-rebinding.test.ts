/**
 * Regression gate: webhook DNS-rebinding TOCTOU (FX-017).
 *
 * validateWebhookUrl ran only at addWebhook/updateWebhook. sendWithRetry's
 * fetch re-resolved the hostname with no re-check, so a host that validated as
 * public at registration could later resolve to 169.254.169.254 or an RFC1918
 * address and the request went out anyway. `redirect: "error"` blocks the
 * redirect variant of this, not the rebinding one.
 *
 * These tests register a webhook while DNS says "public", then flip DNS to a
 * private answer before dispatching — the send must be refused.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dispatcher does `import dns from "node:dns/promises"`, and an ESM module
 * namespace is not configurable — vi.spyOn cannot reach it. Hoisted vi.mock is
 * the only way to control the resolver, so the current answer lives in a
 * mutable holder the tests flip between registration and dispatch.
 */
const dnsAnswer = vi.hoisted(() => ({ address: "93.184.216.34", family: 4 as 4 | 6 }));

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: async () => [{ address: dnsAnswer.address, family: dnsAnswer.family }],
  },
  lookup: async () => [{ address: dnsAnswer.address, family: dnsAnswer.family }],
}));

describe("FX-017 — webhook DNS rebinding is re-checked at send time", () => {
  let homeDir: string;
  const envKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NODE_ENV"] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-wh-rebind-"));
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * Reset the resolver to a public answer and expose a setter so the record
   * can be flipped between registration and dispatch — that gap IS the
   * vulnerability.
   */
  function stubDns(): { setAnswer: (ip: string, family: 4 | 6) => void } {
    dnsAnswer.address = "93.184.216.34";
    dnsAnswer.family = 4;
    return {
      setAnswer: (ip: string, family: 4 | 6) => {
        dnsAnswer.address = ip;
        dnsAnswer.family = family;
      },
    };
  }

  async function newDispatcher() {
    const mod = await import("../src/webhooks/webhook-dispatcher.js");
    return new mod.WebhookDispatcher();
  }

  it("refuses to send when the host has rebound to a private IPv4", async () => {
    const dns = stubDns();
    const dispatcher = await newDispatcher();

    // Registration succeeds: the host resolves public right now.
    const webhook = await dispatcher.addWebhook({
      name: "rebinding-hook",
      url: "https://rebind.example.com/hook",
    });

    // ...then the attacker flips the record.
    dns.setAnswer("127.0.0.1", 4);

    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatcher.testWebhook(webhook.id);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("refuses to send when the host has rebound to cloud metadata", async () => {
    const dns = stubDns();
    const dispatcher = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "metadata-hook",
      url: "https://rebind.example.com/hook",
    });

    // The classic SSRF target: link-local cloud metadata.
    dns.setAnswer("169.254.169.254", 4);

    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatcher.testWebhook(webhook.id);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("refuses to send when the host has rebound to a private IPv6", async () => {
    const dns = stubDns();
    const dispatcher = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "v6-hook",
      url: "https://rebind.example.com/hook",
    });

    dns.setAnswer("::1", 6);

    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatcher.testWebhook(webhook.id);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("still sends when the host stays public", async () => {
    // Positive control: the re-check must not break normal delivery.
    stubDns();
    const dispatcher = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "healthy-hook",
      url: "https://stable.example.com/hook",
    });

    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await dispatcher.testWebhook(webhook.id);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
