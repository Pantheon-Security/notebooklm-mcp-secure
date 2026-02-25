/**
 * Discover Quota/License UI Elements
 *
 * Finds where license tier and usage limits are displayed in NotebookLM.
 * Run: node dist/notebook-creation/discover-quota.js
 */

import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import type { Page } from "patchright";

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

interface QuotaInfo {
  tier: string | null;
  notebookCount: number | null;
  notebookLimit: number | null;
  sourceLimit: number | null;
  sourcesUsed: number | null;
  queryLimit: number | null;
  queriesUsed: number | null;
  rawTexts: string[];
}

async function findQuotaElements(page: Page, description: string): Promise<void> {
  log.info(`\n📋 ${description}:`);

  // Look for quota-related text patterns
  const quotaInfo = await page.evaluate(() => {
    const results: string[] = [];

    // Get all text content and look for quota patterns
    // @ts-expect-error - DOM types
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      const text = (el as any).textContent?.trim() || "";

      // Skip very long text (likely containers)
      if (text.length > 200) continue;

      // Look for quota-related patterns
      const patterns = [
        /pro/i,
        /free/i,
        /limit/i,
        /\d+\s*\/\s*\d+/,  // X/Y format
        /source/i,
        /notebook/i,
        /quota/i,
        /usage/i,
        /upgrade/i,
        /plan/i,
        /subscription/i,
      ];

      for (const pattern of patterns) {
        if (pattern.test(text) && text.length < 100) {
          // Get more context
          const tag = el.tagName;
          const className = (el as any).className?.substring?.(0, 50) || "";
          const ariaLabel = (el as any).getAttribute("aria-label") || "";

          results.push(`[${tag}] "${text}" class="${className}" aria="${ariaLabel}"`);
          break;
        }
      }
    }

    // Deduplicate
    return [...new Set(results)];
  });

  for (const item of quotaInfo) {
    log.dim(`  ${item}`);
  }
}

async function extractQuotaFromHomepage(page: Page): Promise<Partial<QuotaInfo>> {
  log.info("\n🔍 Extracting quota info from homepage...");

  const info = await page.evaluate(() => {
    const result: any = { rawTexts: [] };

    // Look for PRO/FREE badge
    // @ts-expect-error - DOM types
    const allText = document.body.innerText;

    if (allText.includes("PRO")) {
      result.tier = "pro";
    } else if (allText.match(/free\s*(tier|plan|account)/i)) {
      result.tier = "free";
    }

    // Count notebooks in the table
    // @ts-expect-error - DOM types
    const rows = document.querySelectorAll('tr');
    let notebookCount = 0;
    for (const row of rows) {
      if ((row as any).textContent?.includes("Source")) {
        notebookCount++;
      }
    }
    if (notebookCount > 0) {
      result.notebookCount = notebookCount;
    }

    // Look for X/Y patterns (like "0/300")
    const limitMatches = allText.match(/(\d+)\s*\/\s*(\d+)/g) || [];
    result.rawTexts = limitMatches;

    return result;
  });

  log.info(`  Tier: ${info.tier || "unknown"}`);
  log.info(`  Notebook count: ${info.notebookCount || "unknown"}`);
  log.info(`  Limit patterns found: ${info.rawTexts?.join(", ") || "none"}`);

  return info;
}

async function checkSettingsPage(page: Page): Promise<void> {
  log.info("\n📋 Checking Settings for quota info...");

  // Try to click Settings button
  const settingsClicked = await page.evaluate(() => {
    // @ts-expect-error - DOM types
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const aria = (btn as any).getAttribute("aria-label")?.toLowerCase() || "";
      const text = (btn as any).textContent?.toLowerCase() || "";
      if (aria.includes("settings") || text.includes("settings")) {
        (btn as any).click();
        return true;
      }
    }
    return false;
  });

  if (settingsClicked) {
    log.success("  ✅ Clicked Settings button");
    await page.waitForTimeout(2000);
    await findQuotaElements(page, "Settings dialog elements");
  } else {
    log.warning("  ⚠️ Could not find Settings button");
  }
}

async function checkSourceDialog(page: Page): Promise<void> {
  log.info("\n📋 Checking Source Dialog for limits...");

  // Create a new notebook to see the source dialog
  const createClicked = await page.evaluate(() => {
    // @ts-expect-error - DOM types
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const aria = (btn as any).getAttribute("aria-label") || "";
      if (aria.includes("Create new notebook")) {
        (btn as any).click();
        return true;
      }
    }
    return false;
  });

  if (createClicked) {
    log.success("  ✅ Created new notebook");
    await page.waitForTimeout(3000);

    // Look for source limit indicator
    const sourceLimitInfo = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const spans = document.querySelectorAll('span');
      for (const span of spans) {
        const text = (span as any).textContent?.trim() || "";
        // Look for "X/Y" pattern near "Source"
        if (text.match(/\d+\s*\/\s*\d+/)) {
          return text;
        }
        if (text.toLowerCase().includes("source limit")) {
          return text;
        }
      }
      return null;
    });

    if (sourceLimitInfo) {
      log.success(`  ✅ Source limit indicator: "${sourceLimitInfo}"`);
    }

    await findQuotaElements(page, "Source dialog quota elements");
  }
}

async function main() {
  log.info("🔍 Discovering Quota/License UI Elements...\n");

  const authManager = new AuthManager();
  const contextManager = new SharedContextManager(authManager);

  try {
    const context = await contextManager.getOrCreateContext();
    const isAuth = await authManager.validateCookiesExpiry(context);

    if (!isAuth) {
      log.error("❌ Not authenticated. Run setup_auth first.");
      return;
    }

    const page = await context.newPage();

    // Navigate to NotebookLM homepage
    log.info("📍 Navigating to NotebookLM homepage...");
    await page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);

    // 1. Check homepage for quota info
    await findQuotaElements(page, "Homepage quota-related elements");
    await extractQuotaFromHomepage(page);

    // 2. Check Settings dialog
    await checkSettingsPage(page);

    // Close any dialog
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    // 3. Check source dialog in new notebook
    await checkSourceDialog(page);

    // Keep browser open for inspection
    log.info("\n✅ Discovery complete. Browser open for 60 seconds...");
    await page.waitForTimeout(60000);

  } catch (error) {
    log.error(`❌ Error: ${error}`);
  } finally {
    await contextManager.closeContext();
  }
}

main().catch(console.error);
