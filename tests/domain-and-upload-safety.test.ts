/**
 * Regression gate: NotebookLM domain coverage + upload confinement
 * (FX-011 / FX-012).
 *
 * FX-011 — ALLOWED_NOTEBOOK_DOMAINS listed only 9 ccTLDs. Once FX-008 put
 * validateNotebookUrl on the session-creation sink, any user on an unlisted
 * regional domain (notebooklm.google.co.jp, .in, .br, .de …) could no longer
 * open a session at all. The allowlist must cover Google ccTLDs generally
 * WITHOUT admitting attacker-controlled lookalikes.
 *
 * FX-012 — upload_document passed args.file_path to the Gemini Files API with
 * only a non-empty check, so any readable file could be uploaded and then read
 * back via query_document. Its sibling add_folder has always enforced an
 * allowlist.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateNotebookUrl } from "../src/utils/security.js";
import { handleUploadDocument } from "../src/tools/handlers/gemini.js";
import type { HandlerContext } from "../src/tools/handlers/types.js";

afterEach(() => {
  delete process.env.NLMCP_FOLDER_ALLOWLIST;
});

describe("FX-011 — NotebookLM regional domains", () => {
  const shouldPass = [
    "https://notebooklm.google.com/notebook/abc",
    "https://notebooklm.google.co.uk/notebook/abc",
    "https://notebooklm.google.com.au/notebook/abc",
    "https://notebooklm.google.co.jp/notebook/abc",
    "https://notebooklm.google.de/notebook/abc",
    "https://notebooklm.google.in/notebook/abc",
    "https://notebooklm.google.com.br/notebook/abc",
  ];

  for (const url of shouldPass) {
    it(`accepts ${url}`, () => {
      expect(() => validateNotebookUrl(url)).not.toThrow();
    });
  }

  const shouldFail = [
    // Lookalikes and hostile suffixes must still be refused.
    "https://notebooklm.google.attacker.com/notebook/abc",
    "https://notebooklm.google.co.uk.attacker.com/notebook/abc",
    "https://evil-notebooklm.google.com/notebook/abc",
    "https://notebooklm.corp.google.com/notebook/abc",
    "https://notebooklmgoogle.com/notebook/abc",
    "https://accounts.google.com/signin",
    "https://attacker.example/phish",
  ];

  for (const url of shouldFail) {
    it(`rejects ${url}`, () => {
      expect(() => validateNotebookUrl(url)).toThrow();
    });
  }
});

describe("FX-012 — upload_document confines its file path", () => {
  const ctxWithGemini = (uploadDocument: () => unknown): HandlerContext =>
    ({
      getGeminiClient: () => ({ uploadDocument }),
    }) as unknown as HandlerContext;

  it("rejects a path outside the allowlist and never reaches the API", async () => {
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-up-allow-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-up-outside-"));
    const secret = path.join(outsideDir, "id_rsa");
    fs.writeFileSync(secret, "PRIVATE KEY");
    process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

    let called = false;
    const result = await handleUploadDocument(
      ctxWithGemini(() => {
        called = true;
        return {};
      }),
      { file_path: secret }
    );

    expect(result.success).toBe(false);
    expect(called).toBe(false);

    fs.rmSync(allowedDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects a path traversing a sensitive credential directory", async () => {
    const allowedDir = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-up-allow-"));
    const sshDir = path.join(allowedDir, ".ssh");
    fs.mkdirSync(sshDir);
    const secret = path.join(sshDir, "id_rsa");
    fs.writeFileSync(secret, "PRIVATE KEY");
    process.env.NLMCP_FOLDER_ALLOWLIST = allowedDir;

    let called = false;
    const result = await handleUploadDocument(
      ctxWithGemini(() => {
        called = true;
        return {};
      }),
      { file_path: secret }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sensitive directory/);
    expect(called).toBe(false);

    fs.rmSync(allowedDir, { recursive: true, force: true });
  });
});
