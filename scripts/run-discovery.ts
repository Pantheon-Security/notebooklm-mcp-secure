#!/usr/bin/env node
/**
 * Run NotebookLM UI Selector Discovery
 *
 * This script launches a browser, navigates NotebookLM's interface,
 * and discovers CSS selectors for notebook creation elements.
 *
 * Usage: npx tsx scripts/run-discovery.ts
 */

import { AuthManager } from "../src/auth/auth-manager.js";
import { SharedContextManager } from "../src/session/shared-context-manager.js";
import { discoverSelectors } from "./selector-discovery.js";
import { log } from "../src/utils/logger.js";
import { CONFIG } from "../src/config.js";
import fs from "fs";
import path from "path";

async function main() {
  log.info("🚀 Starting NotebookLM UI Selector Discovery");
  log.info("   This will open a browser and analyze the NotebookLM interface.");
  log.info("");

  // Initialize managers
  const authManager = new AuthManager();
  const contextManager = new SharedContextManager(authManager);

  try {
    // Get browser context (visible for debugging)
    log.info("🌐 Getting browser context (visible mode)...");
    const context = await contextManager.getOrCreateContext(false); // false = show browser

    // Check authentication
    log.info("🔐 Checking authentication...");
    const isAuthenticated = await authManager.validateCookiesExpiry(context);

    if (!isAuthenticated) {
      log.warning("⚠️ Not authenticated or session expired!");
      log.warning("   Please login first using setup_auth tool.");
      log.info("   Run the MCP server and use the setup_auth tool.");
      process.exit(1);
    }

    log.success("✅ Authenticated!");

    // Run discovery
    log.info("\n🔍 Running selector discovery...\n");
    const result = await discoverSelectors(context);

    // Save results to file
    const outputPath = path.join(CONFIG.dataDir, "discovered-selectors.json");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    log.success(`\n✅ Discovery complete! Results saved to: ${outputPath}`);

    // Generate selectors.ts content
    if (Object.keys(result.selectors).length > 0) {
      const selectorsCode = generateSelectorsCode(result);
      const selectorsPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "../src/notebook-creation/selectors.ts"
      );
      fs.writeFileSync(selectorsPath, selectorsCode);
      log.success(`📝 Generated selectors.ts at: ${selectorsPath}`);
    }

    // Print summary
    printSummary(result);

  } catch (error) {
    log.error(`❌ Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    // Keep browser open briefly for inspection
    log.info("\n⏳ Keeping browser open for 5 seconds for inspection...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await contextManager.closeContext();
    log.info("👋 Done!");
  }
}

/**
 * Generate selectors.ts code from discovery results
 */
function generateSelectorsCode(result: Awaited<ReturnType<typeof discoverSelectors>>): string {
  const lines: string[] = [
    '/**',
    ' * NotebookLM UI Selectors',
    ' *',
    ` * Auto-generated on ${result.discoveredAt}`,
    ' * by selector-discovery.ts',
    ' *',
    ' * These selectors are used for notebook creation automation.',
    ' */',
    '',
    'export const NOTEBOOKLM_SELECTORS = {',
  ];

  for (const [key, info] of Object.entries(result.selectors)) {
    if (info && typeof info === 'object' && 'primary' in info) {
      const selectorInfo = info as { primary: string; fallbacks: string[]; description: string; confirmed: boolean };
      lines.push(`  /** ${selectorInfo.description} */`);
      lines.push(`  ${key}: {`);
      lines.push(`    primary: ${JSON.stringify(selectorInfo.primary)},`);
      lines.push(`    fallbacks: ${JSON.stringify(selectorInfo.fallbacks)},`);
      lines.push(`    confirmed: ${selectorInfo.confirmed},`);
      lines.push(`  },`);
      lines.push('');
    }
  }

  lines.push('} as const;');
  lines.push('');
  lines.push('export type SelectorKey = keyof typeof NOTEBOOKLM_SELECTORS;');
  lines.push('');
  lines.push('/**');
  lines.push(' * Get selector with fallbacks');
  lines.push(' */');
  lines.push('export function getSelector(key: SelectorKey): string[] {');
  lines.push('  const info = NOTEBOOKLM_SELECTORS[key];');
  lines.push('  return [info.primary, ...info.fallbacks].filter(Boolean);');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * Print discovery summary
 */
function printSummary(result: Awaited<ReturnType<typeof discoverSelectors>>): void {
  log.info("\n" + "=".repeat(60));
  log.info("📊 DISCOVERY SUMMARY");
  log.info("=".repeat(60));

  const found: string[] = [];
  const notFound: string[] = [];

  for (const [key, info] of Object.entries(result.selectors)) {
    if (info && typeof info === 'object' && 'primary' in info) {
      const selectorInfo = info as { primary: string };
      if (selectorInfo.primary) {
        found.push(key);
      } else {
        notFound.push(key);
      }
    }
  }

  log.info(`\n✅ Found (${found.length}):`);
  for (const key of found) {
    log.info(`   - ${key}`);
  }

  if (notFound.length > 0) {
    log.warning(`\n⚠️ Not Found (${notFound.length}):`);
    for (const key of notFound) {
      log.warning(`   - ${key}`);
    }
  }

  log.info("\n" + "=".repeat(60));

  if (notFound.length > 0) {
    log.info("\n💡 Manual inspection may be needed for missing selectors.");
    log.info("   The browser was kept open briefly for visual inspection.");
  }
}

// Run main
main().catch((error) => {
  log.error(`Fatal error: ${error}`);
  process.exit(1);
});
