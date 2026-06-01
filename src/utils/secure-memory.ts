/**
 * Secure Memory Utilities for NotebookLM MCP Server
 *
 * Provides best-effort handling of sensitive data in memory:
 * - Zero-fill backing Buffers after use
 * - Secure string class that wipes its backing Buffer
 * - Time-bounded credential handling
 *
 * Why this matters — and its limits:
 * - REDUCES the exposure window for credentials in memory; it does not
 *   eliminate it.
 * - This is mitigation, NOT prevention, of memory-dump or cold-boot attacks.
 *   We cannot guarantee secrets are gone from RAM after wipe().
 * - V8 caveat: JavaScript strings are immutable. The input string passed in,
 *   and every value produced by toString() / getValue(), are independent V8
 *   string copies on the heap that this code CANNOT wipe and that persist
 *   until garbage collection (and possibly beyond, in freed-but-unzeroed
 *   memory). Only the internal Buffer is zeroed by wipe().
 *
 * Added by Pantheon Security for hardened fork.
 */

import crypto from "crypto";

/**
 * Securely zero-fill a Buffer
 * Uses crypto.randomFill first to prevent compiler optimization removal
 */
export function zeroBuffer(buffer: Buffer): void {
  if (!buffer || buffer.length === 0) return;

  // First overwrite with random data (prevents optimization removal)
  crypto.randomFillSync(buffer);
  // Then zero fill
  buffer.fill(0);
}

/**
 * Securely zero-fill a Uint8Array
 */
export function zeroUint8Array(arr: Uint8Array): void {
  if (!arr || arr.length === 0) return;

  // Overwrite with random then zero
  crypto.randomFillSync(arr);
  arr.fill(0);
}

/**
 * Create a secure string that can be wiped
 * Note: JavaScript strings are immutable, so we use a Buffer internally
 * Caveat: source string contents may remain in V8 heap until garbage collection.
 */
export class SecureString {
  private buffer: Buffer;
  private wiped: boolean = false;

  constructor(value: string) {
    this.buffer = Buffer.from(value, "utf-8");
  }

  /**
   * Get the string value.
   * Note: returns a new immutable V8 string copy that cannot be wiped and
   * persists until garbage collection. Avoid retaining the result longer
   * than necessary.
   */
  toString(): string {
    if (this.wiped) {
      throw new Error("SecureString has been wiped");
    }
    return this.buffer.toString("utf-8");
  }

  /**
   * Get the underlying buffer (for crypto operations)
   */
  toBuffer(): Buffer {
    if (this.wiped) {
      throw new Error("SecureString has been wiped");
    }
    return this.buffer;
  }

  /**
   * Get length without exposing content
   */
  get length(): number {
    return this.wiped ? 0 : this.buffer.length;
  }

  /**
   * Wipe the backing Buffer (best effort).
   * Only zeroes the internal Buffer; any string copies previously returned
   * by toString() / the constructor input remain in the V8 heap until GC.
   */
  wipe(): void {
    if (!this.wiped) {
      zeroBuffer(this.buffer);
      this.wiped = true;
    }
  }

  /**
   * Check if already wiped
   */
  isWiped(): boolean {
    return this.wiped;
  }
}

/**
 * Secure credential holder with automatic wiping
 */
export class SecureCredential {
  private value: SecureString;
  private createdAt: number;
  private maxAgeMs: number;
  private autoWipeTimer?: NodeJS.Timeout;

  constructor(credential: string, maxAgeMs: number = 300000) { // 5 min default
    this.value = new SecureString(credential);
    this.createdAt = Date.now();
    this.maxAgeMs = maxAgeMs;

    // Auto-wipe after max age (unref so timer doesn't prevent process exit)
    this.autoWipeTimer = setTimeout(() => {
      this.wipe();
    }, maxAgeMs);
    this.autoWipeTimer.unref();
  }

  /**
   * Get the credential value.
   * Note: returns an immutable V8 string copy that cannot be wiped and
   * persists until garbage collection.
   */
  getValue(): string {
    if (this.isExpired()) {
      this.wipe();
      throw new Error("Credential has expired");
    }
    return this.value.toString();
  }

  /**
   * Check if credential has expired
   */
  isExpired(): boolean {
    return Date.now() - this.createdAt > this.maxAgeMs;
  }

  /**
   * Get time remaining before auto-wipe (ms)
   */
  getTimeRemaining(): number {
    const remaining = this.maxAgeMs - (Date.now() - this.createdAt);
    return Math.max(0, remaining);
  }

  /**
   * Securely wipe the credential
   */
  wipe(): void {
    if (this.autoWipeTimer) {
      clearTimeout(this.autoWipeTimer);
      this.autoWipeTimer = undefined;
    }
    this.value.wipe();
  }

  /**
   * Check if already wiped
   */
  isWiped(): boolean {
    return this.value.isWiped();
  }
}

/**
 * Execute a function with a secure credential, auto-wiping after use
 */
export async function withSecureCredential<T>(
  credential: string,
  fn: (cred: SecureCredential) => Promise<T>
): Promise<T> {
  const secureCred = new SecureCredential(credential);
  try {
    return await fn(secureCred);
  } finally {
    secureCred.wipe();
  }
}

/**
 * Secure comparison to prevent timing attacks.
 *
 * Both operands are hashed (SHA-256) into a fixed-length digest before the
 * constant-time comparison. This:
 *  - makes timingSafeEqual always run on the same number of bytes regardless of
 *    input length, leaking nothing about the actual lengths, and
 *  - compares the FULL content of each operand (L5): the previous version
 *    truncated both inputs to 64 bytes, so two distinct values sharing their
 *    first 64 bytes would compare equal. Hashing covers the entire input.
 *
 * The trailing length check is kept as defence-in-depth; SHA-256 already
 * distinguishes different-length inputs.
 */
export function secureCompare(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = typeof a === "string" ? Buffer.from(a) : a;
  const bufB = typeof b === "string" ? Buffer.from(b) : b;

  // Hash the full content of each operand to a fixed 32-byte digest, so
  // timingSafeEqual always sees equal-length buffers and no input is truncated.
  const digestA = crypto.createHash("sha256").update(bufA).digest();
  const digestB = crypto.createHash("sha256").update(bufB).digest();

  // timingSafeEqual runs first (constant time), length check evaluated after.
  const contentEqual = crypto.timingSafeEqual(digestA, digestB);
  return contentEqual && bufA.length === bufB.length;
}

/**
 * Generate a secure random string
 */
export function secureRandomString(length: number, encoding: BufferEncoding = "base64url"): string {
  const bytes = Math.ceil(length * 0.75); // base64 expands ~33%
  return crypto.randomBytes(bytes).toString(encoding).slice(0, length);
}

/**
 * Mask sensitive data for logging (doesn't expose real length)
 */
export function maskSensitive(value: string, showChars: number = 4): string {
  if (!value || value.length <= showChars) {
    return "****";
  }
  return value.slice(0, showChars) + "****";
}
