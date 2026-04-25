import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { NotebookLMMCPServer } from "../src/index.js";

class InMemoryStdioClientTransport implements Transport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: (message: JSONRPCMessage) => void;

  private readonly readBuffer = new ReadBuffer();
  private started = false;

  constructor(
    private readonly input: PassThrough,
    private readonly output: PassThrough,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Transport already started");
    }
    this.started = true;
    this.input.on("data", this.handleData);
    this.input.on("error", this.handleError);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.output.write(serializeMessage(message), (error) => {
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

  private readonly handleData = (chunk: Buffer) => {
    try {
      this.readBuffer.append(chunk);
      while (true) {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          return;
        }
        this.onmessage?.(message);
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  private readonly handleError = (error: Error) => {
    this.onerror?.(error);
  };
}

describe("MCP server stdio integration", () => {
  const cleanupStack: Array<() => Promise<void> | void> = [];
  const originalEnv = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    NLMCP_AUDIT_DIR: process.env.NLMCP_AUDIT_DIR,
    NLMCP_COMPLIANCE_DIR: process.env.NLMCP_COMPLIANCE_DIR,
    NLMCP_AUTH_DISABLED: process.env.NLMCP_AUTH_DISABLED,
    NLMCP_ADVANCED_TOOLS: process.env.NLMCP_ADVANCED_TOOLS,
    HEADLESS: process.env.HEADLESS,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(async () => {
    while (cleanupStack.length > 0) {
      await cleanupStack.pop()?.();
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("boots and serves list_notebooks over MCP stdio transport", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-int-"));
    cleanupStack.push(() => fs.rmSync(homeDir, { recursive: true, force: true }));

    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = path.join(homeDir, ".config");
    process.env.XDG_DATA_HOME = path.join(homeDir, ".local", "share");
    process.env.NLMCP_AUDIT_DIR = path.join(homeDir, "audit");
    process.env.NLMCP_COMPLIANCE_DIR = path.join(homeDir, "compliance");
    process.env.NLMCP_AUTH_DISABLED = "true";
    process.env.HEADLESS = "true";
    process.env.NODE_ENV = "test";

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const serverTransport = new StdioServerTransport(clientToServer, serverToClient);
    const server = new NotebookLMMCPServer({ registerShutdownHandlers: false });
    await server.start(serverTransport);
    cleanupStack.push(() => server.stop());

    const clientTransport = new InMemoryStdioClientTransport(serverToClient, clientToServer);
    const client = new Client({ name: "integration-test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    cleanupStack.push(() => client.close());

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "list_notebooks")).toBe(true);

    const result = await client.callTool({ name: "list_notebooks", arguments: {} });
    expect(result.isError).not.toBe(true);

    const payload = JSON.parse(String(result.content[0]?.text)) as {
      success: boolean;
      data?: { notebooks?: unknown[] };
    };

    expect(payload.success).toBe(true);
    expect(Array.isArray(payload.data?.notebooks)).toBe(true);
  });

  it("unknown-tool error response body shape is success-compatible (I330/I095)", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-int-"));
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

    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const serverTransport = new StdioServerTransport(clientToServer, serverToClient);
    const server = new NotebookLMMCPServer({ registerShutdownHandlers: false });
    await server.start(serverTransport);
    cleanupStack.push(() => server.stop());

    const clientTransport = new InMemoryStdioClientTransport(serverToClient, clientToServer);
    const client = new Client({ name: "integration-test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    cleanupStack.push(() => client.close());

    // Handlers that return { success: false, data: null } from their internal catch share the same
    // body shape as the success path. Verify with list_notebooks (succeeds) vs close_session with
    // non-existent session (handled failure).
    const failResult = await client.callTool({
      name: "close_session",
      arguments: { session_id: "does-not-exist" },
    });
    // Handled failures are NOT isError — they're normal responses with success: false
    const failPayload = JSON.parse(String(failResult.content[0]?.text)) as Record<string, unknown>;
    expect(failPayload.success).toBe(false);
    // I095/I330: error payload must include data: null so callers can check payload.data safely
    expect(Object.hasOwn(failPayload, "data")).toBe(true);
    expect(failPayload.data).toBeNull();
  });
});
