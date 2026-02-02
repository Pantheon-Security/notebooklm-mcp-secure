/**
 * Settings Manager
 * 
 * Handles persistent configuration for the NotebookLM MCP Server.
 * Manages profiles, disabled tools, and environment variable overrides.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSecure, writeFileSecure, PERMISSION_MODES } from "./file-permissions.js";

export type ProfileName = "minimal" | "standard" | "full";

export interface Settings {
  profile: ProfileName;
  disabledTools: string[];
  customSettings?: Record<string, any>;
}

const DEFAULT_SETTINGS: Settings = {
  profile: "full",
  disabledTools: [],
};

const PROFILES: Record<ProfileName, string[]> = {
  minimal: [
    "ask_question",
    "get_health",
    "list_notebooks",
    "select_notebook",
    "get_notebook" // Added as it is read-only and useful
  ],
  standard: [
    "ask_question",
    "get_health",
    "list_notebooks",
    "select_notebook",
    "get_notebook",
    "setup_auth",
    "list_sessions",
    "add_notebook",
    "update_notebook",
    "search_notebooks"
  ],
  full: ["*"] // All tools
};

/**
 * Gemini API tools that can be disabled via NOTEBOOKLM_NO_GEMINI=true
 * These tools require GEMINI_API_KEY and may not be needed by all clients
 */
const GEMINI_TOOLS = [
  "deep_research",
  "gemini_query",
  "get_research_status",
  "upload_document",
  "query_document",
  "list_documents",
  "delete_document",
  "query_chunked_document",
];

export class SettingsManager {
  private settingsPath: string;
  private settings: Settings;

  constructor() {
    // Use the config directory from env-paths defined in config.ts
    this.settingsPath = path.join(CONFIG.configDir, "settings.json");
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from file, falling back to defaults
   */
  private loadSettings(): Settings {
    try {
      // Ensure config dir exists with secure permissions
      if (!existsSync(CONFIG.configDir)) {
        mkdirSecure(CONFIG.configDir, PERMISSION_MODES.OWNER_FULL);
      }

      if (existsSync(this.settingsPath)) {
        const data = readFileSync(this.settingsPath, "utf-8");
        return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      }
    } catch (error) {
      log.warning(`⚠️  Failed to load settings: ${error}. Using defaults.`);
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Save current settings to file
   */
  async saveSettings(newSettings: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...newSettings };
    try {
      writeFileSecure(
        this.settingsPath,
        JSON.stringify(this.settings, null, 2),
        PERMISSION_MODES.OWNER_READ_WRITE
      );
    } catch (error) {
      throw new Error(`Failed to save settings: ${error}`);
    }
  }

  /**
   * Get effective configuration (merging File settings with Env Vars)
   */
  getEffectiveSettings(): Settings {
    const envProfile = process.env.NOTEBOOKLM_PROFILE as ProfileName;
    const envDisabled = process.env.NOTEBOOKLM_DISABLED_TOOLS;

    const effectiveProfile = (envProfile && PROFILES[envProfile]) ? envProfile : this.settings.profile;
    
    let effectiveDisabled = [...this.settings.disabledTools];
    if (envDisabled) {
      const envDisabledList = envDisabled.split(",").map(t => t.trim());
      effectiveDisabled = [...new Set([...effectiveDisabled, ...envDisabledList])];
    }

    return {
      profile: effectiveProfile,
      disabledTools: effectiveDisabled,
      customSettings: this.settings.customSettings
    };
  }

  /**
   * Filter tools based on effective configuration
   */
  filterTools(allTools: Tool[]): Tool[] {
    const { profile, disabledTools } = this.getEffectiveSettings();
    const allowedTools = PROFILES[profile];

    return allTools.filter(tool => {
      // 0. Filter out Gemini tools if noGemini is set
      if (CONFIG.noGemini && GEMINI_TOOLS.includes(tool.name)) {
        return false;
      }

      // 1. Check if allowed by profile (unless profile is full/wildcard)
      if (!allowedTools.includes("*") && !allowedTools.includes(tool.name)) {
        return false;
      }

      // 2. Check if explicitly disabled
      if (disabledTools.includes(tool.name)) {
        return false;
      }

      return true;
    });
  }

  getSettingsPath(): string {
    return this.settingsPath;
  }

  getProfiles(): Record<ProfileName, string[]> {
    return PROFILES;
  }
}
