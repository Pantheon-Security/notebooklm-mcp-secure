/**
 * Unit Tests for Config Parsing (Phase 5B)
 *
 * Tests parseBoolean, parseInteger, parseArray, range clamping,
 * and applyBrowserOptions merging.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseBoolean,
  parseInteger,
  parseArray,
  applyBrowserOptions,
  CONFIG,
} from "../src/config.js";
import { log } from "../src/utils/logger.js";

describe("Config Parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseBoolean", () => {
    it("should return true for 'true'", () => {
      expect(parseBoolean("true", false)).toBe(true);
    });

    it("should return true for '1'", () => {
      expect(parseBoolean("1", false)).toBe(true);
    });

    it("should return false for 'false'", () => {
      expect(parseBoolean("false", true)).toBe(false);
    });

    it("should return false for '0'", () => {
      expect(parseBoolean("0", true)).toBe(false);
    });

    it("should return default for undefined", () => {
      expect(parseBoolean(undefined, true)).toBe(true);
      expect(parseBoolean(undefined, false)).toBe(false);
    });

    it("should return default for unrecognized values", () => {
      expect(parseBoolean("yes", false)).toBe(false);
      expect(parseBoolean("no", true)).toBe(true);
      expect(parseBoolean("", false)).toBe(false);
    });

    it("should be case insensitive", () => {
      expect(parseBoolean("TRUE", false)).toBe(true);
      expect(parseBoolean("False", true)).toBe(false);
    });
  });

  describe("parseInteger", () => {
    it("should parse valid integers", () => {
      expect(parseInteger("42", 0)).toBe(42);
      expect(parseInteger("0", 10)).toBe(0);
      expect(parseInteger("-5", 0)).toBe(-5);
    });

    it("should return default for undefined", () => {
      expect(parseInteger(undefined, 99)).toBe(99);
    });

    it("should return default for non-numeric strings", () => {
      expect(parseInteger("abc", 99)).toBe(99);
      expect(parseInteger("", 99)).toBe(99);
    });

    it("should truncate floats to integers", () => {
      expect(parseInteger("3.14", 0)).toBe(3);
      expect(parseInteger("9.99", 0)).toBe(9);
    });

    it("should handle scientific notation via Number parsing", () => {
      expect(parseInteger("1e9", 0)).toBe(1000000000);
    });
  });

  describe("parseArray", () => {
    it("should parse comma-separated values", () => {
      expect(parseArray("a,b,c", [])).toEqual(["a", "b", "c"]);
    });

    it("should trim whitespace around values", () => {
      expect(parseArray(" a , b , c ", [])).toEqual(["a", "b", "c"]);
    });

    it("should filter empty strings", () => {
      expect(parseArray("a,,b,", [])).toEqual(["a", "b"]);
    });

    it("should return default for undefined", () => {
      expect(parseArray(undefined, ["default"])).toEqual(["default"]);
    });

    it("should return default for empty string", () => {
      expect(parseArray("", ["default"])).toEqual(["default"]);
    });

    it("should handle single values", () => {
      expect(parseArray("single", [])).toEqual(["single"]);
    });

    it("should parse semicolon-separated values", () => {
      expect(parseArray("a;b;c", [])).toEqual(["a", "b", "c"]);
    });
  });

  describe("Range Clamping (via CONFIG)", () => {
    it("should have maxSessions between 1 and 50", () => {
      expect(CONFIG.maxSessions).toBeGreaterThanOrEqual(1);
      expect(CONFIG.maxSessions).toBeLessThanOrEqual(50);
    });

    it("should have sessionTimeout between 60 and 86400", () => {
      expect(CONFIG.sessionTimeout).toBeGreaterThanOrEqual(60);
      expect(CONFIG.sessionTimeout).toBeLessThanOrEqual(86400);
    });

    it("should have browserTimeout between 5000 and 300000", () => {
      expect(CONFIG.browserTimeout).toBeGreaterThanOrEqual(5000);
      expect(CONFIG.browserTimeout).toBeLessThanOrEqual(300000);
    });
  });

  describe("applyBrowserOptions", () => {
    it("should return CONFIG copy when no options provided", () => {
      const result = applyBrowserOptions();
      expect(result.headless).toBe(CONFIG.headless);
      expect(result.browserTimeout).toBe(CONFIG.browserTimeout);
    });

    it("should apply show option (inverts headless)", () => {
      const result = applyBrowserOptions({ show: true });
      expect(result.headless).toBe(false);
    });

    it("should apply headless option", () => {
      const result = applyBrowserOptions({ headless: false });
      expect(result.headless).toBe(false);
    });

    it("should coerce string headless values with a warning", () => {
      const warningSpy = vi.spyOn(log, "warning").mockImplementation(() => undefined);
      const result = applyBrowserOptions({ headless: "false" as never });
      expect(result.headless).toBe(false);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("coercing to boolean false"));
    });

    it("should ignore invalid non-boolean headless values with a warning", () => {
      const warningSpy = vi.spyOn(log, "warning").mockImplementation(() => undefined);
      const result = applyBrowserOptions({ headless: 0 as never });
      expect(result.headless).toBe(CONFIG.headless);
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining("expected boolean but got number"));
    });

    it("should apply timeout_ms option", () => {
      const result = applyBrowserOptions({ timeout_ms: 60000 });
      expect(result.browserTimeout).toBe(60000);
    });

    it("should apply stealth options", () => {
      const result = applyBrowserOptions({
        stealth: { enabled: false, human_typing: false },
      });
      expect(result.stealthEnabled).toBe(false);
      expect(result.stealthHumanTyping).toBe(false);
    });

    it("should apply viewport options", () => {
      const result = applyBrowserOptions({
        viewport: { width: 800, height: 600 },
      });
      expect(result.viewport.width).toBe(800);
      expect(result.viewport.height).toBe(600);
    });

    it("should handle legacy show_browser parameter", () => {
      const result = applyBrowserOptions(undefined, true);
      expect(result.headless).toBe(false);
    });

    it("should prioritize browser_options over legacy parameter", () => {
      const result = applyBrowserOptions({ headless: true }, true);
      expect(result.headless).toBe(true);
    });

    it("should handle partial viewport", () => {
      const result = applyBrowserOptions({ viewport: { width: 1920 } });
      expect(result.viewport.width).toBe(1920);
      expect(result.viewport.height).toBe(CONFIG.viewport.height);
    });
  });

  describe("CONFIG defaults", () => {
    it("should have a valid responseTimeout", () => {
      expect(CONFIG.responseTimeout).toBe(120000);
    });

    it("should have followUpEnabled defaulting to true", () => {
      expect(CONFIG.followUpEnabled).toBe(true);
    });

    it("should have a non-empty followUpReminder", () => {
      expect(CONFIG.followUpReminder.length).toBeGreaterThan(0);
    });
  });
});
