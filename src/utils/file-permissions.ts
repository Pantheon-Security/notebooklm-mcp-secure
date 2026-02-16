/**
 * Cross-Platform File Permissions Utility
 *
 * Provides secure file permission handling across Linux, macOS, and Windows.
 *
 * On Unix systems (Linux/macOS):
 * - Uses standard chmod-style permissions (0o600, 0o700, etc.)
 *
 * On Windows:
 * - Uses icacls to restrict file access to current user only
 * - Falls back gracefully if icacls fails
 *
 * Added by Pantheon Security for cross-platform support.
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Platform detection
 */
export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";
export const isUnix = !isWindows;

/**
 * Common permission modes (Unix-style)
 */
export const PERMISSION_MODES = {
  /** Owner read/write only (files with sensitive data) */
  OWNER_READ_WRITE: 0o600,
  /** Owner read/write/execute only (directories, executables) */
  OWNER_FULL: 0o700,
  /** Owner read/write, group/others read (less sensitive files) */
  OWNER_WRITE_ALL_READ: 0o644,
  /** Owner full, group/others read+execute (less sensitive directories) */
  OWNER_FULL_ALL_READ_EXECUTE: 0o755,
} as const;

/**
 * Set secure file permissions (owner-only access)
 *
 * @param filePath - Path to the file
 * @param mode - Unix permission mode (default: 0o600)
 * @returns true if permissions were set successfully
 */
export function setSecureFilePermissions(
  filePath: string,
  mode: number = PERMISSION_MODES.OWNER_READ_WRITE
): boolean {
  try {
    if (isWindows) {
      return setWindowsFilePermissions(filePath, true);
    } else {
      fs.chmodSync(filePath, mode);
      return true;
    }
  } catch {
    // Silently fail - permissions are best-effort on some systems
    return false;
  }
}

/**
 * Set secure directory permissions (owner-only access)
 *
 * @param dirPath - Path to the directory
 * @param mode - Unix permission mode (default: 0o700)
 * @returns true if permissions were set successfully
 */
export function setSecureDirectoryPermissions(
  dirPath: string,
  mode: number = PERMISSION_MODES.OWNER_FULL
): boolean {
  try {
    if (isWindows) {
      return setWindowsFilePermissions(dirPath, true);
    } else {
      fs.chmodSync(dirPath, mode);
      return true;
    }
  } catch {
    // Silently fail - permissions are best-effort on some systems
    return false;
  }
}

/**
 * Validate path for safe use in shell commands (defense-in-depth)
 *
 * @param targetPath - Path to validate
 * @returns true if path is safe for shell use
 */
function isPathSafeForShell(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== "string") {
    return false;
  }

  // Block shell metacharacters that could enable command injection
  const dangerousChars = /[;&|`$<>(){}[\]!*?~\n\r]/;
  if (dangerousChars.test(targetPath)) {
    return false;
  }

  // Block path traversal attempts
  if (targetPath.includes("..")) {
    return false;
  }

  // Block UNC paths that could access network resources unexpectedly
  if (targetPath.startsWith("\\\\")) {
    return false;
  }

  // Ensure path is within reasonable length (Windows MAX_PATH is 260)
  if (targetPath.length > 32767) {
    return false;
  }

  return true;
}

/**
 * Validate username for safe use in shell commands
 *
 * @param username - Username to validate
 * @returns true if username is safe
 */
function isUsernameSafe(username: string): boolean {
  if (!username || typeof username !== "string") {
    return false;
  }

  // Usernames should only contain alphanumeric, underscore, hyphen, dot
  // and be reasonably short
  const safeUsername = /^[a-zA-Z0-9_.\-]{1,256}$/;
  return safeUsername.test(username);
}

/**
 * Set Windows file/directory permissions using icacls
 *
 * @param targetPath - Path to the file or directory
 * @param ownerOnly - If true, restrict to current user only
 * @returns true if permissions were set successfully
 */
function setWindowsFilePermissions(targetPath: string, ownerOnly: boolean): boolean {
  if (!isWindows) return false;

  try {
    // Defense-in-depth: Validate path before using in shell command
    if (!isPathSafeForShell(targetPath)) {
      // Log would be nice but we don't have logger imported here
      // Silently fail for invalid paths
      return false;
    }

    const username = process.env.USERNAME || process.env.USER;
    if (!username || !isUsernameSafe(username)) {
      return false;
    }

    // Normalize path to resolve any . or redundant separators
    const normalizedPath = path.normalize(targetPath);

    // Double-check normalized path is still safe
    if (!isPathSafeForShell(normalizedPath)) {
      return false;
    }

    if (ownerOnly) {
      // Remove inherited permissions and grant full control only to current user
      // /inheritance:r - Remove inherited ACLs
      // /grant:r - Replace existing permissions with specified ones
      // (F) - Full control
      execFileSync("icacls", [
        normalizedPath, "/inheritance:r", "/grant:r", `${username}:(F)`, "/q"
      ], { stdio: "pipe" });
    }

    return true;
  } catch {
    // icacls may not be available or may fail - this is not critical
    // The file is still created, just without restricted permissions
    return false;
  }
}

/**
 * Create a directory with secure permissions
 *
 * @param dirPath - Path to create
 * @param mode - Unix permission mode (default: 0o700)
 */
export function mkdirSecure(dirPath: string, mode: number = PERMISSION_MODES.OWNER_FULL): void {
  if (!fs.existsSync(dirPath)) {
    if (isWindows) {
      // On Windows, create directory first then set permissions
      fs.mkdirSync(dirPath, { recursive: true });
      setWindowsFilePermissions(dirPath, true);
    } else {
      fs.mkdirSync(dirPath, { recursive: true, mode });
    }
  }
}

/**
 * Write a file with secure permissions
 *
 * @param filePath - Path to write
 * @param content - Content to write
 * @param mode - Unix permission mode (default: 0o600)
 */
export function writeFileSecure(
  filePath: string,
  content: string | Buffer,
  mode: number = PERMISSION_MODES.OWNER_READ_WRITE
): void {
  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  mkdirSecure(dir);

  if (isWindows) {
    // On Windows, write file first then set permissions
    fs.writeFileSync(filePath, content);
    setWindowsFilePermissions(filePath, true);
  } else {
    fs.writeFileSync(filePath, content, { mode });
  }
}

/**
 * Append to a file with secure permissions
 *
 * @param filePath - Path to append to
 * @param content - Content to append
 * @param mode - Unix permission mode (default: 0o600)
 */
export function appendFileSecure(
  filePath: string,
  content: string | Buffer,
  mode: number = PERMISSION_MODES.OWNER_READ_WRITE
): void {
  if (!fs.existsSync(filePath)) {
    // If file doesn't exist, create with secure permissions
    writeFileSecure(filePath, content, mode);
  } else {
    // File exists, just append (permissions already set)
    fs.appendFileSync(filePath, content);
  }
}

/**
 * Get platform information for logging/debugging
 */
export function getPlatformInfo(): {
  platform: string;
  isWindows: boolean;
  isMacOS: boolean;
  isLinux: boolean;
  supportsUnixPermissions: boolean;
  supportsWindowsACLs: boolean;
} {
  return {
    platform: process.platform,
    isWindows,
    isMacOS,
    isLinux,
    supportsUnixPermissions: isUnix,
    supportsWindowsACLs: isWindows,
  };
}
