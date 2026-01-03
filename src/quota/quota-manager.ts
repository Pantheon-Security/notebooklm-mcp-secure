/**
 * NotebookLM Quota Manager
 *
 * Manages license tier detection, usage tracking, and limit enforcement.
 */

import type { Page } from "patchright";
import { log } from "../utils/logger.js";
import { CONFIG } from "../config.js";
import { withLock } from "../utils/file-lock.js";
import fs from "fs";
import path from "path";

export type LicenseTier = "free" | "pro" | "ultra" | "unknown";

export interface QuotaLimits {
  notebooks: number;
  sourcesPerNotebook: number;
  wordsPerSource: number;
  queriesPerDay: number;
}

export interface QuotaUsage {
  notebooks: number;
  queriesUsedToday: number;
  lastQueryDate: string;
  lastUpdated: string;
}

export interface QuotaSettings {
  tier: LicenseTier;
  limits: QuotaLimits;
  usage: QuotaUsage;
  autoDetected: boolean;
}

// Known limits by tier (based on NotebookLM documentation Dec 2025)
// https://support.google.com/notebooklm/answer/16213268
const TIER_LIMITS: Record<LicenseTier, QuotaLimits> = {
  free: {
    notebooks: 100,
    sourcesPerNotebook: 50,
    wordsPerSource: 500000,
    queriesPerDay: 50,
  },
  pro: {
    notebooks: 500,
    sourcesPerNotebook: 300,
    wordsPerSource: 500000,
    queriesPerDay: 500,
  },
  ultra: {
    notebooks: 500,
    sourcesPerNotebook: 600,
    wordsPerSource: 500000,
    queriesPerDay: 5000,
  },
  unknown: {
    // Conservative defaults (use free tier limits)
    notebooks: 100,
    sourcesPerNotebook: 50,
    wordsPerSource: 500000,
    queriesPerDay: 50,
  },
};

export class QuotaManager {
  private settings: QuotaSettings;
  private settingsPath: string;

  constructor() {
    this.settingsPath = path.join(CONFIG.configDir, "quota.json");
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from disk or create defaults
   */
  private loadSettings(): QuotaSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, "utf-8");
        const loaded = JSON.parse(data) as QuotaSettings;
        log.info(`📊 Loaded quota settings (tier: ${loaded.tier})`);
        return loaded;
      }
    } catch (error) {
      log.warning(`⚠️ Could not load quota settings: ${error}`);
    }

    // Return defaults
    return this.getDefaultSettings();
  }

  /**
   * Get default settings
   */
  private getDefaultSettings(): QuotaSettings {
    return {
      tier: "unknown",
      limits: TIER_LIMITS.unknown,
      usage: {
        notebooks: 0,
        queriesUsedToday: 0,
        lastQueryDate: new Date().toISOString().split("T")[0],
        lastUpdated: new Date().toISOString(),
      },
      autoDetected: false,
    };
  }

  /**
   * Save settings to disk
   */
  private saveSettings(): void {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify(this.settings, null, 2),
        { mode: 0o600 }
      );
      log.info(`💾 Saved quota settings`);
    } catch (error) {
      log.error(`❌ Could not save quota settings: ${error}`);
    }
  }

  /**
   * Detect license tier from NotebookLM UI
   * Tiers: free, pro, ultra (Google AI Ultra $249.99/month)
   */
  async detectTierFromPage(page: Page): Promise<LicenseTier> {
    log.info("🔍 Detecting license tier...");

    const tierInfo = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const allText = document.body.innerText.toUpperCase();

      // Check for ULTRA first (highest tier)
      // @ts-expect-error - DOM types
      const ultraBadge = document.querySelector(".ultra-badge, [class*='ultra']");
      if (ultraBadge || allText.includes("ULTRA")) {
        return "ultra";
      }

      // Look for PRO badge
      // @ts-expect-error - DOM types
      const proBadge = document.querySelector(".pro-badge");
      if (proBadge) {
        return "pro";
      }

      // Look for PRO text in specific elements
      // @ts-expect-error - DOM types
      const proLabels = document.querySelectorAll(".pro-label, [class*='pro']");
      for (const el of proLabels) {
        if ((el as any).textContent?.toUpperCase().includes("PRO")) {
          return "pro";
        }
      }

      // Check for upgrade prompts (indicates free tier)
      if (allText.includes("UPGRADE") && !allText.includes("PRO") && !allText.includes("ULTRA")) {
        return "free";
      }

      return "unknown";
    });

    log.info(`  Detected tier: ${tierInfo}`);
    return tierInfo as LicenseTier;
  }

  /**
   * Extract source limit from source dialog (e.g., "0/300")
   */
  async extractSourceLimitFromDialog(page: Page): Promise<number | null> {
    const limitInfo = await page.evaluate(() => {
      // Look for X/Y pattern
      // @ts-expect-error - DOM types
      const allText = document.body.innerText;
      const match = allText.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) {
        return parseInt(match[2], 10); // Return the limit (Y in X/Y)
      }
      return null;
    });

    return limitInfo;
  }

  /**
   * Extract query usage from NotebookLM UI
   *
   * Looks for patterns like:
   * - "X/50 queries" or "X of 50 queries"
   * - "X queries remaining"
   * - Usage indicators in settings/account area
   *
   * Returns { used, limit } or null if not found
   */
  async extractQueryUsageFromUI(page: Page): Promise<{ used: number; limit: number } | null> {
    log.info("🔍 Looking for query usage in UI...");

    const usageInfo = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const allText = document.body.innerText;

      // Pattern 1: "X/Y queries" or "X / Y queries"
      const slashPattern = allText.match(/(\d+)\s*\/\s*(\d+)\s*quer(?:y|ies)/i);
      if (slashPattern) {
        return {
          used: parseInt(slashPattern[1], 10),
          limit: parseInt(slashPattern[2], 10),
        };
      }

      // Pattern 2: "X of Y queries"
      const ofPattern = allText.match(/(\d+)\s+of\s+(\d+)\s*quer(?:y|ies)/i);
      if (ofPattern) {
        return {
          used: parseInt(ofPattern[1], 10),
          limit: parseInt(ofPattern[2], 10),
        };
      }

      // Pattern 3: "X queries remaining" with known limits
      const remainingPattern = allText.match(/(\d+)\s*quer(?:y|ies)\s*remaining/i);
      if (remainingPattern) {
        const remaining = parseInt(remainingPattern[1], 10);
        // Infer limit from known tiers
        let limit = 50; // default free
        if (remaining > 50) limit = 500; // pro
        if (remaining > 500) limit = 5000; // ultra
        return {
          used: limit - remaining,
          limit,
        };
      }

      // Pattern 4: "You have used X queries today"
      const usedPattern = allText.match(/(?:used|made)\s*(\d+)\s*quer(?:y|ies)/i);
      if (usedPattern) {
        const used = parseInt(usedPattern[1], 10);
        // Infer tier from usage
        let limit = 50;
        if (used > 50) limit = 500;
        if (used > 500) limit = 5000;
        return { used, limit };
      }

      // Pattern 5: Look for rate limit message
      const rateLimitPattern = allText.match(/(?:limit|quota)\s*(?:reached|exceeded)/i);
      if (rateLimitPattern) {
        // At limit - try to find the number
        const limitNum = allText.match(/(\d+)\s*(?:daily|per day)/i);
        const limit = limitNum ? parseInt(limitNum[1], 10) : 50;
        return { used: limit, limit };
      }

      return null;
    });

    if (usageInfo) {
      log.info(`  Found query usage: ${usageInfo.used}/${usageInfo.limit}`);
    } else {
      log.info("  No query usage found in UI");
    }

    return usageInfo;
  }

  /**
   * Check for rate limit error message on page
   */
  async checkForRateLimitError(page: Page): Promise<boolean> {
    const isRateLimited = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const allText = document.body.innerText.toLowerCase();
      return (
        allText.includes("rate limit") ||
        allText.includes("quota exceeded") ||
        allText.includes("too many requests") ||
        allText.includes("daily limit reached") ||
        allText.includes("try again tomorrow")
      );
    });

    if (isRateLimited) {
      log.warning("⚠️ Rate limit detected in UI!");
    }

    return isRateLimited;
  }

  /**
   * Count notebooks from homepage
   */
  async countNotebooksFromPage(page: Page): Promise<number> {
    const count = await page.evaluate(() => {
      // Count table rows that have "Source" in them (notebook rows)
      // @ts-expect-error - DOM types
      const rows = document.querySelectorAll("tr");
      let count = 0;
      for (const row of rows) {
        if ((row as any).textContent?.includes("Source")) {
          count++;
        }
      }
      return count;
    });

    return count;
  }

  /**
   * Update quota from UI scraping
   */
  async updateFromUI(page: Page): Promise<{
    tier: LicenseTier;
    queryUsageFromGoogle: { used: number; limit: number } | null;
    rateLimitDetected: boolean;
  }> {
    log.info("📊 Updating quota from UI...");

    // Detect tier
    const tier = await this.detectTierFromPage(page);
    if (tier !== "unknown") {
      this.settings.tier = tier;
      this.settings.limits = TIER_LIMITS[tier];
      this.settings.autoDetected = true;
    }

    // Count notebooks
    const notebookCount = await this.countNotebooksFromPage(page);
    if (notebookCount > 0) {
      this.settings.usage.notebooks = notebookCount;
    }

    // Try to get source limit from dialog if visible
    const sourceLimit = await this.extractSourceLimitFromDialog(page);
    if (sourceLimit) {
      this.settings.limits.sourcesPerNotebook = sourceLimit;
    }

    // Try to extract query usage from UI
    const queryUsage = await this.extractQueryUsageFromUI(page);
    if (queryUsage) {
      // Update local tracking with Google's numbers
      this.settings.usage.queriesUsedToday = queryUsage.used;
      this.settings.limits.queriesPerDay = queryUsage.limit;
      this.settings.usage.lastQueryDate = new Date().toISOString().split("T")[0];
      log.info(`  Synced query usage from Google: ${queryUsage.used}/${queryUsage.limit}`);
    }

    // Check for rate limit
    const rateLimitDetected = await this.checkForRateLimitError(page);
    if (rateLimitDetected) {
      // Mark as at limit
      this.settings.usage.queriesUsedToday = this.settings.limits.queriesPerDay;
    }

    this.settings.usage.lastUpdated = new Date().toISOString();
    this.saveSettings();

    log.success(`✅ Quota updated: tier=${this.settings.tier}, notebooks=${this.settings.usage.notebooks}, queries=${this.settings.usage.queriesUsedToday}/${this.settings.limits.queriesPerDay}`);

    return {
      tier: this.settings.tier,
      queryUsageFromGoogle: queryUsage,
      rateLimitDetected,
    };
  }

  /**
   * Manually set tier (for user override)
   */
  setTier(tier: LicenseTier): void {
    this.settings.tier = tier;
    this.settings.limits = TIER_LIMITS[tier];
    this.settings.autoDetected = false;
    this.saveSettings();
    log.info(`📊 Tier set to: ${tier}`);
  }

  /**
   * Get current settings
   */
  getSettings(): QuotaSettings {
    return { ...this.settings };
  }

  /**
   * Get current limits
   */
  getLimits(): QuotaLimits {
    return { ...this.settings.limits };
  }

  /**
   * Get current usage
   */
  getUsage(): QuotaUsage {
    return { ...this.settings.usage };
  }

  /**
   * Increment notebook count
   */
  incrementNotebookCount(): void {
    this.settings.usage.notebooks++;
    this.settings.usage.lastUpdated = new Date().toISOString();
    this.saveSettings();
  }

  /**
   * Increment query count (synchronous, for backwards compatibility)
   * Note: For concurrent safety, use incrementQueryCountAtomic() instead
   */
  incrementQueryCount(): void {
    const today = new Date().toISOString().split("T")[0];

    // Reset if new day
    if (this.settings.usage.lastQueryDate !== today) {
      this.settings.usage.queriesUsedToday = 0;
      this.settings.usage.lastQueryDate = today;
    }

    this.settings.usage.queriesUsedToday++;
    this.settings.usage.lastUpdated = new Date().toISOString();
    this.saveSettings();
  }

  /**
   * Increment query count atomically with file locking
   *
   * This method is safe for concurrent access from multiple processes/sessions.
   * It reloads settings from disk before incrementing to ensure accuracy.
   */
  async incrementQueryCountAtomic(): Promise<void> {
    await withLock(this.settingsPath, async () => {
      // Reload latest settings from disk (another process may have updated)
      this.settings = this.loadSettings();

      const today = new Date().toISOString().split("T")[0];

      // Reset if new day
      if (this.settings.usage.lastQueryDate !== today) {
        this.settings.usage.queriesUsedToday = 0;
        this.settings.usage.lastQueryDate = today;
      }

      this.settings.usage.queriesUsedToday++;
      this.settings.usage.lastUpdated = new Date().toISOString();

      // Save with lock held
      try {
        const dir = path.dirname(this.settingsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        fs.writeFileSync(
          this.settingsPath,
          JSON.stringify(this.settings, null, 2),
          { mode: 0o600 }
        );
        log.debug(`💾 Quota incremented atomically (${this.settings.usage.queriesUsedToday} queries today)`);
      } catch (error) {
        log.error(`❌ Could not save quota settings: ${error}`);
      }
    });
  }

  /**
   * Refresh settings from disk with file locking
   *
   * Use this to ensure you have the latest quota state from disk.
   */
  async refreshSettings(): Promise<QuotaSettings> {
    return await withLock(this.settingsPath, async () => {
      this.settings = this.loadSettings();
      return { ...this.settings };
    });
  }

  /**
   * Check if can create notebook
   */
  canCreateNotebook(): { allowed: boolean; reason?: string } {
    const { notebooks } = this.settings.usage;
    const { notebooks: limit } = this.settings.limits;

    if (notebooks >= limit) {
      return {
        allowed: false,
        reason: `Notebook limit reached (${notebooks}/${limit}). Delete notebooks or upgrade your plan.`,
      };
    }

    // Warn if approaching limit
    if (notebooks >= limit * 0.9) {
      log.warning(`⚠️ Approaching notebook limit: ${notebooks}/${limit}`);
    }

    return { allowed: true };
  }

  /**
   * Check if can add source to notebook
   */
  canAddSource(currentSourceCount: number): { allowed: boolean; reason?: string } {
    const { sourcesPerNotebook: limit } = this.settings.limits;

    if (currentSourceCount >= limit) {
      return {
        allowed: false,
        reason: `Source limit reached for this notebook (${currentSourceCount}/${limit}).`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if can make query
   */
  canMakeQuery(): { allowed: boolean; reason?: string } {
    const today = new Date().toISOString().split("T")[0];

    // Reset if new day
    if (this.settings.usage.lastQueryDate !== today) {
      this.settings.usage.queriesUsedToday = 0;
      this.settings.usage.lastQueryDate = today;
    }

    const { queriesUsedToday } = this.settings.usage;
    const { queriesPerDay: limit } = this.settings.limits;

    if (queriesUsedToday >= limit) {
      return {
        allowed: false,
        reason: `Daily query limit reached (${queriesUsedToday}/${limit}). Try again tomorrow or upgrade your plan.`,
      };
    }

    // Warn if approaching limit
    if (queriesUsedToday >= limit * 0.8) {
      log.warning(`⚠️ Approaching daily query limit: ${queriesUsedToday}/${limit}`);
    }

    return { allowed: true };
  }

  /**
   * Get quota status summary
   */
  getStatus(): {
    tier: LicenseTier;
    notebooks: { used: number; limit: number; percent: number };
    sources: { limit: number };
    queries: { used: number; limit: number; percent: number };
  } {
    const { tier, limits, usage } = this.settings;

    return {
      tier,
      notebooks: {
        used: usage.notebooks,
        limit: limits.notebooks,
        percent: Math.round((usage.notebooks / limits.notebooks) * 100),
      },
      sources: {
        limit: limits.sourcesPerNotebook,
      },
      queries: {
        used: usage.queriesUsedToday,
        limit: limits.queriesPerDay,
        percent: Math.round((usage.queriesUsedToday / limits.queriesPerDay) * 100),
      },
    };
  }

  /**
   * Get detailed quota status with remaining counts, warnings, and stop signals
   * Used to provide visibility to users about when to stop querying for the day
   */
  getDetailedStatus(): {
    tier: LicenseTier;
    queries: {
      used: number;
      limit: number;
      remaining: number;
      percentUsed: number;
      shouldStop: boolean;
      resetTime: string;
    };
    notebooks: {
      used: number;
      limit: number;
      remaining: number;
      percentUsed: number;
    };
    sources: {
      limit: number;
    };
    warnings: string[];
  } {
    const today = new Date().toISOString().split("T")[0];

    // Reset if new day
    if (this.settings.usage.lastQueryDate !== today) {
      this.settings.usage.queriesUsedToday = 0;
      this.settings.usage.lastQueryDate = today;
    }

    const { tier, limits, usage } = this.settings;

    const queriesRemaining = limits.queriesPerDay - usage.queriesUsedToday;
    const queriesPercentUsed = Math.round((usage.queriesUsedToday / limits.queriesPerDay) * 100);
    const notebooksRemaining = limits.notebooks - usage.notebooks;
    const notebooksPercentUsed = Math.round((usage.notebooks / limits.notebooks) * 100);

    // Calculate next reset time (midnight local time)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    // Build warnings list
    const warnings: string[] = [];

    if (queriesRemaining <= 0) {
      warnings.push(`CRITICAL: Daily query limit reached (${usage.queriesUsedToday}/${limits.queriesPerDay}). Wait until tomorrow or upgrade your plan.`);
    } else if (queriesRemaining <= 5) {
      warnings.push(`CRITICAL: Only ${queriesRemaining} queries remaining today! Consider stopping soon.`);
    } else if (queriesRemaining <= 10) {
      warnings.push(`WARNING: Only ${queriesRemaining} queries remaining today.`);
    } else if (queriesPercentUsed >= 80) {
      warnings.push(`INFO: ${queriesPercentUsed}% of daily queries used (${queriesRemaining} remaining).`);
    }

    if (notebooksRemaining <= 5) {
      warnings.push(`WARNING: Only ${notebooksRemaining} notebook slots remaining.`);
    }

    return {
      tier,
      queries: {
        used: usage.queriesUsedToday,
        limit: limits.queriesPerDay,
        remaining: queriesRemaining,
        percentUsed: queriesPercentUsed,
        shouldStop: queriesRemaining <= 5,
        resetTime: tomorrow.toISOString(),
      },
      notebooks: {
        used: usage.notebooks,
        limit: limits.notebooks,
        remaining: notebooksRemaining,
        percentUsed: notebooksPercentUsed,
      },
      sources: {
        limit: limits.sourcesPerNotebook,
      },
      warnings,
    };
  }
}

// Singleton instance
let quotaManagerInstance: QuotaManager | null = null;

export function getQuotaManager(): QuotaManager {
  if (!quotaManagerInstance) {
    quotaManagerInstance = new QuotaManager();
  }
  return quotaManagerInstance;
}
