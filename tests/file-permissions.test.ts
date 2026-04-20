/**
 * Unit tests for file-permissions utility (src/utils/file-permissions.ts).
 *
 * Covers writeFileSecure, appendFileSecure, mkdirSecure,
 * setSecureFilePermissions, setSecureDirectoryPermissions,
 * PERMISSION_MODES constants, and platform detection exports.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeFileSecure,
  appendFileSecure,
  mkdirSecure,
  setSecureFilePermissions,
  setSecureDirectoryPermissions,
  getPlatformInfo,
  PERMISSION_MODES,
  isWindows,
  isMacOS,
  isLinux,
  isUnix,
} from "../src/utils/file-permissions.js";

let TMP_DIR: string;

beforeEach(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-perms-test-"));
});

afterEach(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PERMISSION_MODES constants
// ---------------------------------------------------------------------------

describe("PERMISSION_MODES", () => {
  it("OWNER_READ_WRITE is 0o600", () => {
    expect(PERMISSION_MODES.OWNER_READ_WRITE).toBe(0o600);
  });

  it("OWNER_FULL is 0o700", () => {
    expect(PERMISSION_MODES.OWNER_FULL).toBe(0o700);
  });

  it("OWNER_WRITE_ALL_READ is 0o644", () => {
    expect(PERMISSION_MODES.OWNER_WRITE_ALL_READ).toBe(0o644);
  });

  it("OWNER_FULL_ALL_READ_EXECUTE is 0o755", () => {
    expect(PERMISSION_MODES.OWNER_FULL_ALL_READ_EXECUTE).toBe(0o755);
  });
});

// ---------------------------------------------------------------------------
// Platform detection exports
// ---------------------------------------------------------------------------

describe("platform detection", () => {
  it("exactly one of isWindows / isMacOS / isLinux is true", () => {
    const count = [isWindows, isMacOS, isLinux].filter(Boolean).length;
    expect(count).toBe(1);
  });

  it("isUnix is the logical complement of isWindows", () => {
    expect(isUnix).toBe(!isWindows);
  });

  it("getPlatformInfo returns consistent values", () => {
    const info = getPlatformInfo();
    expect(info.isWindows).toBe(isWindows);
    expect(info.isMacOS).toBe(isMacOS);
    expect(info.isLinux).toBe(isLinux);
    expect(info.supportsUnixPermissions).toBe(isUnix);
    expect(info.supportsWindowsACLs).toBe(isWindows);
    expect(typeof info.platform).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// writeFileSecure
// ---------------------------------------------------------------------------

describe("writeFileSecure", () => {
  it("creates the file with the specified content", () => {
    const filePath = path.join(TMP_DIR, "secret.txt");
    writeFileSecure(filePath, "hello world");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello world");
  });

  it("applies mode 0o600 by default (Unix only)", { skip: isWindows }, () => {
    const filePath = path.join(TMP_DIR, "secret.txt");
    writeFileSecure(filePath, "data");
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("applies an explicit mode (Unix only)", { skip: isWindows }, () => {
    const filePath = path.join(TMP_DIR, "readable.txt");
    writeFileSecure(filePath, "data", 0o644);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("creates intermediate parent directories automatically", () => {
    const filePath = path.join(TMP_DIR, "nested", "deep", "file.txt");
    writeFileSecure(filePath, "nested content");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf-8")).toBe("nested content");
  });

  it("accepts a Buffer as content", () => {
    const filePath = path.join(TMP_DIR, "buf.bin");
    writeFileSecure(filePath, Buffer.from([0x01, 0x02, 0x03]));
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });

  it("overwrites an existing file", () => {
    const filePath = path.join(TMP_DIR, "overwrite.txt");
    writeFileSecure(filePath, "first");
    writeFileSecure(filePath, "second");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// appendFileSecure
// ---------------------------------------------------------------------------

describe("appendFileSecure", () => {
  it("creates the file if it does not exist", () => {
    const filePath = path.join(TMP_DIR, "new.txt");
    appendFileSecure(filePath, "first line");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("first line");
  });

  it("appends to an existing file", () => {
    const filePath = path.join(TMP_DIR, "log.txt");
    writeFileSecure(filePath, "line1\n");
    appendFileSecure(filePath, "line2\n");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("line1\nline2\n");
  });

  it("applies mode 0o600 when creating a new file (Unix only)", { skip: isWindows }, () => {
    const filePath = path.join(TMP_DIR, "appended.txt");
    appendFileSecure(filePath, "data", 0o600);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves content across multiple appends", () => {
    const filePath = path.join(TMP_DIR, "multi.txt");
    appendFileSecure(filePath, "a");
    appendFileSecure(filePath, "b");
    appendFileSecure(filePath, "c");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("abc");
  });
});

// ---------------------------------------------------------------------------
// mkdirSecure
// ---------------------------------------------------------------------------

describe("mkdirSecure", () => {
  it("creates the directory", () => {
    const dir = path.join(TMP_DIR, "secure-dir");
    mkdirSecure(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it("creates the directory with mode 0o700 by default (Unix only)", { skip: isWindows }, () => {
    const dir = path.join(TMP_DIR, "secure-dir");
    mkdirSecure(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("accepts an explicit mode (Unix only)", { skip: isWindows }, () => {
    const dir = path.join(TMP_DIR, "readable-dir");
    mkdirSecure(dir, 0o755);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("is idempotent — does not throw if directory already exists", () => {
    const dir = path.join(TMP_DIR, "existing-dir");
    mkdirSecure(dir);
    expect(() => mkdirSecure(dir)).not.toThrow();
  });

  it("creates nested directories recursively", () => {
    const dir = path.join(TMP_DIR, "a", "b", "c");
    mkdirSecure(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setSecureFilePermissions
// ---------------------------------------------------------------------------

describe("setSecureFilePermissions", () => {
  it("returns true on success", () => {
    const filePath = path.join(TMP_DIR, "target.txt");
    fs.writeFileSync(filePath, "data");
    const result = setSecureFilePermissions(filePath);
    expect(result).toBe(true);
  });

  it("sets mode 0o600 by default (Unix only)", { skip: isWindows }, () => {
    const filePath = path.join(TMP_DIR, "target.txt");
    fs.writeFileSync(filePath, "data");
    setSecureFilePermissions(filePath);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("sets an explicit mode (Unix only)", { skip: isWindows }, () => {
    const filePath = path.join(TMP_DIR, "target.txt");
    fs.writeFileSync(filePath, "data");
    setSecureFilePermissions(filePath, 0o644);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("returns false when the path does not exist", () => {
    const filePath = path.join(TMP_DIR, "nonexistent.txt");
    const result = setSecureFilePermissions(filePath);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setSecureDirectoryPermissions
// ---------------------------------------------------------------------------

describe("setSecureDirectoryPermissions", () => {
  it("returns true on success", () => {
    const dir = path.join(TMP_DIR, "mydir");
    fs.mkdirSync(dir);
    const result = setSecureDirectoryPermissions(dir);
    expect(result).toBe(true);
  });

  it("sets mode 0o700 by default (Unix only)", { skip: isWindows }, () => {
    const dir = path.join(TMP_DIR, "mydir");
    fs.mkdirSync(dir, { mode: 0o755 });
    setSecureDirectoryPermissions(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("sets an explicit mode (Unix only)", { skip: isWindows }, () => {
    const dir = path.join(TMP_DIR, "mydir");
    fs.mkdirSync(dir, { mode: 0o700 });
    setSecureDirectoryPermissions(dir, 0o755);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it("returns false when the path does not exist", () => {
    const dir = path.join(TMP_DIR, "nonexistent");
    const result = setSecureDirectoryPermissions(dir);
    expect(result).toBe(false);
  });
});
