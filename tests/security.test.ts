/**
 * Unit Tests for Security Utilities (Phase 5A)
 *
 * Tests input validation, URL whitelisting, and rate limiting.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  validateNotebookUrl,
  validateNotebookId,
  validateQuestion,
  RateLimiter,
  SecurityError,
  sanitizeForLogging,
  maskEmail,
} from "../src/utils/security.js";

describe("Security Utilities", () => {
  describe("validateNotebookUrl", () => {
    it("should accept valid NotebookLM URLs", () => {
      const url = "https://notebooklm.google.com/notebook/abc123";
      expect(validateNotebookUrl(url)).toBe(url);
    });

    it("should accept regional NotebookLM domains", () => {
      const url = "https://notebooklm.google.de/notebook/abc123";
      expect(validateNotebookUrl(url)).toBe(url);
    });

    it("should normalize the URL", () => {
      const url = "https://notebooklm.google.com/notebook/abc123?q=1";
      const result = validateNotebookUrl(url);
      expect(result).toContain("notebooklm.google.com");
    });

    it("should reject non-HTTPS URLs", () => {
      expect(() => validateNotebookUrl("http://notebooklm.google.com/notebook/abc123"))
        .toThrow(SecurityError);
    });

    it("should reject invalid domains", () => {
      expect(() => validateNotebookUrl("https://evil.com/notebook/abc123"))
        .toThrow("Domain not allowed");
    });

    it("should reject javascript: URLs", () => {
      expect(() => validateNotebookUrl("javascript:alert(1)"))
        .toThrow("Dangerous protocol");
    });

    it("should reject data: URLs", () => {
      expect(() => validateNotebookUrl("data:text/html,<script>alert(1)</script>"))
        .toThrow("Dangerous protocol");
    });

    it("should reject file: URLs", () => {
      expect(() => validateNotebookUrl("file:///etc/passwd"))
        .toThrow("Dangerous protocol");
    });

    it("should normalize URLs with path traversal (URL constructor resolves them)", () => {
      // The URL constructor resolves ../ automatically, so this becomes a valid path
      const result = validateNotebookUrl("https://notebooklm.google.com/a/../notebook/abc");
      expect(result).toContain("notebooklm.google.com");
      expect(result).not.toContain("..");
    });

    it("should reject empty URLs", () => {
      expect(() => validateNotebookUrl("")).toThrow(SecurityError);
    });

    it("should reject non-string input", () => {
      expect(() => validateNotebookUrl(null as any)).toThrow(SecurityError);
      expect(() => validateNotebookUrl(undefined as any)).toThrow(SecurityError);
    });

    it("should reject malformed URLs", () => {
      expect(() => validateNotebookUrl("not-a-url")).toThrow("Invalid URL format");
    });

    it("I301 accepts and normalizes generated allowed NotebookLM URLs", () => {
      const domains = [
        "notebooklm.google.com",
        "notebooklm.google.co.uk",
        "notebooklm.google.de",
        "notebooklm.google.fr",
      ];

      for (let i = 0; i < 40; i++) {
        const domain = domains[i % domains.length];
        const notebookId = `case-${i.toString(36)}_${"a".repeat((i % 5) + 1)}`;
        const input = `  https://${domain}/notebook/${notebookId}?q=${i}#section  `;
        const normalized = validateNotebookUrl(input);

        expect(normalized.startsWith(`https://${domain}/notebook/${notebookId}`)).toBe(true);
        expect(normalized).not.toContain("  ");
      }
    });
  });

  describe("validateQuestion", () => {
    it("should accept valid questions", () => {
      expect(validateQuestion("What is the meaning of life?")).toBe("What is the meaning of life?");
    });

    it("should trim whitespace", () => {
      expect(validateQuestion("  hello world  ")).toBe("hello world");
    });

    it("should reject empty questions", () => {
      expect(() => validateQuestion("")).toThrow(SecurityError);
    });

    it("should reject whitespace-only questions", () => {
      expect(() => validateQuestion("   ")).toThrow("Question cannot be empty");
    });

    it("should reject null/undefined", () => {
      expect(() => validateQuestion(null as any)).toThrow(SecurityError);
      expect(() => validateQuestion(undefined as any)).toThrow(SecurityError);
    });

    it("should reject extremely long questions (>32000 chars)", () => {
      const longQuestion = "a".repeat(32001);
      expect(() => validateQuestion(longQuestion)).toThrow("Question too long");
    });

    it("should accept questions at the max length boundary", () => {
      const maxQuestion = "a".repeat(32000);
      expect(validateQuestion(maxQuestion)).toBe(maxQuestion);
    });
  });

  describe("validateNotebookId (I329)", () => {
    it("accepts alphanumeric IDs", () => {
      expect(validateNotebookId("abc123")).toBe("abc123");
    });

    it("accepts IDs with dashes and underscores", () => {
      expect(validateNotebookId("abc-123_XYZ")).toBe("abc-123_XYZ");
    });

    it("trims surrounding whitespace", () => {
      expect(validateNotebookId("  abc123  ")).toBe("abc123");
    });

    it("rejects IDs containing slashes (path traversal)", () => {
      expect(() => validateNotebookId("abc/123")).toThrow(SecurityError);
    });

    it("rejects IDs containing dots", () => {
      expect(() => validateNotebookId("abc.123")).toThrow(SecurityError);
    });

    it("rejects IDs over 128 characters", () => {
      expect(() => validateNotebookId("a".repeat(129))).toThrow(SecurityError);
    });

    it("rejects empty string", () => {
      expect(() => validateNotebookId("")).toThrow(SecurityError);
    });

    it("rejects whitespace-only string", () => {
      expect(() => validateNotebookId("   ")).toThrow(SecurityError);
    });
  });

  describe("sanitizeForLogging", () => {
    it("should redact URL credentials", () => {
      const result = sanitizeForLogging("connecting to https://user:pass@host.com/path");
      expect(result).not.toContain("pass");
    });

    it("should mask the local part of an email address", () => {
      expect(maskEmail("alice@example.com")).toBe("a****@e***.com");
    });

    it("I301 keeps sanitizeForLogging idempotent across varied inputs", () => {
      const samples = Array.from({ length: 50 }, (_, i) =>
        [
          `user${i}@example.com`,
          `password=secret-${i}`,
          `token: token-${i}`,
          `https://alice${i}:pw${i}@example.com/path/${i}`,
          `plain-text-${i}`,
        ].join(" | ")
      );

      for (const sample of samples) {
        const once = sanitizeForLogging(sample);
        const twice = sanitizeForLogging(once);
        expect(twice).toBe(once);
        expect(once).not.toContain(`secret-`);
        expect(once).not.toContain(`pw`);
      }
    });
  });

  describe("RateLimiter", () => {
    let limiter: RateLimiter;

    beforeEach(() => {
      limiter = new RateLimiter(3, 1000); // 3 requests per 1 second
    });

    it("should allow requests under the limit", () => {
      expect(limiter.isAllowed("test")).toBe(true);
      expect(limiter.isAllowed("test")).toBe(true);
      expect(limiter.isAllowed("test")).toBe(true);
    });

    it("should reject requests at the limit", () => {
      limiter.isAllowed("test");
      limiter.isAllowed("test");
      limiter.isAllowed("test");
      expect(limiter.isAllowed("test")).toBe(false);
    });

    it("should track different keys independently", () => {
      limiter.isAllowed("key1");
      limiter.isAllowed("key1");
      limiter.isAllowed("key1");
      // key1 is at limit, but key2 should still work
      expect(limiter.isAllowed("key1")).toBe(false);
      expect(limiter.isAllowed("key2")).toBe(true);
    });

    it("should report remaining requests correctly", () => {
      expect(limiter.getRemaining("test")).toBe(3);
      limiter.isAllowed("test");
      expect(limiter.getRemaining("test")).toBe(2);
      limiter.isAllowed("test");
      expect(limiter.getRemaining("test")).toBe(1);
      limiter.isAllowed("test");
      expect(limiter.getRemaining("test")).toBe(0);
    });

    it("should allow requests after the window expires", async () => {
      limiter.isAllowed("test");
      limiter.isAllowed("test");
      limiter.isAllowed("test");
      expect(limiter.isAllowed("test")).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(limiter.isAllowed("test")).toBe(true);
    });

    it("should clear all data", () => {
      limiter.isAllowed("test");
      limiter.isAllowed("test");
      limiter.clear();
      expect(limiter.getRemaining("test")).toBe(3);
    });

    it("Map size stays bounded under 10 001 distinct keys (I303)", () => {
      const bigLimiter = new RateLimiter(100, 60000);
      for (let i = 0; i < 10_001; i++) {
        bigLimiter.isAllowed(`key-${i}`);
      }
      // Internal map must not exceed 10 000 entries
      expect(bigLimiter.size()).toBeLessThanOrEqual(10_000);
    });
  });
});
