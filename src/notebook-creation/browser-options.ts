/**
 * Browser options that can be passed via tool parameters.
 */

import { CONFIG, type Config } from "../config.js";
import { log } from "../utils/logger.js";

export interface BrowserOptions {
  show?: boolean;
  headless?: boolean;
  timeout_ms?: number;
  stealth?: {
    enabled?: boolean;
    random_delays?: boolean;
    human_typing?: boolean;
    mouse_movements?: boolean;
    typing_wpm_min?: number;
    typing_wpm_max?: number;
    delay_min_ms?: number;
    delay_max_ms?: number;
  };
  viewport?: {
    width?: number;
    height?: number;
  };
}

/**
 * Apply browser options to CONFIG (returns modified copy, doesn't mutate global CONFIG).
 */
export function applyBrowserOptions(
  options?: BrowserOptions,
  legacyShowBrowser?: boolean
): Config {
  const config = { ...CONFIG };

  const coerceBooleanOption = (value: unknown, optionName: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        log.warning(`Invalid browser option '${optionName}' received as string; coercing to boolean true`);
        return true;
      }
      if (normalized === "false") {
        log.warning(`Invalid browser option '${optionName}' received as string; coercing to boolean false`);
        return false;
      }
    }

    log.warning(`Invalid browser option '${optionName}' received; expected boolean but got ${typeof value}. Ignoring value.`);
    return undefined;
  };

  // Handle legacy show_browser parameter
  if (legacyShowBrowser !== undefined) {
    config.headless = !legacyShowBrowser;
  }

  // Apply browser_options (takes precedence over legacy parameter)
  if (options) {
    const show = coerceBooleanOption(options.show, "show");
    if (show !== undefined) {
      config.headless = !show;
    }
    const headless = coerceBooleanOption(options.headless, "headless");
    if (headless !== undefined) {
      config.headless = headless;
    }
    if (options.timeout_ms !== undefined) {
      config.browserTimeout = options.timeout_ms;
    }
    if (options.stealth) {
      const s = options.stealth;
      if (s.enabled !== undefined) config.stealthEnabled = s.enabled;
      if (s.random_delays !== undefined) config.stealthRandomDelays = s.random_delays;
      if (s.human_typing !== undefined) config.stealthHumanTyping = s.human_typing;
      if (s.mouse_movements !== undefined) config.stealthMouseMovements = s.mouse_movements;
      if (s.typing_wpm_min !== undefined) config.typingWpmMin = s.typing_wpm_min;
      if (s.typing_wpm_max !== undefined) config.typingWpmMax = s.typing_wpm_max;
      if (s.delay_min_ms !== undefined) config.minDelayMs = s.delay_min_ms;
      if (s.delay_max_ms !== undefined) config.maxDelayMs = s.delay_max_ms;
    }
    if (options.viewport) {
      config.viewport = {
        width: options.viewport.width ?? config.viewport.width,
        height: options.viewport.height ?? config.viewport.height,
      };
    }
  }

  return config;
}
