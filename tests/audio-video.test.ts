import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// randomDelay is awaited multiple times in downloadAudio; stub it out so the
// tests run instantly and deterministically.
vi.mock("../src/utils/stealth-utils.js", () => ({
  randomDelay: vi.fn().mockResolvedValue(undefined),
}));

import { AudioManager } from "../src/notebook-creation/audio-manager.js";

/**
 * Build an AudioManager wired to mocked auth + context + page.
 *
 * `evaluateResults` is the ordered list of values returned by successive
 * page.evaluate() calls. Inside downloadAudio these are, in order:
 *   1. checkAudioStatusInternal  -> AudioStatus
 *   2. downloadInfo scrape       -> { type, url } | null
 *   3. click-fallback (only when downloadInfo is missing) -> boolean
 *
 * `gotoImpl` lets a test observe / control the download navigation
 * (page.goto is called once for navigation and again for the download URL).
 */
function makeAudioManager(opts: {
  evaluateResults: unknown[];
  gotoImpl?: (url: string) => unknown;
}) {
  const gotoSpy = vi.fn(async (url: string) => {
    if (opts.gotoImpl) return opts.gotoImpl(url);
    return undefined;
  });

  const evaluate = vi.fn();
  for (const result of opts.evaluateResults) {
    evaluate.mockResolvedValueOnce(result);
  }

  const page = {
    goto: gotoSpy,
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate,
    close: vi.fn().mockResolvedValue(undefined),
  };

  const context = {
    newPage: vi.fn().mockResolvedValue(page),
  };

  const authManager = {
    validateWithRetry: vi.fn().mockResolvedValue(true),
  };

  const contextManager = {
    getOrCreateContext: vi.fn().mockResolvedValue(context),
  };

  const manager = new AudioManager(authManager as never, contextManager as never);
  return { manager, page, gotoSpy, evaluate };
}

const NOTEBOOK_URL = "https://notebooklm.google.com/notebook/abc123";

/** A page.goto download response that serves `bytes` of audio. */
function audioResponse(bytes: number, headers: Record<string, string> = {}) {
  return {
    headers: () => ({ "content-type": "audio/mpeg", ...headers }),
    body: async () => Buffer.alloc(bytes, 0x41),
  };
}

describe("AudioManager.downloadAudio", () => {
  let tmpDir: string;
  let prevExportDir: string | undefined;

  beforeEach(() => {
    // Confine downloads to a throwaway dir so the default-path case never
    // writes into the real home directory.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-audio-test-"));
    prevExportDir = process.env.NLMCP_EXPORT_DIR;
    process.env.NLMCP_EXPORT_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevExportDir === undefined) {
      delete process.env.NLMCP_EXPORT_DIR;
    } else {
      process.env.NLMCP_EXPORT_DIR = prevExportDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports failure (no file written) when only the click-fallback download path runs (M27)", async () => {
    // Ready, but no scrapable download URL -> code clicks a button it cannot
    // capture, so NO file is written. The old code wrongly returned
    // success:true here; the fix returns success:false.
    const { manager, gotoSpy } = makeAudioManager({
      evaluateResults: [
        { status: "ready" }, // checkAudioStatusInternal
        null, // downloadInfo: nothing scrapable
        true, // click-fallback succeeded
      ],
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL);

    expect(result.success).toBe(false);
    expect(result.filePath).toBeUndefined();
    expect(result.error).toContain("no file was saved");
    // Only the navigation goto happened; no download navigation occurred.
    expect(gotoSpy).toHaveBeenCalledTimes(1);
  });

  it("writes the default file inside the confined download dir, not $HOME, when output_path is omitted (C2)", async () => {
    const fileBytes = 2048;
    const { manager } = makeAudioManager({
      evaluateResults: [
        { status: "ready" },
        { type: "audio", url: "https://notebooklm.googleusercontent.com/audio/123.mp3" },
      ],
      gotoImpl: (url) => {
        if (url.startsWith("https://notebooklm.googleusercontent.com")) {
          return audioResponse(fileBytes, { "content-length": String(fileBytes) });
        }
        return undefined; // navigation
      },
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL);

    expect(result.success).toBe(true);
    expect(result.size).toBe(fileBytes);
    expect(result.filePath).toBeDefined();

    const filePath = result.filePath as string;
    // The default file must be confined inside NLMCP_EXPORT_DIR (the tmp dir),
    // never the real home directory.
    const rel = path.relative(tmpDir, filePath);
    expect(rel.startsWith("..")).toBe(false);
    expect(path.isAbsolute(rel)).toBe(false);
    expect(filePath.startsWith(os.homedir())).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.statSync(filePath).size).toBe(fileBytes);
    expect(path.basename(filePath)).toMatch(/^notebooklm-audio-\d+\.mp3$/);
  });

  it("downloads to an explicit output_path confined inside the base dir", async () => {
    const fileBytes = 512;
    const { manager } = makeAudioManager({
      evaluateResults: [
        { status: "ready" },
        { type: "button", url: "https://www.google.com/download/audio.mp3" },
      ],
      gotoImpl: (url) =>
        url.startsWith("https://www.google.com") ? audioResponse(fileBytes) : undefined,
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL, "my-audio.mp3");

    expect(result.success).toBe(true);
    expect(result.filePath).toBe(path.join(tmpDir, "my-audio.mp3"));
    expect(fs.existsSync(result.filePath as string)).toBe(true);
  });

  it("refuses an SSRF download URL (link-local metadata host) without navigating to it (C3)", async () => {
    const ssrfUrl = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";
    const { manager, gotoSpy } = makeAudioManager({
      evaluateResults: [
        { status: "ready" },
        { type: "button", url: ssrfUrl },
      ],
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Crucially: the manager must never have navigated to the attacker URL.
    const navigatedUrls = gotoSpy.mock.calls.map((c) => c[0]);
    expect(navigatedUrls).not.toContain(ssrfUrl);
    expect(navigatedUrls.every((u) => !String(u).includes("169.254.169.254"))).toBe(true);
  });

  it("refuses a file:// download URL without navigating to it (C3)", async () => {
    const fileUrl = "file:///etc/passwd";
    const { manager, gotoSpy } = makeAudioManager({
      evaluateResults: [
        { status: "ready" },
        { type: "audio", url: fileUrl },
      ],
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL);

    expect(result.success).toBe(false);
    const navigatedUrls = gotoSpy.mock.calls.map((c) => c[0]);
    expect(navigatedUrls).not.toContain(fileUrl);
  });

  it("rejects an output_path that escapes the base dir via '..' traversal (C2)", async () => {
    // A valid, allowed download URL is present, so the only thing that can
    // reject the request is the path-traversal guard in resolveAudioOutputPath,
    // which runs before the download navigation.
    const { manager, gotoSpy } = makeAudioManager({
      evaluateResults: [
        { status: "ready" },
        { type: "button", url: "https://www.google.com/download/audio.mp3" },
      ],
      gotoImpl: (url) =>
        url.startsWith("https://www.google.com") ? audioResponse(64) : undefined,
    });

    const escaping = "../../../../tmp/nlmcp-escape-" + Date.now() + ".mp3";
    const result = await manager.downloadAudio(NOTEBOOK_URL, escaping);

    expect(result.success).toBe(false);
    expect(result.error).toContain("output_path must resolve inside");
    // No download navigation should have occurred (rejected before goto).
    expect(gotoSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an audio file that exceeds the size cap (H14)", async () => {
    const MAX = 200 * 1024 * 1024;
    const { manager } = makeAudioManager({
      evaluateResults: [
        { status: "ready" },
        { type: "button", url: "https://www.google.com/download/big.mp3" },
      ],
      gotoImpl: (url) =>
        url.startsWith("https://www.google.com")
          ? {
              headers: () => ({
                "content-type": "audio/mpeg",
                "content-length": String(MAX + 1),
              }),
              body: async () => Buffer.alloc(0),
            }
          : undefined,
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL, "big.mp3");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
    expect(fs.existsSync(path.join(tmpDir, "big.mp3"))).toBe(false);
  });

  it("returns failure when audio is not ready", async () => {
    const { manager, gotoSpy } = makeAudioManager({
      evaluateResults: [{ status: "generating" }],
    });

    const result = await manager.downloadAudio(NOTEBOOK_URL);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Audio not ready");
    expect(gotoSpy).toHaveBeenCalledTimes(1); // navigation only
  });
});
