/**
 * Unit Tests for Secure Memory Utilities
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  zeroBuffer,
  zeroUint8Array,
  SecureString,
  SecureCredential,
  SecureObject,
  withSecureCredential,
  withSecureBuffer,
  createSecureBuffer,
  secureCompare,
  secureRandomString,
  maskSensitive,
} from "../src/utils/secure-memory.js";

describe("Secure Memory Utilities", () => {
  describe("zeroBuffer", () => {
    it("should zero-fill a buffer", () => {
      const buffer = Buffer.from("sensitive data");
      zeroBuffer(buffer);

      // All bytes should be zero
      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBe(0);
      }
    });

    it("should handle empty buffer", () => {
      const buffer = Buffer.alloc(0);
      expect(() => zeroBuffer(buffer)).not.toThrow();
    });

    it("should handle null/undefined gracefully", () => {
      expect(() => zeroBuffer(null as unknown as Buffer)).not.toThrow();
      expect(() => zeroBuffer(undefined as unknown as Buffer)).not.toThrow();
    });
  });

  describe("zeroUint8Array", () => {
    it("should zero-fill a Uint8Array", () => {
      const arr = new Uint8Array([1, 2, 3, 4, 5]);
      zeroUint8Array(arr);

      for (let i = 0; i < arr.length; i++) {
        expect(arr[i]).toBe(0);
      }
    });

    it("should handle empty array", () => {
      const arr = new Uint8Array(0);
      expect(() => zeroUint8Array(arr)).not.toThrow();
    });
  });

  describe("SecureString", () => {
    it("should store and retrieve string value", () => {
      const secret = new SecureString("my-secret-password");
      expect(secret.toString()).toBe("my-secret-password");
    });

    it("should return correct length", () => {
      const secret = new SecureString("test123");
      expect(secret.length).toBe(7);
    });

    it("should return buffer representation", () => {
      const secret = new SecureString("test");
      const buffer = secret.toBuffer();
      expect(buffer.toString("utf-8")).toBe("test");
    });

    it("should wipe data securely", () => {
      const secret = new SecureString("sensitive");
      secret.wipe();

      expect(secret.isWiped()).toBe(true);
      expect(secret.length).toBe(0);
    });

    it("should throw when accessing wiped string", () => {
      const secret = new SecureString("sensitive");
      secret.wipe();

      expect(() => secret.toString()).toThrow("SecureString has been wiped");
      expect(() => secret.toBuffer()).toThrow("SecureString has been wiped");
    });

    it("should handle multiple wipe calls", () => {
      const secret = new SecureString("test");
      secret.wipe();
      expect(() => secret.wipe()).not.toThrow();
    });
  });

  describe("SecureCredential", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should store and retrieve credential", () => {
      const cred = new SecureCredential("api-key-12345");
      expect(cred.getValue()).toBe("api-key-12345");
      cred.wipe();
    });

    it("should report time remaining", () => {
      const cred = new SecureCredential("test", 10000);
      expect(cred.getTimeRemaining()).toBe(10000);

      vi.advanceTimersByTime(3000);
      expect(cred.getTimeRemaining()).toBe(7000);

      cred.wipe();
    });

    it("should auto-wipe after max age", () => {
      const cred = new SecureCredential("test", 5000);
      expect(cred.isWiped()).toBe(false);

      vi.advanceTimersByTime(5001);
      expect(cred.isWiped()).toBe(true);
    });

    it("should throw when expired", () => {
      const cred = new SecureCredential("test", 1000);
      vi.advanceTimersByTime(1001);

      expect(() => cred.getValue()).toThrow("Credential has expired");
    });

    it("should report expired status", () => {
      const cred = new SecureCredential("test", 1000);
      expect(cred.isExpired()).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(cred.isExpired()).toBe(true);
    });

    it("should clear timer on manual wipe", () => {
      const cred = new SecureCredential("test", 10000);
      cred.wipe();
      expect(cred.isWiped()).toBe(true);
    });
  });

  describe("SecureObject", () => {
    it("should store and retrieve properties", () => {
      const obj = new SecureObject({
        username: "admin",
        password: "secret123",
      });

      expect(obj.get("username")).toBe("admin");
      expect(obj.get("password")).toBe("secret123");
      obj.dispose();
    });

    it("should return all data", () => {
      const data = { key: "value", num: 42 };
      const obj = new SecureObject(data);

      expect(obj.getData()).toEqual(data);
      obj.dispose();
    });

    it("should dispose and wipe string values", () => {
      const obj = new SecureObject({
        secret: "password",
      });

      obj.dispose();
      expect(obj.isDisposed()).toBe(true);
    });

    it("should dispose and wipe buffer values", () => {
      const buffer = Buffer.from("sensitive");
      const obj = new SecureObject({ buffer });

      obj.dispose();

      // Buffer should be zeroed
      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBe(0);
      }
    });

    it("should throw when accessing disposed object", () => {
      const obj = new SecureObject({ key: "value" });
      obj.dispose();

      expect(() => obj.get("key")).toThrow("SecureObject has been disposed");
      expect(() => obj.getData()).toThrow("SecureObject has been disposed");
    });

    it("should handle multiple dispose calls", () => {
      const obj = new SecureObject({ key: "value" });
      obj.dispose();
      expect(() => obj.dispose()).not.toThrow();
    });
  });

  describe("withSecureCredential", () => {
    it("should execute function with credential and auto-wipe", async () => {
      let capturedValue: string | undefined;

      await withSecureCredential("my-secret", async (cred) => {
        capturedValue = cred.getValue();
        return "done";
      });

      expect(capturedValue).toBe("my-secret");
    });

    it("should wipe credential even on error", async () => {
      let credential: SecureCredential | undefined;

      await expect(
        withSecureCredential("test", async (cred) => {
          credential = cred;
          throw new Error("test error");
        })
      ).rejects.toThrow("test error");

      expect(credential?.isWiped()).toBe(true);
    });

    it("should return function result", async () => {
      const result = await withSecureCredential("test", async () => {
        return { success: true };
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe("withSecureBuffer", () => {
    it("should execute function with buffer and auto-wipe", async () => {
      const buffer = Buffer.from("sensitive data");

      await withSecureBuffer(buffer, async (buf) => {
        expect(buf.toString()).toBe("sensitive data");
      });

      // Buffer should be zeroed after
      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBe(0);
      }
    });

    it("should wipe buffer even on error", async () => {
      const buffer = Buffer.from("test");

      await expect(
        withSecureBuffer(buffer, async () => {
          throw new Error("test error");
        })
      ).rejects.toThrow("test error");

      for (let i = 0; i < buffer.length; i++) {
        expect(buffer[i]).toBe(0);
      }
    });
  });

  describe("createSecureBuffer", () => {
    it("should create buffer of specified size", () => {
      // Note: createSecureBuffer registers with FinalizationRegistry for auto-cleanup
      // We can't easily test the GC behavior, so we just test creation
      const buffer = createSecureBuffer(32);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBe(32);
    });

    it("should create buffer from string", () => {
      const buffer = createSecureBuffer("hello");
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe("hello");
    });

    it("should create buffer with encoding", () => {
      const buffer = createSecureBuffer("68656c6c6f", "hex");
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString()).toBe("hello");
    });
  });

  describe("secureCompare", () => {
    it("should return true for equal strings", () => {
      expect(secureCompare("password123", "password123")).toBe(true);
    });

    it("should return false for different strings", () => {
      expect(secureCompare("password123", "password456")).toBe(false);
    });

    it("should return false for different lengths", () => {
      expect(secureCompare("short", "much longer string")).toBe(false);
    });

    it("should work with buffers", () => {
      const a = Buffer.from("test");
      const b = Buffer.from("test");
      const c = Buffer.from("diff");

      expect(secureCompare(a, b)).toBe(true);
      expect(secureCompare(a, c)).toBe(false);
    });

    it("should handle empty strings", () => {
      expect(secureCompare("", "")).toBe(true);
      expect(secureCompare("", "a")).toBe(false);
    });
  });

  describe("secureRandomString", () => {
    it("should generate string of requested length", () => {
      const str = secureRandomString(32);
      expect(str.length).toBe(32);
    });

    it("should generate unique strings", () => {
      const str1 = secureRandomString(32);
      const str2 = secureRandomString(32);
      expect(str1).not.toBe(str2);
    });

    it("should use base64url encoding by default", () => {
      const str = secureRandomString(100);
      // base64url uses A-Z, a-z, 0-9, -, _
      expect(/^[A-Za-z0-9_-]+$/.test(str)).toBe(true);
    });

    it("should support hex encoding", () => {
      const str = secureRandomString(32, "hex");
      expect(/^[0-9a-f]+$/.test(str)).toBe(true);
    });
  });

  describe("maskSensitive", () => {
    it("should mask long values showing first 4 chars", () => {
      expect(maskSensitive("secretpassword123")).toBe("secr****");
    });

    it("should fully mask short values", () => {
      expect(maskSensitive("abc")).toBe("****");
      expect(maskSensitive("test")).toBe("****");
    });

    it("should handle empty string", () => {
      expect(maskSensitive("")).toBe("****");
    });

    it("should respect custom showChars parameter", () => {
      expect(maskSensitive("mysecretkey", 6)).toBe("mysecr****");
    });
  });
});
