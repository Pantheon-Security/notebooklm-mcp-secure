/**
 * Regression gate: the hand-rolled JSON Schema subset validator (FX-015).
 *
 * The dispatch gate (tests/dispatch-schema-validation.test.ts) proves the
 * validator is WIRED IN. This file proves it is CORRECT, keyword by keyword,
 * over exactly the subset the repo's tool schemas use — inventoried from
 * src/tools/definitions/: type, properties, required, additionalProperties,
 * enum, pattern, minimum, maximum, minLength, maxLength, items, maxItems,
 * default, format.
 *
 * No dependency was added for this (30-day supply-chain age rule), so the
 * semantics have to be pinned down by test rather than by a library's
 * reputation.
 */

import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../src/utils/schema-validator.js";

const ok = (schema: unknown, value: unknown): boolean =>
  validateAgainstSchema(schema, value).ok;

const errorOf = (schema: unknown, value: unknown): string => {
  const result = validateAgainstSchema(schema, value);
  return result.ok ? "" : result.error;
};

describe("FX-015 — validateAgainstSchema", () => {
  describe("type", () => {
    const obj = { type: "object", properties: {} };

    it("accepts a plain object for type: object", () => {
      expect(ok(obj, {})).toBe(true);
    });

    it("rejects an array for type: object", () => {
      expect(ok(obj, [])).toBe(false);
    });

    it("rejects null for type: object", () => {
      expect(ok(obj, null)).toBe(false);
    });

    it("distinguishes integer from number", () => {
      expect(ok({ type: "integer" }, 3)).toBe(true);
      expect(ok({ type: "integer" }, 3.5)).toBe(false);
      expect(ok({ type: "number" }, 3.5)).toBe(true);
    });

    it("rejects NaN and Infinity as numbers", () => {
      expect(ok({ type: "number" }, Number.NaN)).toBe(false);
      expect(ok({ type: "number" }, Number.POSITIVE_INFINITY)).toBe(false);
    });

    it("does not coerce a numeric string to a number", () => {
      expect(ok({ type: "number" }, "50")).toBe(false);
    });

    it("does not coerce a string to a boolean", () => {
      expect(ok({ type: "boolean" }, "true")).toBe(false);
    });
  });

  describe("required", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };

    it("rejects an absent required property", () => {
      expect(ok(schema, {})).toBe(false);
      expect(errorOf(schema, {})).toMatch(/query/);
    });

    it("rejects an explicit undefined for a required property", () => {
      expect(ok(schema, { query: undefined })).toBe(false);
    });

    it("accepts a present required property", () => {
      expect(ok(schema, { query: "x" })).toBe(true);
    });
  });

  describe("additionalProperties", () => {
    const strict = {
      type: "object",
      additionalProperties: false,
      properties: { query: { type: "string" } },
    };

    it("rejects an unknown property and names it", () => {
      expect(ok(strict, { query: "x", surprise: 1 })).toBe(false);
      expect(errorOf(strict, { query: "x", surprise: 1 })).toMatch(/surprise/);
    });

    it("permits unknown properties when not set to false", () => {
      const loose = { type: "object", properties: { query: { type: "string" } } };
      expect(ok(loose, { query: "x", surprise: 1 })).toBe(true);
    });
  });

  describe("enum", () => {
    const schema = {
      type: "object",
      properties: { tier: { type: "string", enum: ["free", "pro", "ultra"] } },
    };

    it("accepts a declared member", () => {
      expect(ok(schema, { tier: "pro" })).toBe(true);
    });

    it("rejects a non-member", () => {
      expect(ok(schema, { tier: "superuser" })).toBe(false);
      expect(errorOf(schema, { tier: "superuser" })).toMatch(/tier/);
    });

    it("compares strictly, not by coercion", () => {
      expect(ok({ enum: [1, 2] }, "1")).toBe(false);
    });
  });

  describe("pattern", () => {
    const schema = {
      type: "object",
      properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
    };

    it("accepts a matching string", () => {
      expect(ok(schema, { date: "2026-08-05" })).toBe(true);
    });

    it("rejects a non-matching string", () => {
      expect(ok(schema, { date: "last-tuesday" })).toBe(false);
    });

    it("honours the anchors rather than testing a substring", () => {
      expect(ok(schema, { date: "prefix-2026-08-05-suffix" })).toBe(false);
    });
  });

  describe("numeric bounds", () => {
    const schema = {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 500 } },
    };

    it("accepts values on the boundaries (inclusive)", () => {
      expect(ok(schema, { limit: 1 })).toBe(true);
      expect(ok(schema, { limit: 500 })).toBe(true);
    });

    it("rejects below minimum and above maximum", () => {
      expect(ok(schema, { limit: 0 })).toBe(false);
      expect(ok(schema, { limit: 501 })).toBe(false);
    });
  });

  describe("string length", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 5 } },
    };

    it("accepts lengths on the boundaries (inclusive)", () => {
      expect(ok(schema, { query: "a" })).toBe(true);
      expect(ok(schema, { query: "abcde" })).toBe(true);
    });

    it("rejects an empty string under minLength: 1", () => {
      expect(ok(schema, { query: "" })).toBe(false);
    });

    it("rejects a string past maxLength", () => {
      expect(ok(schema, { query: "abcdef" })).toBe(false);
    });
  });

  describe("arrays", () => {
    const schema = {
      type: "object",
      properties: {
        urls: { type: "array", maxItems: 2, items: { type: "string", maxLength: 4 } },
      },
    };

    it("accepts a conforming array", () => {
      expect(ok(schema, { urls: ["ab", "cd"] })).toBe(true);
    });

    it("rejects too many items", () => {
      expect(ok(schema, { urls: ["a", "b", "c"] })).toBe(false);
    });

    it("validates every element against items, not just the first", () => {
      expect(ok(schema, { urls: ["ab", "toolong"] })).toBe(false);
    });

    it("names the offending index", () => {
      expect(errorOf(schema, { urls: ["ab", "toolong"] })).toMatch(/urls\[1\]/);
    });
  });

  describe("nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        options: {
          type: "object",
          additionalProperties: false,
          properties: { timeout: { type: "number", minimum: 10, maximum: 600 } },
        },
      },
    };

    it("validates into the nested object", () => {
      expect(ok(schema, { options: { timeout: 30 } })).toBe(true);
      expect(ok(schema, { options: { timeout: 9 } })).toBe(false);
      expect(ok(schema, { options: { nope: 1 } })).toBe(false);
    });

    it("qualifies the error with the nested path", () => {
      expect(errorOf(schema, { options: { timeout: 9 } })).toMatch(/options\.timeout/);
    });
  });

  describe("non-enforcing keywords", () => {
    it("does not apply defaults or otherwise mutate the input", () => {
      const schema = {
        type: "object",
        properties: { preserve_library: { type: "boolean", default: false } },
      };
      const input: Record<string, unknown> = {};
      expect(ok(schema, input)).toBe(true);
      expect(Object.keys(input)).toHaveLength(0);
    });

    it("ignores format rather than guessing at it", () => {
      expect(ok({ type: "string", format: "uri" }, "not a uri")).toBe(true);
    });
  });

  describe("degenerate schemas", () => {
    it("accepts anything when the schema is absent or not an object", () => {
      expect(ok(undefined, { anything: true })).toBe(true);
      expect(ok(null, { anything: true })).toBe(true);
      expect(ok("nonsense", { anything: true })).toBe(true);
    });

    it("does not leak the offending value into the error message", () => {
      const schema = {
        type: "object",
        properties: { query: { type: "string", maxLength: 3 } },
      };
      expect(errorOf(schema, { query: "s3cr3t-user-data" })).not.toMatch(/s3cr3t/);
    });
  });
});
