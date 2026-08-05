/**
 * Regression gate: runtime inputSchema validation at MCP dispatch (FX-015).
 *
 * `asToolInput<T>()` (src/index.ts:109) was a bare `args as T` cast and there
 * was no validator anywhere between the tools/call handler and the domain
 * handlers. Every `inputSchema` in src/tools/definitions/ was therefore
 * decorative: a caller could send the wrong type, an unknown property under
 * `additionalProperties: false`, or a value outside a declared `enum`, and the
 * handler would run anyway.
 *
 * Exercised end-to-end over the real MCP stdio transport, against tools that
 * are exempt from MCP auth so the assertions can only be about the schema.
 *
 * Shuffle-safe: mcp-auth holds a module-level singleton built on first use and
 * vitest.config.ts sets sequence.shuffle, so each test gets a fresh module
 * graph (the FX-013 false-green lesson).
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

interface ToolPayload {
  success: boolean;
  error?: string;
}

describe("FX-015 — inputSchema is enforced at dispatch", () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];
  const envKeys = [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NLMCP_AUDIT_DIR",
    "NLMCP_COMPLIANCE_DIR",
    "NLMCP_AUTH_DISABLED",
    "NLMCP_ADVANCED_TOOLS",
    "HEADLESS",
    "NODE_ENV",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

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
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-schema-"));
    cleanupStack.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    process.env.NLMCP_AUDIT_DIR = path.join(homeDir, "audit");
    process.env.NLMCP_COMPLIANCE_DIR = path.join(homeDir, "compliance");
    process.env.NLMCP_AUTH_DISABLED = "true";
    process.env.NLMCP_ADVANCED_TOOLS = "1";
    process.env.HEADLESS = "true";
    process.env.NODE_ENV = "test";

    const { NotebookLMMCPServer } = await import("../src/index.js");

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const server = new NotebookLMMCPServer({ registerShutdownHandlers: false });
    await server.start(new StdioServerTransport(clientToServer, serverToClient));
    cleanupStack.push(() => server.stop());

    const client = new Client({ name: "schema-test-client", version: "1.0.0" });
    await client.connect(new InMemoryStdioClientTransport(serverToClient, clientToServer));
    cleanupStack.push(() => client.close());
    return client;
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolPayload> {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(String(result.content?.[0]?.text)) as ToolPayload;
  }

  it("refuses an unknown property under additionalProperties: false", async () => {
    // search_notebooks declares additionalProperties: false with only `query`.
    // Pre-fix the extra key was silently ignored and the search ran.
    const client = await bootServer();
    const payload = await call(client, "search_notebooks", {
      query: "nothing-matches-this-xyz",
      not_a_real_property: "injected",
    });
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/not_a_real_property/);
  });

  it("refuses a wrongly-typed property", async () => {
    // get_query_history declares limit as type: "number". Pre-fix a string
    // sailed through to the handler, which happily used it.
    const client = await bootServer();
    const payload = await call(client, "get_query_history", { limit: "50" });
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/limit/);
  });

  it("refuses a number above the declared maximum", async () => {
    // get_query_history declares limit maximum: 500.
    const client = await bootServer();
    const payload = await call(client, "get_query_history", { limit: 9999 });
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/limit/);
  });

  it("refuses a number below the declared minimum", async () => {
    // get_query_history declares limit minimum: 1.
    const client = await bootServer();
    const payload = await call(client, "get_query_history", { limit: 0 });
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/limit/);
  });

  it("refuses a string that violates the declared pattern", async () => {
    // get_query_history declares date pattern ^\d{4}-\d{2}-\d{2}$.
    const client = await bootServer();
    const payload = await call(client, "get_query_history", { date: "last-tuesday" });
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/date/);
  });

  it("refuses a call missing a required property", async () => {
    const client = await bootServer();
    const payload = await call(client, "search_notebooks", {});
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/query/);
  });

  it("refuses a string longer than the declared maxLength", async () => {
    // search_notebooks declares maxLength: 500 on query.
    const client = await bootServer();
    const payload = await call(client, "search_notebooks", { query: "a".repeat(501) });
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/query/);
  });

  it("still dispatches a well-formed call to its handler", async () => {
    // Positive control: validation must not break the happy path.
    const client = await bootServer();
    const payload = await call(client, "search_notebooks", {
      query: "nothing-matches-this-xyz",
    });
    expect(payload.success).toBe(true);
  });

  it("still dispatches a call whose optional properties are all valid", async () => {
    // Positive control on the tool used for the type/range/pattern cases.
    const client = await bootServer();
    const payload = await call(client, "get_query_history", {
      limit: 5,
      date: "2026-08-05",
    });
    expect(payload.success).toBe(true);
  });
});
