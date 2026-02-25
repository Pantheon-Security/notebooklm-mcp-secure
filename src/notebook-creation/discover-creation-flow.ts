/**
 * Discover Creation Flow
 *
 * Walks through the notebook creation flow step by step,
 * dumping UI elements at each stage to find the correct selectors.
 */

import { AuthManager } from "../auth/auth-manager.js";
import { SharedContextManager } from "../session/shared-context-manager.js";
import { log } from "../utils/logger.js";
import type { Page } from "patchright";

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";

interface ElementInfo {
  tag: string;
  text: string;
  classes: string;
  id: string;
  ariaLabel: string;
  role: string;
  type: string;
  placeholder: string;
  dataAttrs: Record<string, string>;
}

async function dumpElements(page: Page, description: string): Promise<ElementInfo[]> {
  log.info(`\n📋 ${description}:`);

  const elements = await page.evaluate(() => {
    const results: any[] = [];
    // @ts-expect-error - DOM types
    const els = document.querySelectorAll('button, input, textarea, [role="button"], [role="menuitem"], [role="option"], [role="tab"], a, [contenteditable="true"]');

    for (const el of els) {
      const text = (el as any).textContent?.trim().substring(0, 50) || "";
      // Skip empty or icon-only elements
      if (!text && !(el as any).getAttribute("aria-label")) continue;

      results.push({
        tag: el.tagName,
        text: text,
        classes: (el as any).className?.substring?.(0, 100) || "",
        id: (el as any).id || "",
        ariaLabel: (el as any).getAttribute("aria-label") || "",
        role: (el as any).getAttribute("role") || "",
        type: (el as any).getAttribute("type") || "",
        placeholder: (el as any).getAttribute("placeholder") || "",
        dataAttrs: Object.fromEntries(
          Array.from((el as any).attributes || [])
            .filter((a: any) => a.name.startsWith("data-"))
            .map((a: any) => [a.name, a.value?.substring(0, 50)])
        ),
      });
    }
    return results;
  });

  // Log interesting elements
  for (const el of elements) {
    const info = [];
    if (el.text) info.push(`"${el.text}"`);
    if (el.ariaLabel) info.push(`aria="${el.ariaLabel}"`);
    if (el.role) info.push(`role=${el.role}`);
    if (el.type) info.push(`type=${el.type}`);
    if (el.placeholder) info.push(`placeholder="${el.placeholder}"`);
    if (el.id) info.push(`id=${el.id}`);

    if (info.length > 0) {
      log.dim(`  ${el.tag}: ${info.join(", ")}`);
    }
  }

  return elements;
}

async function findAndClick(page: Page, textPatterns: string[], description: string): Promise<boolean> {
  log.info(`\n🖱️ Looking for: ${description}`);

  for (const pattern of textPatterns) {
    const clicked = await page.evaluate((p) => {
      // @ts-expect-error - DOM types
      const els = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"], a');
      for (const el of els) {
        const text = (el as any).textContent?.toLowerCase() || "";
        const aria = (el as any).getAttribute("aria-label")?.toLowerCase() || "";
        if (text.includes(p.toLowerCase()) || aria.includes(p.toLowerCase())) {
          (el as any).click();
          return true;
        }
      }
      return false;
    }, pattern);

    if (clicked) {
      log.success(`  ✅ Clicked element with "${pattern}"`);
      await page.waitForTimeout(2000);
      return true;
    }
  }

  log.warning(`  ⚠️ Could not find element matching: ${textPatterns.join(", ")}`);
  return false;
}

async function main() {
  log.info("🔍 Starting Creation Flow Discovery...\n");

  const authManager = new AuthManager();
  const contextManager = new SharedContextManager(authManager);

  try {
    // Get browser context with visible window
    const context = await contextManager.getOrCreateContext();

    // Check auth
    const isAuth = await authManager.validateCookiesExpiry(context);
    if (!isAuth) {
      log.error("❌ Not authenticated. Run setup_auth first.");
      return;
    }

    const page = await context.newPage();

    // Step 1: Navigate to NotebookLM
    log.info("📍 Step 1: Navigate to NotebookLM homepage");
    await page.goto(NOTEBOOKLM_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);

    await dumpElements(page, "Homepage elements");

    // Step 2: Click "Create new" or "New notebook"
    log.info("\n📍 Step 2: Click to create new notebook");
    const createClicked = await findAndClick(page, ["Create new", "New notebook", "Create", "New"], "Create new notebook button");

    if (createClicked) {
      await page.waitForTimeout(3000);
      await dumpElements(page, "After clicking Create - looking for name input");

      // Check current URL - might have navigated to notebook
      log.info(`  Current URL: ${page.url()}`);
    }

    // Step 3: Look for name input or skip if auto-created
    log.info("\n📍 Step 3: Look for notebook name input");
    const inputs = await page.evaluate(() => {
      // @ts-expect-error - DOM types
      const els = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      return Array.from(els).map((el: any) => ({
        tag: el.tagName,
        type: el.type,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute("aria-label"),
        value: el.value,
        classes: el.className?.substring(0, 100),
      }));
    });
    log.info("  Input elements found:");
    for (const inp of inputs) {
      log.dim(`    ${inp.tag}: type=${inp.type}, placeholder="${inp.placeholder}", aria="${inp.ariaLabel}"`);
    }

    // Step 4: Find "Add source" button
    log.info("\n📍 Step 4: Look for Add source button");
    await dumpElements(page, "Looking for Add source");

    const addSourceClicked = await findAndClick(page, ["Add source", "Add", "+"], "Add source button");

    if (addSourceClicked) {
      await page.waitForTimeout(2000);
      await dumpElements(page, "After clicking Add source - source type options");
    }

    // Step 5: Look for source type options (URL, File, Text)
    log.info("\n📍 Step 5: Look for URL/Website source option");
    const urlClicked = await findAndClick(page, ["Website", "URL", "Link", "Web"], "URL source option");

    if (urlClicked) {
      await page.waitForTimeout(2000);
      await dumpElements(page, "After selecting URL - looking for input field");

      // Specifically look for input fields
      const urlInputs = await page.evaluate(() => {
        // @ts-expect-error - DOM types
        const els = document.querySelectorAll('input[type="url"], input[type="text"], input:not([type]), textarea');
        return Array.from(els).map((el: any) => ({
          tag: el.tagName,
          type: el.type,
          placeholder: el.placeholder,
          ariaLabel: el.getAttribute("aria-label"),
          classes: el.className?.substring(0, 100),
          visible: el.offsetParent !== null,
        }));
      });
      log.info("  URL Input candidates:");
      for (const inp of urlInputs) {
        if (inp.visible) {
          log.dim(`    ${inp.tag}: type=${inp.type}, placeholder="${inp.placeholder}", aria="${inp.ariaLabel}"`);
        }
      }
    }

    // Keep browser open for manual inspection
    log.info("\n✅ Discovery complete. Browser will stay open for 60 seconds for manual inspection.");
    await page.waitForTimeout(60000);

  } catch (error) {
    log.error(`❌ Error: ${error}`);
  } finally {
    await contextManager.closeContext();
  }
}

main().catch(console.error);
