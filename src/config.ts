/**
 * Configuration for NotebookLM MCP Server
 *
 * Config Priority (highest to lowest):
 * 1. Hardcoded Defaults (works out of the box!)
 * 2. Environment Variables (optional, for advanced users)
 * 3. Tool Parameters (passed by Claude at runtime)
 *
 * No config.json file needed - all settings via ENV or tool parameters!
 */

import envPaths from "env-paths";
import fs from "fs";
import path from "path";
import { mkdirSecure, PERMISSION_MODES } from "./utils/file-permissions.js";
import { SecureCredential } from "./utils/secure-memory.js";

/**
 * Clamp an integer to a [min, max] range
 */
function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Credential TTL: 30 minutes */
const CREDENTIAL_TTL_MS = 30 * 60 * 1000;

/** Secure credential holders (module-level so they persist) */
let secureLoginPassword: SecureCredential | null = null;
let secureGeminiApiKey: SecureCredential | null = null;

// Cross-platform data paths (unified without -nodejs suffix)
// Linux: ~/.local/share/notebooklm-mcp/
// macOS: ~/Library/Application Support/notebooklm-mcp/
// Windows: %APPDATA%\notebooklm-mcp\
// IMPORTANT: Pass empty string suffix to disable envPaths' default '-nodejs' suffix!
const paths = envPaths("notebooklm-mcp", {suffix: ""});

/**
 * Google NotebookLM Auth URL (used by setup_auth)
 * This is the base Google login URL that redirects to NotebookLM
 */
export const NOTEBOOKLM_AUTH_URL =
  "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fnotebooklm.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin";

export interface Config {
  // NotebookLM - optional, used for legacy default notebook
  notebookUrl: string;

  // Browser Settings
  headless: boolean;
  browserTimeout: number;
  viewport: { width: number; height: number };

  // Session Management
  maxSessions: number;
  sessionTimeout: number; // in seconds

  // Authentication
  autoLoginEnabled: boolean;
  loginEmail: string;
  loginPassword: string;
  autoLoginTimeoutMs: number;

  // Stealth Settings
  stealthEnabled: boolean;
  stealthRandomDelays: boolean;
  stealthHumanTyping: boolean;
  stealthMouseMovements: boolean;
  typingWpmMin: number;
  typingWpmMax: number;
  minDelayMs: number;
  maxDelayMs: number;

  // Paths
  configDir: string;
  dataDir: string;
  browserStateDir: string;
  chromeProfileDir: string;
  chromeInstancesDir: string;

  // Library Configuration (optional, for default notebook metadata)
  notebookDescription: string;
  notebookTopics: string[];
  notebookContentTypes: string[];
  notebookUseCases: string[];

  // Multi-instance profile strategy
  profileStrategy: "auto" | "single" | "isolated";
  cloneProfileOnIsolated: boolean;
  cleanupInstancesOnStartup: boolean;
  cleanupInstancesOnShutdown: boolean;
  instanceProfileTtlHours: number;
  instanceProfileMaxCount: number;

  // Gemini API (optional - for Deep Research and quick queries)
  geminiApiKey: string | null;
  geminiDefaultModel: string;
  geminiDeepResearchEnabled: boolean;
  geminiTimeoutMs: number;

  // Disable all Gemini API tools (for clients with context limitations)
  noGemini: boolean;

  // NotebookLM response timeout (ms)
  responseTimeout: number;

  // Follow-up reminder
  followUpReminder: string;
  followUpEnabled: boolean;
}

/**
 * Default Configuration (works out of the box!)
 */
const DEFAULTS: Config = {
  // NotebookLM
  notebookUrl: "",

  // Browser Settings
  headless: true,
  browserTimeout: 30000,
  viewport: { width: 1440, height: 900 },  // Wide enough for NotebookLM sidebar

  // Session Management
  maxSessions: 10,
  sessionTimeout: 900, // 15 minutes

  // Authentication
  autoLoginEnabled: false,
  loginEmail: "",
  loginPassword: "",
  autoLoginTimeoutMs: 120000, // 2 minutes

  // Stealth Settings
  stealthEnabled: true,
  stealthRandomDelays: true,
  stealthHumanTyping: true,
  stealthMouseMovements: true,
  typingWpmMin: 160,
  typingWpmMax: 240,
  minDelayMs: 100,
  maxDelayMs: 400,

  // Paths (cross-platform via env-paths)
  configDir: paths.config,
  dataDir: paths.data,
  browserStateDir: path.join(paths.data, "browser_state"),
  chromeProfileDir: path.join(paths.data, "chrome_profile"),
  chromeInstancesDir: path.join(paths.data, "chrome_profile_instances"),

  // Library Configuration
  notebookDescription: "General knowledge base",
  notebookTopics: ["General topics"],
  notebookContentTypes: ["documentation", "examples"],
  notebookUseCases: ["General research"],

  // Multi-instance strategy
  profileStrategy: "auto",
  cloneProfileOnIsolated: false,
  cleanupInstancesOnStartup: true,
  cleanupInstancesOnShutdown: true,
  instanceProfileTtlHours: 72,
  instanceProfileMaxCount: 20,

  // Gemini API defaults
  geminiApiKey: null,
  geminiDefaultModel: "gemini-3-flash-preview",
  geminiDeepResearchEnabled: true,
  geminiTimeoutMs: 30000,

  // Disable all Gemini API tools
  noGemini: false,

  // NotebookLM response timeout
  responseTimeout: 120000, // 2 minutes

  // Follow-up reminder
  followUpReminder: "\n\nEXTREMELY IMPORTANT: Is that ALL you need to know? You can always ask another question using the same session ID! Think about it carefully: before you reply to the user, review their original request and this answer. If anything is still unclear or missing, ask me another question first.",
  followUpEnabled: true,
};


/**
 * Parse boolean from string (for env vars)
 */
export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  return defaultValue;
}

/**
 * Parse integer from string (for env vars)
 */
export function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (value.trim() === "") return defaultValue;
  const parsed = Number(value);
  const result = Math.trunc(parsed);
  if (!Number.isFinite(result) || !Number.isInteger(result)) {
    return defaultValue;
  }
  return result;
}

/**
 * Parse comma/semicolon-separated array (for env vars)
 */
export function parseArray(value: string | undefined, defaultValue: string[]): string[] {
  if (!value) return defaultValue;
  return value.split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Apply environment variable overrides (legacy support)
 * Includes range clamping for safety-critical values and SecureCredential wrapping.
 */
function applyEnvOverrides(config: Config): Config {
  // Read credentials into SecureCredential holders and clear from process.env
  const rawPassword = process.env.LOGIN_PASSWORD || config.loginPassword;
  if (rawPassword) {
    secureLoginPassword = new SecureCredential(rawPassword, CREDENTIAL_TTL_MS);
    delete process.env.LOGIN_PASSWORD;
  }

  const rawGeminiKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
  if (rawGeminiKey) {
    secureGeminiApiKey = new SecureCredential(rawGeminiKey, CREDENTIAL_TTL_MS);
    delete process.env.GEMINI_API_KEY;
  }

  return {
    ...config,
    // Override with env vars if present
    notebookUrl: process.env.NOTEBOOK_URL || config.notebookUrl,
    headless: parseBoolean(process.env.HEADLESS, config.headless),
    browserTimeout: clampInteger(
      parseInteger(process.env.BROWSER_TIMEOUT, config.browserTimeout),
      5000, 300000
    ),
    maxSessions: clampInteger(
      parseInteger(process.env.MAX_SESSIONS, config.maxSessions),
      1, 50
    ),
    sessionTimeout: clampInteger(
      parseInteger(process.env.SESSION_TIMEOUT, config.sessionTimeout),
      60, 86400
    ),
    autoLoginEnabled: parseBoolean(process.env.AUTO_LOGIN_ENABLED, config.autoLoginEnabled),
    loginEmail: process.env.LOGIN_EMAIL || config.loginEmail,
    // Credential blanked from CONFIG — use getSecureLoginPassword() to access
    loginPassword: "",
    autoLoginTimeoutMs: parseInteger(process.env.AUTO_LOGIN_TIMEOUT_MS, config.autoLoginTimeoutMs),
    stealthEnabled: parseBoolean(process.env.STEALTH_ENABLED, config.stealthEnabled),
    stealthRandomDelays: parseBoolean(process.env.STEALTH_RANDOM_DELAYS, config.stealthRandomDelays),
    stealthHumanTyping: parseBoolean(process.env.STEALTH_HUMAN_TYPING, config.stealthHumanTyping),
    stealthMouseMovements: parseBoolean(process.env.STEALTH_MOUSE_MOVEMENTS, config.stealthMouseMovements),
    typingWpmMin: parseInteger(process.env.TYPING_WPM_MIN, config.typingWpmMin),
    typingWpmMax: parseInteger(process.env.TYPING_WPM_MAX, config.typingWpmMax),
    minDelayMs: parseInteger(process.env.MIN_DELAY_MS, config.minDelayMs),
    maxDelayMs: parseInteger(process.env.MAX_DELAY_MS, config.maxDelayMs),
    notebookDescription: process.env.NOTEBOOK_DESCRIPTION || config.notebookDescription,
    notebookTopics: parseArray(process.env.NOTEBOOK_TOPICS, config.notebookTopics),
    notebookContentTypes: parseArray(process.env.NOTEBOOK_CONTENT_TYPES, config.notebookContentTypes),
    notebookUseCases: parseArray(process.env.NOTEBOOK_USE_CASES, config.notebookUseCases),
    profileStrategy: (["auto", "single", "isolated"].includes(process.env.NOTEBOOK_PROFILE_STRATEGY ?? "")
      ? process.env.NOTEBOOK_PROFILE_STRATEGY as Config["profileStrategy"]
      : config.profileStrategy),
    cloneProfileOnIsolated: parseBoolean(process.env.NOTEBOOK_CLONE_PROFILE, config.cloneProfileOnIsolated),
    cleanupInstancesOnStartup: parseBoolean(process.env.NOTEBOOK_CLEANUP_ON_STARTUP, config.cleanupInstancesOnStartup),
    cleanupInstancesOnShutdown: parseBoolean(process.env.NOTEBOOK_CLEANUP_ON_SHUTDOWN, config.cleanupInstancesOnShutdown),
    instanceProfileTtlHours: parseInteger(process.env.NOTEBOOK_INSTANCE_TTL_HOURS, config.instanceProfileTtlHours),
    instanceProfileMaxCount: parseInteger(process.env.NOTEBOOK_INSTANCE_MAX_COUNT, config.instanceProfileMaxCount),

    // Gemini API
    // Credential blanked from CONFIG — use getSecureGeminiApiKey() to access
    geminiApiKey: rawGeminiKey ? null : config.geminiApiKey,
    geminiDefaultModel: process.env.GEMINI_DEFAULT_MODEL || config.geminiDefaultModel,
    geminiDeepResearchEnabled: parseBoolean(process.env.GEMINI_DEEP_RESEARCH_ENABLED, config.geminiDeepResearchEnabled),
    geminiTimeoutMs: parseInteger(process.env.GEMINI_TIMEOUT_MS, config.geminiTimeoutMs),

    // Disable Gemini tools
    noGemini: parseBoolean(process.env.NOTEBOOKLM_NO_GEMINI, config.noGemini),

    // NotebookLM response timeout
    responseTimeout: parseInteger(process.env.NLMCP_RESPONSE_TIMEOUT_MS, config.responseTimeout),

    // Follow-up reminder — validate to prevent env-based prompt injection (I318)
    followUpReminder: (() => {
      const raw = process.env.NLMCP_FOLLOW_UP_REMINDER;
      if (!raw) return config.followUpReminder;
      // Strip any embedded null bytes or control chars (except newline/tab)
      return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, 2000);
    })(),
    followUpEnabled: parseBoolean(process.env.NLMCP_FOLLOW_UP_ENABLED, config.followUpEnabled),
  };
}

/**
 * Get the secure login password credential
 */
export function getSecureLoginPassword(): SecureCredential | null {
  return secureLoginPassword;
}

/**
 * Get the secure Gemini API key credential
 */
export function getSecureGeminiApiKey(): SecureCredential | null {
  return secureGeminiApiKey;
}

/**
 * Build final configuration
 * Priority: Defaults → Environment Variables → Tool Parameters (at runtime)
 * No config.json files - everything via ENV or tool parameters!
 */
function buildConfig(): Config {
  return applyEnvOverrides(DEFAULTS);
}

/**
 * Global configuration instance
 */
export const CONFIG: Config = buildConfig();

/**
 * Keep `getConfig()` as a stable import surface for modules that should not reach
 * into the mutable config implementation details directly.
 */
export function getConfig(): Config {
  return CONFIG;
}

/**
 * Ensure all required directories exist
 * NOTE: We do NOT create configDir - it's not needed!
 */
export function ensureDirectories(): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const dirs = [
    CONFIG.dataDir,
    CONFIG.browserStateDir,
    CONFIG.chromeProfileDir,
    CONFIG.chromeInstancesDir,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      mkdirSecure(dir, PERMISSION_MODES.OWNER_FULL);
    }
  }
}


/**
 * Browser options that can be passed via tool parameters
 */
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
 * Apply browser options to CONFIG (returns modified copy, doesn't mutate global CONFIG)
 */
export function applyBrowserOptions(
  options?: BrowserOptions,
  legacyShowBrowser?: boolean
): Config {
  const config = { ...CONFIG };

  // Handle legacy show_browser parameter
  if (legacyShowBrowser !== undefined) {
    config.headless = !legacyShowBrowser;
  }

  // Apply browser_options (takes precedence over legacy parameter)
  if (options) {
    if (options.show !== undefined) {
      config.headless = !options.show;
    }
    if (options.headless !== undefined) {
      config.headless = options.headless;
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
