/**
 * Regression gate: dispatch-layer authorization (FX-013 / FX-014).
 *
 * FX-013 — SettingsManager.filterTools was applied only to the tool LISTING
 * (index.ts:245, :367), never to the dispatch registry. A tool disabled by
 * profile, settings.json or NOTEBOOKLM_DISABLED_TOOLS disappeared from
 * list_tools but still executed on tools/call, so the operator control was
 * cosmetic.
 *
 * FX-014 — the resource/prompt/completion handlers never call
 * authenticateMCPRequest. With auth ENABLED and no token, tools/call is
 * refused but resources/read notebooklm://library returns the same data,
 * including notebook URLs.
 *
 * Both are exercised end-to-end over the real MCP stdio transport.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

class InMemoryStdioClientTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private started = false;

  constructor(
    private readonly input: PassThrough,
    private readonly output: PassThrough
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("Transport already started");
    this.started = true;
    this.input.on("data", this.handleData);
    this.input.on("error", this.handleError);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.output.write(serializeMessage(message), error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.input.off("data", this.handleData);
    this.input.off("error", this.handleError);
    this.input.pause();
    this.onclose?.();
  }

  private handleData = (chunk: Buffer): void => {
    this.readBuffer.append(chunk);
    for (;;) {
      const message = this.readBuffer.readMessage();
      if (!message) break;
      this.onmessage?.(message);
    }
  };

  private handleError = (error: Error): void => {
    this.onerror?.(error);
  };
}

describe("dispatch-layer authorization", () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];
  const envKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NLMCP_AUDIT_DIR",
    "NLMCP_COMPLIANCE_DIR",
    "NLMCP_AUTH_DISABLED",
    "NOTEBOOKLM_DISABLED_TOOLS",
    "HEADLESS",
    "NODE_ENV",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  // mcp-auth keeps a module-level singleton authenticator built on first use,
  // and vitest.config.ts runs with sequence.shuffle. Without a fresh module
  // graph per test, whichever test boots a server first decides whether auth is
  // enabled for BOTH, making this file order-dependent.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    while (cleanupStack.length > 0) {
      await cleanupStack.pop()?.();
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function bootServer(): Promise<Client> {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-authz-"));
    cleanupStack.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    process.env.NLMCP_AUDIT_DIR = path.join(homeDir, "audit");
    process.env.NLMCP_COMPLIANCE_DIR = path.join(homeDir, "compliance");
    process.env.HEADLESS = "true";
    process.env.NODE_ENV = "test";

    const { NotebookLMMCPServer } = await import("../src/index.js");

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new NotebookLMMCPServer({ registerShutdownHandlers: false });
    await server.start(new StdioServerTransport(clientToServer, serverToClient));
    cleanupStack.push(() => server.stop());

    const client = new Client({ name: "authz-test-client", version: "1.0.0" });
    await client.connect(new InMemoryStdioClientTransport(serverToClient, clientToServer));
    cleanupStack.push(() => client.close());
    return client;
  }

  describe("FX-013 — a disabled tool must not be dispatchable", () => {
    it("refuses tools/call for a tool removed by NOTEBOOKLM_DISABLED_TOOLS", async () => {
      process.env.NLMCP_AUTH_DISABLED = "true";
      process.env.NOTEBOOKLM_DISABLED_TOOLS = "list_notebooks";

      const client = await bootServer();

      // Hidden from the listing — this part already worked.
      const tools = await client.listTools();
      expect(tools.tools.some(t => t.name === "list_notebooks")).toBe(false);

      // ...and must also be refused when called directly by name.
      const result = await client.callTool({ name: "list_notebooks", arguments: {} });
      const payload = JSON.parse(String(result.content?.[0]?.text)) as {
        success: boolean;
        error?: string;
      };
      expect(payload.success).toBe(false);
    });
  });

  describe("FX-014 — resources require the same auth as tools", () => {
    it("refuses resources/read when auth is enabled and no token is presented", async () => {
      // Auth ON (not disabled) and no token supplied by this client.
      delete process.env.NLMCP_AUTH_DISABLED;

      const client = await bootServer();

      await expect(
        client.readResource({ uri: "notebooklm://library" })
      ).rejects.toThrow();
    });
  });
});
