/**
 * Discover Source Management UI Elements
 *
 * Finds selectors for listing, adding, and removing sources in NotebookLM.
 * Run: node dist/notebook-creation/discover-sources.js
 */

import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import type { Page } from "patchright";

// Use a notebook URL with existing sources for discovery
const TEST_NOTEBOOK_URL = process.env.TEST_NOTEBOOK_URL || "";

interface SourceElementInfo {
  selector: string;
  text: string;
  ariaLabel: string;
  classes: string;
  tag: string;
  dataAttrs: Record<string, string>;
}

// Future: Interface for discovered selectors (when UI discovery is complete)
// interface DiscoveredSourceSelectors {
//   sourceListContainer: string | null;
//   sourceItems: string[];
//   sourceTitle: string | null;
//   sourceDeleteButton: string | null;
//   sourceOptionsMenu: string | null;
//   sourceCount: string | null;
// }

async function dumpSourceElements(page: Page): Promise<SourceElementInfo[]> {
  return await page.evaluate(() => {
    const results: any[] = [];

    // Look for source-related elements
    // @ts-expect-error - DOM types
    const allElements = document.querySelectorAll("*");

    for (const el of allElements) {
      const text = (el as any).textContent?.trim().substring(0, 100) || "";
      const ariaLabel = (el as any).getAttribute("aria-label") || "";
      const classes = (el as any).className || "";
      const tag = el.tagName;

      // Skip if no useful info
      if (!text && !ariaLabel && !classes) continue;

      // Look for source-related patterns
      const patterns = [
        /source/i,
        /document/i,
        /upload/i,
        /file/i,
        /delete/i,
        /remove/i,
        /trash/i,
        /more.*options/i,
        /\d+\s*(source|file|document)/i,
      ];

      const isRelevant = patterns.some(
        (p) => p.test(text) || p.test(ariaLabel) || p.test(classes)
      );

      if (isRelevant && text.length < 200) {
        // Get data attributes
        const dataAttrs: Record<string, string> = {};
        for (const attr of Array.from(el.attributes) as { name: string; value: string }[]) {
          if (attr.name.startsWith("data-")) {
            dataAttrs[attr.name] = attr.value;
          }
        }

        results.push({
          selector: el.id ? `#${el.id}` : `.${(classes as string).split(" ")[0]}`,
          text: text.substring(0, 100),
          ariaLabel,
          classes: (classes as string).substring(0, 100),
          tag,
          dataAttrs,
        });
      }
    }

    return results;
  });
}

async function findSourceListElements(page: Page): Promise<void> {
  log.info("\n📋 Looking for source list elements...");

  // Look for the sources panel/sidebar
  const sourceElements = await page.evaluate(() => {
    const results: any[] = [];

    // Common patterns for source lists
    const listSelectors = [
      '[class*="source-list"]',
      '[class*="sources-panel"]',
      '[class*="sidebar"]',
      '[role="list"]',
      '[role="listbox"]',
      "mat-list",
      "mat-nav-list",
    ];

    for (const selector of listSelectors) {
      // @ts-expect-error - DOM types
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = (el as any).textContent?.substring(0, 200) || "";
        if (text.toLowerCase().includes("source")) {
          results.push({
            selector,
            childCount: el.children.length,
            text: text.substring(0, 100),
          });
        }
      }
    }

    return results;
  });

  for (const item of sourceElements) {
    log.dim(`  Found: ${item.selector} (${item.childCount} children)`);
    log.dim(`    Text: "${item.text}"`);
  }
}

async function findSourceItems(page: Page): Promise<void> {
  log.info("\n📋 Looking for individual source items...");

  const items = await page.evaluate(() => {
    const results: any[] = [];

    // Look for list items that might be sources
    // @ts-expect-error - DOM types
    const listItems = document.querySelectorAll(
      'mat-list-item, [role="listitem"], .source-item, [class*="source"]'
    );

    for (const item of listItems) {
      const text = (item as any).textContent?.trim().substring(0, 100) || "";
      const classes = (item as any).className || "";

      // Skip if it's clearly not a source item
      if (text.toLowerCase().includes("add") && text.length < 20) continue;

      results.push({
        tag: item.tagName,
        classes: (classes as string).substring(0, 80),
        text,
        hasCheckbox: !!(item as any).querySelector('input[type="checkbox"], mat-checkbox'),
        hasDeleteBtn: !!(item as any).querySelector(
          '[aria-label*="delete" i], [aria-label*="remove" i], button[class*="delete"]'
        ),
        hasOptionsBtn: !!(item as any).querySelector(
          '[aria-label*="more" i], [aria-label*="option" i], button[class*="menu"]'
        ),
      });
    }

    return results;
  });

  for (const item of items) {
    log.dim(`  [${item.tag}] "${item.text}"`);
    log.dim(`    Classes: ${item.classes}`);
    log.dim(
      `    Has: checkbox=${item.hasCheckbox}, delete=${item.hasDeleteBtn}, options=${item.hasOptionsBtn}`
    );
  }
}

async function findDeleteButtons(page: Page): Promise<void> {
  log.info("\n📋 Looking for delete/remove buttons...");

  const buttons = await page.evaluate(() => {
    const results: any[] = [];

    // @ts-expect-error - DOM types
    const allButtons = document.querySelectorAll("button, [role='button']");

    for (const btn of allButtons) {
      const ariaLabel = (btn as any).getAttribute("aria-label") || "";
      const text = (btn as any).textContent?.trim() || "";
      const classes = (btn as any).className || "";

      const isDelete =
        /delete|remove|trash|discard/i.test(ariaLabel) ||
        /delete|remove|trash|discard/i.test(text) ||
        /delete|remove|trash/i.test(classes);

      if (isDelete) {
        results.push({
          tag: btn.tagName,
          ariaLabel,
          text: text.substring(0, 50),
          classes: (classes as string).substring(0, 80),
        });
      }
    }

    return results;
  });

  for (const btn of buttons) {
    log.dim(`  [${btn.tag}] aria="${btn.ariaLabel}" text="${btn.text}"`);
    log.dim(`    Classes: ${btn.classes}`);
  }
}

async function findSourceCount(page: Page): Promise<void> {
  log.info("\n📋 Looking for source count indicator...");

  const counts = await page.evaluate(() => {
    const results: any[] = [];

    // Look for "X sources" or "X/Y" patterns
    // @ts-expect-error - DOM types
    const allText = document.body.innerText;
    const matches = allText.match(/(\d+)\s*(source|file|document)s?/gi) || [];

    // Also look for specific elements
    // @ts-expect-error - DOM types
    const spans = document.querySelectorAll("span, div, p");
    for (const el of spans) {
      const text = (el as any).textContent?.trim() || "";
      if (/^\d+\s*(source|file|document)s?$/i.test(text) || /^\d+\s*\/\s*\d+$/.test(text)) {
        results.push({
          tag: el.tagName,
          text,
          classes: ((el as any).className || "").substring(0, 80),
        });
      }
    }

    return { textMatches: matches, elements: results };
  });

  log.dim(`  Text matches: ${counts.textMatches.join(", ") || "none"}`);
  for (const el of counts.elements) {
    log.dim(`  [${el.tag}] "${el.text}" class="${el.classes}"`);
  }
}

async function main() {
  log.info("🔍 Discovering Source Management UI Elements...\n");

  if (!TEST_NOTEBOOK_URL) {
    log.warning("⚠️  No TEST_NOTEBOOK_URL environment variable set.");
    log.warning("   Set it to a notebook URL with existing sources:");
    log.warning("   TEST_NOTEBOOK_URL=https://notebooklm.google.com/notebook/xxx node dist/notebook-creation/discover-sources.js");
    log.warning("\n   Continuing without URL - will navigate to homepage first...\n");
  }

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

    // Navigate to notebook or homepage
    const url = TEST_NOTEBOOK_URL || "https://notebooklm.google.com/";
    log.info(`📍 Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);

    // If on homepage, try to click on first notebook
    if (!TEST_NOTEBOOK_URL) {
      log.info("📍 Looking for a notebook to open...");
      const clicked = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const rows = document.querySelectorAll("tr");
        for (const row of rows) {
          if ((row as any).textContent?.includes("Source")) {
            (row as any).click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        log.success("  ✅ Clicked on a notebook");
        await page.waitForTimeout(3000);
      } else {
        log.warning("  ⚠️ No notebooks found to click");
      }
    }

    // Run discovery
    log.info("\n=== Source UI Discovery ===\n");

    // 1. Dump all source-related elements
    log.info("📋 All source-related elements:");
    const allElements = await dumpSourceElements(page);
    for (const el of allElements.slice(0, 20)) {
      log.dim(`  [${el.tag}] "${el.text}" aria="${el.ariaLabel}"`);
    }
    if (allElements.length > 20) {
      log.dim(`  ... and ${allElements.length - 20} more`);
    }

    // 2. Find source list container
    await findSourceListElements(page);

    // 3. Find individual source items
    await findSourceItems(page);

    // 4. Find delete buttons
    await findDeleteButtons(page);

    // 5. Find source count
    await findSourceCount(page);

    // Take a screenshot for reference
    const screenshotPath = "/tmp/notebooklm-sources-discovery.png";
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log.info(`\n📸 Screenshot saved: ${screenshotPath}`);

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
