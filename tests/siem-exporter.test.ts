/**
 * Unit tests for SIEMExporter (src/compliance/siem-exporter.ts).
 *
 * Note: The task description referenced isEnabled(), getQueueSize(),
 * saveFailedEvent(event, dir), and retryFailed(dir). The actual API
 * exposes these as: getStats().enabled, getStats().queue_size,
 * private saveFailedEvent(event) (dir is internal), and retryFailed()
 * with no arguments.
 *
 * Config is captured at construction time from env vars — each env
 * test must reset the singleton after changing env variables.
 *
 * Network is never attempted: queueEvent only flushes when batch_size
 * is reached (default 100) and no endpoint is configured, so
 * sendToEndpoint returns false immediately without touching https/dgram.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { TMP_ROOT } = vi.hoisted(() => {
  const _fs = require("node:fs") as typeof import("node:fs");
  const _os = require("node:os") as typeof import("node:os");
  const _path = require("node:path") as typeof import("node:path");
  return {
    TMP_ROOT: _fs.mkdtempSync(_path.join(_os.tmpdir(), "nlmcp-siem-exporter-test-")),
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

// Mock https and dgram to prevent any real network calls
vi.mock("node:https", () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

vi.mock("node:dgram", () => ({
  default: { createSocket: vi.fn() },
  createSocket: vi.fn(),
}));

import { SIEMExporter, getSIEMExporter } from "../src/compliance/siem-exporter.js";

function resetSIEMExporter(): void {
  (SIEMExporter as unknown as { instance?: SIEMExporter }).instance = undefined;
}

/** Minimal SIEM event that passes the default min_severity="warning" filter */
function makeEvent(overrides: Partial<{
  event_type: string;
  event_name: string;
  severity: "info" | "warning" | "error" | "critical";
  source: string;
  message: string;
  details: Record<string, unknown>;
}> = {}) {
  return {
    timestamp: new Date().toISOString(),
    event_type: "security_alert",
    event_name: "test_event",
    severity: "warning" as const,
    source: "test-source",
    message: "test message",
    details: {},
    ...overrides,
  };
}

describe("SIEMExporter", () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    vi.clearAllMocks();
    // Clean up env vars before each test
    delete process.env.NLMCP_SIEM_ENABLED;
    delete process.env.NLMCP_SIEM_FORMAT;
    delete process.env.NLMCP_SIEM_MIN_SEVERITY;
    delete process.env.NLMCP_SIEM_EVENT_TYPES;
    delete process.env.NLMCP_SIEM_BATCH_SIZE;
    resetSIEMExporter();
  });

  afterEach(() => {
    getSIEMExporter().stop();
    delete process.env.NLMCP_SIEM_ENABLED;
    delete process.env.NLMCP_SIEM_FORMAT;
    delete process.env.NLMCP_SIEM_MIN_SEVERITY;
    delete process.env.NLMCP_SIEM_EVENT_TYPES;
    delete process.env.NLMCP_SIEM_BATCH_SIZE;
    resetSIEMExporter();
  });

  it("isEnabled (getStats().enabled) returns false when NLMCP_SIEM_ENABLED is not set", () => {
    const exporter = getSIEMExporter();
    expect(exporter.getStats().enabled).toBe(false);
  });

  it("isEnabled (getStats().enabled) returns true when NLMCP_SIEM_ENABLED=true", () => {
    process.env.NLMCP_SIEM_ENABLED = "true";
    resetSIEMExporter(); // Re-instantiate so the new env var is picked up
    const exporter = getSIEMExporter();
    expect(exporter.getStats().enabled).toBe(true);
    exporter.stop();
  });

  it("queueEvent adds to internal queue (getStats().queue_size) when enabled", async () => {
    process.env.NLMCP_SIEM_ENABLED = "true";
    resetSIEMExporter();
    const exporter = getSIEMExporter();

    expect(exporter.getStats().queue_size).toBe(0);

    const queued = await exporter.queueEvent(makeEvent());
    expect(queued).toBe(true);
    expect(exporter.getStats().queue_size).toBe(1);

    // Second event
    await exporter.queueEvent(makeEvent({ event_name: "second_event" }));
    expect(exporter.getStats().queue_size).toBe(2);
    exporter.stop();
  });

  it("queueEvent returns false and does not increment queue when disabled", async () => {
    // NLMCP_SIEM_ENABLED not set — disabled
    const exporter = getSIEMExporter();
    const queued = await exporter.queueEvent(makeEvent());
    expect(queued).toBe(false);
    expect(exporter.getStats().queue_size).toBe(0);
  });

  it("normalizes SIEM env overrides for choices, lists, and integers", async () => {
    process.env.NLMCP_SIEM_ENABLED = "true";
    process.env.NLMCP_SIEM_FORMAT = "invalid-format";
    process.env.NLMCP_SIEM_MIN_SEVERITY = "critical";
    process.env.NLMCP_SIEM_EVENT_TYPES = "security_alert, auth_failure ,";
    process.env.NLMCP_SIEM_BATCH_SIZE = "not-a-number";
    resetSIEMExporter();

    const exporter = getSIEMExporter();

    expect(exporter.getStats().enabled).toBe(true);
    expect(await exporter.queueEvent(makeEvent({ severity: "warning" }))).toBe(false);
    expect(await exporter.queueEvent(makeEvent({ severity: "critical", event_type: "ignored" }))).toBe(false);
    expect(await exporter.queueEvent(makeEvent({ severity: "critical", event_type: "security_alert" }))).toBe(true);
    expect(exporter.getStats().queue_size).toBe(1);
    exporter.stop();
  });

  it("saveFailedEvent (via flush) writes a .jsonl file to the failed dir", async () => {
    // Drive saveFailedEvent indirectly: flush() calls exportEvent which
    // calls sendToEndpoint; with no endpoint configured it returns false
    // and saveFailedEvent is called for each event in the batch.
    process.env.NLMCP_SIEM_ENABLED = "true";
    resetSIEMExporter();
    const exporter = getSIEMExporter();

    await exporter.queueEvent(makeEvent());
    const result = await exporter.flush();

    // With no endpoint configured the event cannot be sent
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);

    // A .jsonl file must have been written in the siem_failed dir
    const failedDir = path.join(TMP_ROOT, "siem_failed");
    expect(fs.existsSync(failedDir)).toBe(true);
    const files = fs.readdirSync(failedDir).filter(f => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(failedDir, files[0]!), "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(content.trim()) as { event_name: string };
    expect(parsed).toHaveProperty("event_name", "test_event");
    exporter.stop();
  });

  it("retryFailed reads the failed events file and re-queues them (attempts re-export)", async () => {
    process.env.NLMCP_SIEM_ENABLED = "true";
    resetSIEMExporter();
    const exporter = getSIEMExporter();

    // Seed a failed events file manually
    const failedDir = path.join(TMP_ROOT, "siem_failed");
    fs.mkdirSync(failedDir, { recursive: true });
    const today = new Date().toISOString().split("T")[0];
    const failedFile = path.join(failedDir, `failed-${today}.jsonl`);
    fs.writeFileSync(failedFile, JSON.stringify(makeEvent()) + "\n");

    // retryFailed will attempt to export; with no endpoint it fails
    const result = await exporter.retryFailed();
    expect(result.sent + result.failed).toBeGreaterThanOrEqual(1);

    exporter.stop();
  });
});
