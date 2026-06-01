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
import { getMetricsRegistry } from "../observability/metrics.js";

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

const MAX_REASONABLE_QUERIES = 10_000;
const MAX_REASONABLE_NOTEBOOKS = 100_000;
const PAGE_EVALUATE_TIMEOUT_MS = 30_000;

/** Type guard: is the given string a known license tier? */
function isKnownTier(tier: unknown): tier is LicenseTier {
  return typeof tier === "string" && Object.prototype.hasOwnProperty.call(TIER_LIMITS, tier);
}

/** Always derive limits from the authoritative tier table (never trust on-disk limits). */
function deriveLimitsForTier(tier: LicenseTier): QuotaLimits {
  return { ...TIER_LIMITS[tier] };
}

type BrowserDomElement = unknown;

type BrowserTextElement = {
  textContent?: string | null;
};

type BrowserBodyElement = {
  innerText: string;
};

type BrowserDocumentContext = {
  document: {
    body: BrowserBodyElement;
    querySelector(selector: string): BrowserDomElement | null;
    querySelectorAll(selector: string): Iterable<BrowserDomElement>;
  };
};

export class QuotaManager {
  private settings: QuotaSettings;
  private settingsPath: string;

  constructor() {
    this.settingsPath = path.join(CONFIG.dataDir, "quota.json");
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from disk or create defaults
   */
  private loadSettings(): QuotaSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const data = fs.readFileSync(this.settingsPath, "utf-8");
        const parsed = JSON.parse(data) as unknown;
        const validated = this.validateSettings(parsed);
        log.info(`📊 Loaded quota settings (tier: ${validated.tier})`);
        return validated;
      }
    } catch (error) {
      log.warning(`⚠️ Could not load quota settings: ${error}`);
    }

    // Return defaults
    return this.getDefaultSettings();
  }

  /**
   * Validate and sanitise an untrusted (user-writable) settings object.
   *
   * The quota.json file is user-writable, so a tampered or stale file must not
   * be able to disable enforcement (e.g. by setting limits to 1e12/0/strings or
   * omitting usage fields, which would otherwise yield NaN comparisons). Tier is
   * constrained to a known key (falls back to "unknown"); limits are ALWAYS
   * derived from TIER_LIMITS[tier] and never trusted from disk; usage fields are
   * coerced to finite numbers and defaulted when missing.
   */
  private validateSettings(parsed: unknown): QuotaSettings {
    if (!parsed || typeof parsed !== "object") {
      log.warning("⚠️ Quota settings file is not an object; using defaults");
      return this.getDefaultSettings();
    }

    const obj = parsed as Record<string, unknown>;
    const defaults = this.getDefaultSettings();

    // Tier must be a known key, otherwise fall back to a safe default.
    let tier: LicenseTier = "unknown";
    if (isKnownTier(obj.tier)) {
      tier = obj.tier;
    } else if (obj.tier !== undefined) {
      log.warning(`⚠️ Unknown tier "${String(obj.tier)}" in quota settings; falling back to "unknown"`);
    }

    // CRUCIAL: derive limits from the tier table, never trust on-disk values.
    const limits = deriveLimitsForTier(tier);

    const rawUsage =
      obj.usage && typeof obj.usage === "object"
        ? (obj.usage as Record<string, unknown>)
        : {};

    const coerceCount = (value: unknown, max: number): number => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(Math.floor(n), max);
    };

    const queriesUsedToday = coerceCount(rawUsage.queriesUsedToday, MAX_REASONABLE_QUERIES);
    const notebooks = coerceCount(rawUsage.notebooks, MAX_REASONABLE_NOTEBOOKS);
    const lastQueryDate =
      typeof rawUsage.lastQueryDate === "string" && rawUsage.lastQueryDate.length > 0
        ? rawUsage.lastQueryDate
        : defaults.usage.lastQueryDate;
    const lastUpdated =
      typeof rawUsage.lastUpdated === "string" && rawUsage.lastUpdated.length > 0
        ? rawUsage.lastUpdated
        : defaults.usage.lastUpdated;

    return {
      tier,
      limits,
      usage: { notebooks, queriesUsedToday, lastQueryDate, lastUpdated },
      autoDetected: typeof obj.autoDetected === "boolean" ? obj.autoDetected : false,
    };
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
      throw error;
    }
  }

  /**
   * Effective (rolled-over) query count for TODAY, computed WITHOUT mutating or
   * persisting settings. If the stored lastQueryDate is not today, the count is
   * treated as 0 (the day has rolled over) but no write occurs — persisting the
   * rollover is the exclusive responsibility of incrementQueryCountAtomic /
   * checkAndReserveQuery (see I285). Shared by all readers (getStatus,
   * getDetailedStatus, updateQuotaMetrics, canMakeQuery) so they never report a
   * stale pre-rollover count.
   */
  private effectiveQueriesUsedToday(): number {
    const today = new Date().toISOString().split("T")[0];
    return this.settings.usage.lastQueryDate === today
      ? this.settings.usage.queriesUsedToday
      : 0;
  }

  /** Percentage guard: avoid NaN/Infinity when the limit is zero or invalid. */
  private static safePercent(used: number, limit: number): number {
    if (!Number.isFinite(limit) || limit <= 0) return 0;
    return Math.round((used / limit) * 100);
  }

  private async evaluateWithTimeout<T>(
    page: Page,
    fn: () => T,
    timeoutMs = PAGE_EVALUATE_TIMEOUT_MS
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        page.evaluate(fn),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`page.evaluate timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Detect license tier from NotebookLM UI
   * Tiers: free, pro, ultra (Google AI Ultra $249.99/month)
   */
  async detectTierFromPage(page: Page): Promise<LicenseTier> {
    log.info("🔍 Detecting license tier...");

    const tierInfo = await this.evaluateWithTimeout(page, () => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const accountSection = browser.document.querySelector(
        [
          "[data-testid*='account']",
          "[data-testid*='plan']",
          "[data-testid*='subscription']",
          "[aria-label*='Account']",
          "[aria-label*='Plan']",
          "[aria-label*='Subscription']",
          "settings-dialog",
          "account-menu",
          "mat-dialog-container",
          "aside",
          "nav",
        ].join(", ")
      );
      const accountText = (accountSection as BrowserTextElement | null)?.textContent?.toUpperCase() || "";
      const allText = browser.document.body.innerText.toUpperCase();

      const hasTierLabel = (text: string, tier: "FREE" | "PLUS" | "PRO" | "ULTRA") => {
        const escapedTier = tier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escapedTier}\\b\\s*PLAN\\b|\\bPLAN\\b\\s*${escapedTier}\\b`).test(text);
      };

      // ── Signal 1: explicit tier badges / text ──────────────────────────────
      // Tier labels are only trusted inside account/subscription UI. Whole-page
      // text can contain upgrade marketing like "Try Ultra", which is not a
      // reliable signal for the current account tier.
      if (hasTierLabel(accountText, "ULTRA")) return "ultra";

      // NotebookLM Pro was rebranded to "NotebookLM Plus" / "One AI Premium"
      if (
        accountText.includes("NOTEBOOKLM PLUS") ||
        accountText.includes("ONE AI PREMIUM") ||
        accountText.includes("GOOGLE ONE AI") ||
        accountText.includes("AI PREMIUM") ||
        hasTierLabel(accountText, "PLUS") ||
        hasTierLabel(accountText, "PRO")
      ) {
        return "pro";
      }

      // Legacy "PRO" badge (some accounts still show this)
      const proBadge = browser.document.querySelector(".pro-badge, [data-tier='pro']");
      if (proBadge) return "pro";

      // ── Signal 2: infer from source limit shown anywhere on the page ───────
      // NotebookLM renders "X / 300" or "X/300" next to the source list.
      // This is the most reliable signal available without opening a dialog.
      const limitMatch = browser.document.body.innerText.match(/\b(\d+)\s*\/\s*(50|300|600)\b/);
      if (limitMatch) {
        const limit = parseInt(limitMatch[2], 10);
        if (limit >= 600) return "ultra";
        if (limit >= 300) return "pro";
        if (limit <= 50)  return "free";
      }

      // ── Signal 3: upgrade prompts mean free tier ───────────────────────────
      if (
        allText.includes("UPGRADE TO NOTEBOOKLM PLUS") ||
        (allText.includes("UPGRADE") && !allText.includes("PRO") && !allText.includes("PLUS") && !allText.includes("ULTRA"))
      ) {
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
    const limitInfo = await this.evaluateWithTimeout(page, () => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      // Look for the "X / Y" source-count pattern, but ONLY accept a KNOWN
      // source limit (50/300/600). A broad /\d+\/\d+/ matches any unrelated
      // fraction on the page (timestamps, "3/5 steps", etc.), which previously
      // let an arbitrary number through as the source limit and misdetected the
      // tier upward. Mirror the whitelist used by detectTierFromPage.
      const allText = browser.document.body.innerText;
      const match = allText.match(/\b(\d+)\s*\/\s*(50|300|600)\b/);
      if (match) {
        return parseInt(match[2], 10); // Return the whitelisted limit (Y in X/Y)
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

    const usageInfo = await this.evaluateWithTimeout(page, () => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const allText = browser.document.body.innerText;

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
    const isRateLimited = await this.evaluateWithTimeout(page, () => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      const allText = browser.document.body.innerText.toLowerCase();
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
    const count = await this.evaluateWithTimeout(page, () => {
      const browser = globalThis as unknown as BrowserDocumentContext;
      // Strategy 1: Grid view project-button cards
      const projectButtons = Array.from(browser.document.querySelectorAll("project-button"));
      if (projectButtons.length > 0) {
        return projectButtons.length;
      }

      // Strategy 2: project-action-button (one per notebook in both views)
      const actionButtons = Array.from(browser.document.querySelectorAll("project-action-button"));
      if (actionButtons.length > 0) {
        return actionButtons.length;
      }

      // Strategy 3: Table rows with "Source" text (legacy UI)
      const rows = Array.from(browser.document.querySelectorAll("tr")) as BrowserTextElement[];
      let count = 0;
      for (const row of rows) {
        if (row.textContent?.includes("Source")) {
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
      // If tier still unknown, infer it from the source limit
      if (this.settings.tier === "unknown") {
        if (sourceLimit >= 600) {
          this.settings.tier = "ultra";
          this.settings.limits = { ...TIER_LIMITS.ultra, sourcesPerNotebook: sourceLimit };
          this.settings.autoDetected = true;
          log.info(`  Inferred tier=ultra from source limit ${sourceLimit}`);
        } else if (sourceLimit >= 300) {
          this.settings.tier = "pro";
          this.settings.limits = { ...TIER_LIMITS.pro, sourcesPerNotebook: sourceLimit };
          this.settings.autoDetected = true;
          log.info(`  Inferred tier=pro from source limit ${sourceLimit}`);
        } else if (sourceLimit <= 50) {
          this.settings.tier = "free";
          this.settings.limits = { ...TIER_LIMITS.free, sourcesPerNotebook: sourceLimit };
          this.settings.autoDetected = true;
          log.info(`  Inferred tier=free from source limit ${sourceLimit}`);
        }
      }
    }

    // Try to extract query usage from UI
    const queryUsage = await this.extractQueryUsageFromUI(page);
    if (queryUsage) {
      // Update local tracking with Google's numbers.
      this.settings.usage.queriesUsedToday = Math.min(queryUsage.used, MAX_REASONABLE_QUERIES);
      // Scraped page numbers are untrusted: a spoofed/injected page (e.g.
      // "0/999999") must never raise the enforced daily limit above the
      // documented value for the detected tier. Treat the scraped limit only as
      // a hint and clamp it to the tier's authoritative ceiling.
      const tierCeiling = deriveLimitsForTier(this.settings.tier).queriesPerDay;
      this.settings.limits.queriesPerDay = Math.min(Math.max(1, queryUsage.limit), tierCeiling);
      this.settings.usage.lastQueryDate = new Date().toISOString().split("T")[0];
      log.info(`  Synced query usage from Google: ${this.settings.usage.queriesUsedToday}/${this.settings.limits.queriesPerDay}`);
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
   * Manually set tier (for user override).
   *
   * Records a ChangeLog entry for SOC2 change-management audit trail.
   */
  async setTier(tier: LicenseTier): Promise<void> {
    const oldTier = this.settings.tier;
    if (oldTier === tier) {
      log.info(`📊 Tier already: ${tier} (no change)`);
      return;
    }
    this.settings.tier = tier;
    this.settings.limits = TIER_LIMITS[tier];
    this.settings.autoDetected = false;
    this.saveSettings();
    log.info(`📊 Tier set to: ${tier}`);

    try {
      const { getChangeLog } = await import("../compliance/change-log.js");
      await getChangeLog().recordChange("quota", "tier", oldTier, tier, {
        changedBy: "user",
        method: "api",
        impact: "medium",
        affectedCompliance: ["SOC2"],
      });
    } catch (err) {
      log.warning(`ChangeLog recordChange failed (quota.tier): ${err instanceof Error ? err.message : String(err)}`);
    }
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
   *
   * Uses the same withLock(settingsPath) transaction as
   * incrementQueryCountAtomic (reload-under-lock → increment → persist) so the
   * notebook counter shares ONE concurrency mechanism with the query counters
   * (no separate ad-hoc promise queue). The lock provides mutual exclusion and
   * the reload-under-lock prevents lost updates across concurrent callers;
   * strict FIFO ordering is not required for a counter.
   *
   * Fail-soft contract preserved: this method logs and resolves on error rather
   * than rejecting, since external callers may not catch.
   */
  async incrementNotebookCount(): Promise<void> {
    try {
      await withLock(this.settingsPath, async () => {
        this.settings = this.loadSettings();
        this.settings.usage.notebooks++;
        this.settings.usage.lastUpdated = new Date().toISOString();
        this.saveSettings();
      });
    } catch (error) {
      log.error(`❌ Could not increment notebook count: ${error}`);
    }
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
    this.updateQuotaMetrics();
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
      this.updateQuotaMetrics();

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
        throw error; // Rethrow so caller knows the atomic increment failed (I289)
      }
    });
  }

  /**
   * Atomically check the daily quota and reserve (increment) a slot in a single
   * locked, disk-reloaded transaction.
   *
   * This closes the TOCTOU window where concurrent sessions/processes all pass a
   * stale in-memory check (canMakeQuery) and then increment only after the slow
   * browser query completes, collectively exceeding the daily limit. The slot is
   * reserved up front, BEFORE the query runs.
   *
   * Returns { allowed, reason? }. Callers MUST run the query only when allowed,
   * and call releaseReservation() if the query subsequently fails.
   */
  async checkAndReserveQuery(): Promise<{ allowed: boolean; reason?: string }> {
    return await withLock(this.settingsPath, async () => {
      // Reload latest settings from disk (another process may have updated).
      this.settings = this.loadSettings();

      const today = new Date().toISOString().split("T")[0];

      // Reset if new day (mirror incrementQueryCountAtomic rollover idiom).
      if (this.settings.usage.lastQueryDate !== today) {
        this.settings.usage.queriesUsedToday = 0;
        this.settings.usage.lastQueryDate = today;
      }

      // CRUCIAL: derive the limit from the tier table, never trust on-disk limit.
      const limit = deriveLimitsForTier(this.settings.tier).queriesPerDay;

      if (this.settings.usage.queriesUsedToday >= limit) {
        getMetricsRegistry().increment("quota_query_denials_total", { tier: this.settings.tier });
        this.updateQuotaMetrics();
        return {
          allowed: false,
          reason: `Daily query limit reached (${this.settings.usage.queriesUsedToday}/${limit}). Try again tomorrow or upgrade your plan.`,
        };
      }

      // Reserve the slot now, before the query runs.
      this.settings.usage.queriesUsedToday += 1;
      this.settings.usage.lastUpdated = new Date().toISOString();
      this.updateQuotaMetrics();
      this.persistWithLockHeld();

      return { allowed: true };
    });
  }

  /**
   * Release a previously reserved query slot (e.g. when the query failed after
   * reservation in checkAndReserveQuery). Atomic and floored at zero so it can
   * never underflow.
   */
  async releaseReservation(): Promise<void> {
    await withLock(this.settingsPath, async () => {
      this.settings = this.loadSettings();
      this.settings.usage.queriesUsedToday = Math.max(0, this.settings.usage.queriesUsedToday - 1);
      this.settings.usage.lastUpdated = new Date().toISOString();
      this.updateQuotaMetrics();
      this.persistWithLockHeld();
    });
  }

  /**
   * Persist current settings to disk while a file lock is already held.
   * Mirrors the write performed inside incrementQueryCountAtomic.
   */
  private persistWithLockHeld(): void {
    const dir = path.dirname(this.settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(
      this.settingsPath,
      JSON.stringify(this.settings, null, 2),
      { mode: 0o600 }
    );
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
    // Pure read: determine effective count without mutating settings.
    // Rollover mutation is handled exclusively in incrementQueryCountAtomic (I285).
    const queriesUsedToday = this.effectiveQueriesUsedToday();

    const { queriesPerDay: limit } = this.settings.limits;

    if (queriesUsedToday >= limit) {
      getMetricsRegistry().increment("quota_query_denials_total", { tier: this.settings.tier });
      this.updateQuotaMetrics(queriesUsedToday);
      return {
        allowed: false,
        reason: `Daily query limit reached (${queriesUsedToday}/${limit}). Try again tomorrow or upgrade your plan.`,
      };
    }

    // Warn if approaching limit
    if (queriesUsedToday >= limit * 0.8) {
      log.warning(`⚠️ Approaching daily query limit: ${queriesUsedToday}/${limit}`);
    }

    this.updateQuotaMetrics(queriesUsedToday);

    return { allowed: true };
  }

  private updateQuotaMetrics(queriesUsedToday = this.effectiveQueriesUsedToday()): void {
    const { tier, limits } = this.settings;
    const registry = getMetricsRegistry();
    registry.setGauge("quota_queries_used", queriesUsedToday, { tier });
    registry.setGauge("quota_queries_limit", limits.queriesPerDay, { tier });
    registry.setGauge("quota_queries_percent", QuotaManager.safePercent(queriesUsedToday, limits.queriesPerDay), { tier });
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
    // Use the effective (rolled-over) count so getStatus never reports a stale
    // pre-rollover figure; guard all percentages against a zero/invalid limit.
    const queriesUsedToday = this.effectiveQueriesUsedToday();

    return {
      tier,
      notebooks: {
        used: usage.notebooks,
        limit: limits.notebooks,
        percent: QuotaManager.safePercent(usage.notebooks, limits.notebooks),
      },
      sources: {
        limit: limits.sourcesPerNotebook,
      },
      queries: {
        used: queriesUsedToday,
        limit: limits.queriesPerDay,
        percent: QuotaManager.safePercent(queriesUsedToday, limits.queriesPerDay),
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
    // Pure read of the effective (rolled-over) count — consistent with
    // getStatus/canMakeQuery. Rollover is NOT persisted here; that is the
    // exclusive responsibility of incrementQueryCountAtomic/checkAndReserveQuery
    // (I285), so this reader no longer mutates+persists the rollover.
    const { tier, limits, usage } = this.settings;
    const queriesUsedToday = this.effectiveQueriesUsedToday();

    const queriesRemaining = limits.queriesPerDay - queriesUsedToday;
    const queriesPercentUsed = QuotaManager.safePercent(queriesUsedToday, limits.queriesPerDay);
    const notebooksRemaining = limits.notebooks - usage.notebooks;
    const notebooksPercentUsed = QuotaManager.safePercent(usage.notebooks, limits.notebooks);

    // Calculate next reset time (midnight local time)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    // Build warnings list
    const warnings: string[] = [];

    if (queriesRemaining <= 0) {
      warnings.push(`CRITICAL: Daily query limit reached (${queriesUsedToday}/${limits.queriesPerDay}). Wait until tomorrow or upgrade your plan.`);
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
        used: queriesUsedToday,
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
