/**
 * Secure Memory Utilities for NotebookLM MCP Server
 *
 * Provides secure handling of sensitive data in memory:
 * - Zero-fill buffers and strings after use
 * - Secure string class that auto-wipes
 * - Memory-safe credential handling
 *
 * Why this matters:
 * - Prevents memory dump attacks
 * - Reduces credential exposure window
 * - Mitigates cold boot attacks
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
 */
export class SecureString {
  private buffer: Buffer;
  private wiped: boolean = false;

  constructor(value: string) {
    this.buffer = Buffer.from(value, "utf-8");
  }

  /**
   * Get the string value (creates new string each time)
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
   * Securely wipe the string from memory
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

    // Auto-wipe after max age
    this.autoWipeTimer = setTimeout(() => {
      this.wipe();
    }, maxAgeMs);
  }

  /**
   * Get the credential value
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
 * Secure object that wipes all string/buffer properties on dispose
 */
export class SecureObject<T extends Record<string, unknown>> {
  private data: T;
  private disposed: boolean = false;

  constructor(data: T) {
    this.data = data;
  }

  /**
   * Get a property value
   */
  get<K extends keyof T>(key: K): T[K] {
    if (this.disposed) {
      throw new Error("SecureObject has been disposed");
    }
    return this.data[key];
  }

  /**
   * Get all data (use carefully)
   */
  getData(): T {
    if (this.disposed) {
      throw new Error("SecureObject has been disposed");
    }
    return this.data;
  }

  /**
   * Dispose and wipe all sensitive data
   */
  dispose(): void {
    if (this.disposed) return;

    for (const key of Object.keys(this.data)) {
      const value = this.data[key];

      if (Buffer.isBuffer(value)) {
        zeroBuffer(value);
      } else if (value instanceof Uint8Array) {
        zeroUint8Array(value);
      } else if (value instanceof SecureString) {
        value.wipe();
      } else if (value instanceof SecureCredential) {
        value.wipe();
      } else if (typeof value === "string") {
        // Can't truly wipe JS strings, but we can dereference
        (this.data as Record<string, unknown>)[key] = "";
      }
    }

    this.disposed = true;
  }

  /**
   * Check if disposed
   */
  isDisposed(): boolean {
    return this.disposed;
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
 * Execute a function with a secure buffer, auto-wiping after use
 */
export async function withSecureBuffer<T>(
  data: Buffer,
  fn: (buffer: Buffer) => Promise<T>
): Promise<T> {
  try {
    return await fn(data);
  } finally {
    zeroBuffer(data);
  }
}

/**
 * Create a secure copy of a buffer that will be wiped on GC
 * Uses FinalizationRegistry for automatic cleanup
 */
const bufferRegistry = new FinalizationRegistry((held: { buffer: Buffer }) => {
  zeroBuffer(held.buffer);
});

export function createSecureBuffer(size: number): Buffer;
export function createSecureBuffer(data: string, encoding?: BufferEncoding): Buffer;
export function createSecureBuffer(arg: number | string, encoding?: BufferEncoding): Buffer {
  let buffer: Buffer;

  if (typeof arg === "number") {
    buffer = Buffer.alloc(arg);
  } else {
    buffer = Buffer.from(arg, encoding);
  }

  // Register for auto-cleanup on GC
  // Note: holdings must be different from target
  bufferRegistry.register(buffer, { buffer });

  return buffer;
}

/**
 * Secure comparison to prevent timing attacks
 */
export function secureCompare(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = typeof a === "string" ? Buffer.from(a) : a;
  const bufB = typeof b === "string" ? Buffer.from(b) : b;

  if (bufA.length !== bufB.length) {
    // Still do the comparison to maintain constant time
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
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
