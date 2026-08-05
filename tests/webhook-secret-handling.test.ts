/**
 * Regression gate: webhook HMAC secret must never be persisted or disclosed
 * (FX-016).
 *
 * addWebhook deliberately keeps the secret out of the persisted object
 * (`secret: undefined, // secret never persisted to disk`, I321) and holds it
 * in a SecureCredential. updateWebhook spread `input.secret` straight into the
 * object that saveStore() writes to webhooks.json — and listWebhooks() returned
 * the stored objects by reference, so `list_webhooks` (a read-scope,
 * auth-exempt tool) handed the secret back out.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s3cr3t-hmac-value-do-not-persist";

describe("FX-016 — webhook secret handling", () => {
  let homeDir: string;
  const envKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NLMCP_WEBHOOK_RESOLVE_DNS",
    "NODE_ENV",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-wh-secret-"));
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    // Skip DNS resolution — this file is about secret handling, not SSRF.
    process.env.NLMCP_WEBHOOK_RESOLVE_DNS = "false";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function newDispatcher() {
    const mod = await import("../src/webhooks/webhook-dispatcher.js");
    const { CONFIG } = await import("../src/config.js");
    const dispatcher = new mod.WebhookDispatcher();
    return { dispatcher, storePath: path.join(CONFIG.dataDir, "webhooks.json") };
  }

  it("does not write the secret to disk on updateWebhook", async () => {
    const { dispatcher, storePath } = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "test-hook",
      url: "https://example.com/hook",
    });
    await dispatcher.updateWebhook({ id: webhook.id, secret: SECRET });

    const onDisk = fs.readFileSync(storePath, "utf-8");
    expect(onDisk).not.toContain(SECRET);
  });

  it("does not disclose the secret through listWebhooks", async () => {
    const { dispatcher } = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "test-hook",
      url: "https://example.com/hook",
    });
    await dispatcher.updateWebhook({ id: webhook.id, secret: SECRET });

    const listed = dispatcher.listWebhooks();
    expect(listed).toHaveLength(1);
    expect(listed[0].secret).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("does not disclose a secret set at addWebhook time either", async () => {
    const { dispatcher } = await newDispatcher();

    await dispatcher.addWebhook({
      name: "test-hook",
      url: "https://example.com/hook",
      secret: SECRET,
    });

    expect(JSON.stringify(dispatcher.listWebhooks())).not.toContain(SECRET);
  });

  it("does not hand out a live reference into the store", async () => {
    const { dispatcher } = await newDispatcher();
    await dispatcher.addWebhook({ name: "test-hook", url: "https://example.com/hook" });

    const listed = dispatcher.listWebhooks();
    listed[0].name = "mutated-by-caller";

    expect(dispatcher.listWebhooks()[0].name).toBe("test-hook");
  });

  it("still signs deliveries with a secret set via updateWebhook", async () => {
    // The secret must keep WORKING — it just lives in the SecureCredential
    // store rather than on disk.
    const { dispatcher } = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "test-hook",
      url: "https://example.com/hook",
    });
    await dispatcher.updateWebhook({ id: webhook.id, secret: SECRET });

    const captured: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        captured.push(init.headers);
        return { ok: true, status: 200 } as Response;
      })
    );

    const result = await dispatcher.testWebhook(webhook.id);

    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]["X-Webhook-Signature"]).toBeTruthy();
    expect(captured[0]["X-Webhook-Timestamp"]).toBeTruthy();
    // The signature is an HMAC, not the secret itself.
    expect(captured[0]["X-Webhook-Signature"]).not.toContain(SECRET);

    vi.unstubAllGlobals();
  });

  it("clears the stored credential when the secret is set to empty", async () => {
    const { dispatcher } = await newDispatcher();

    const webhook = await dispatcher.addWebhook({
      name: "test-hook",
      url: "https://example.com/hook",
      secret: SECRET,
    });
    await dispatcher.updateWebhook({ id: webhook.id, secret: "" });

    const captured: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        captured.push(init.headers);
        return { ok: true, status: 200 } as Response;
      })
    );

    await dispatcher.testWebhook(webhook.id);

    expect(captured).toHaveLength(1);
    expect(captured[0]["X-Webhook-Signature"]).toBeUndefined();

    vi.unstubAllGlobals();
  });
});
