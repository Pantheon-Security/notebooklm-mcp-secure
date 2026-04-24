/**
 * Source Selection Filter (source_titles → checkbox state)
 *
 * Output-producing tools (generate_slides / generate_infographic /
 * generate_video_overview / generate_audio_overview / generate_data_table /
 * revise_slides / ask_question) accept an optional `source_titles: string[]`
 * parameter. When provided, the tool checks ONLY the matched sources before
 * producing output — mimicking a NotebookLM user who ticks specific source
 * checkboxes and then asks a question / generates an artifact.
 *
 * This helper:
 *   1. Resolves each title pattern to a single source index in the panel
 *      (case-insensitive substring match, 1 hit required per pattern).
 *   2. Applies the selection: uncheck all via the global "select-all"
 *      checkbox, then individually check the matched rows.
 *
 * NotebookLM persists checkbox state only at the client-Angular layer; a
 * page reload resets it to all-checked. Because these tools do
 * selection → action all within the same Page, the state is correctly
 * scoped to the current generation.
 *
 * DOM (April 2026, ja locale):
 *   Global: mat-checkbox.select-checkbox-all-sources
 *   Per row: .single-source-container mat-checkbox.select-checkbox
 *   Native input (the click target Angular listens to):
 *           input.mdc-checkbox__native-control inside each mat-checkbox.
 */

import type { Page } from "patchright";
import { log } from "../utils/logger.js";
import { randomDelay } from "../utils/stealth-utils.js";

export interface SourceFilterApplied {
  appliedIndices: number[];
  appliedTitles: string[];
  totalSources: number;
}

export class SourceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSelectionError";
  }
}

/**
 * Ensure the source panel is expanded so source rows and checkboxes exist.
 */
async function ensureSourcePanelExpanded(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    // @ts-expect-error - DOM types
    const panel = document.querySelector('section.source-panel') as any;
    if (!panel) return false;
    const cls = (panel.className || '').toString();
    const collapsed = cls.includes('panel-collaps');
    if (!collapsed) return true;
    // @ts-expect-error - DOM types
    const toggleBtn = document.querySelector('.toggle-source-panel-button, [class*="toggle-source-panel"]') as any;
    if (!toggleBtn) return false;
    toggleBtn.click();
    return true;
  });
}

/**
 * Enumerate all source rows currently visible in the panel, with titles.
 */
async function listSourceRows(page: Page): Promise<Array<{ index: number; title: string; checked: boolean }>> {
  return await page.evaluate(() => {
    // @ts-expect-error - DOM types
    const rows = document.querySelectorAll('.single-source-container');
    const out: Array<{ index: number; title: string; checked: boolean }> = [];
    rows.forEach((row: any, i: number) => {
      const title = (row.querySelector('.source-title')?.textContent ||
        row.querySelector('.source-stretched-button')?.getAttribute('aria-label') ||
        '').trim();
      const matCheckbox = row.querySelector('mat-checkbox.select-checkbox');
      const checked = matCheckbox?.classList?.contains('mat-mdc-checkbox-checked') || false;
      out.push({ index: i, title, checked });
    });
    return out;
  });
}

/**
 * Uncheck all sources by clicking the global "select all" if currently any are checked.
 * After this, no sources are checked.
 */
async function uncheckAllSources(page: Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error - DOM types
    const allInput = document.querySelector(
      '.select-checkbox-all-sources-container mat-checkbox.select-checkbox-all-sources input.mdc-checkbox__native-control'
    ) as any;
    if (!allInput) return;
    // If it's checked, clicking it unchecks all. If already unchecked, do nothing.
    if (allInput.checked) allInput.click();
  });
  // Small pause to let Angular settle
  await randomDelay(200, 400);
}

/**
 * Check specific source rows by index (clicks the native input to toggle on).
 */
async function checkSourceRows(page: Page, indices: number[]): Promise<void> {
  for (const idx of indices) {
    await page.evaluate((i: number) => {
      // @ts-expect-error - DOM types
      const rows = document.querySelectorAll('.single-source-container');
      if (rows.length <= i) return;
      const input = (rows[i] as any).querySelector(
        'mat-checkbox.select-checkbox input.mdc-checkbox__native-control'
      );
      if (input && !input.checked) input.click();
    }, idx);
    await randomDelay(150, 300);
  }
}

/**
 * Resolve `source_titles` patterns to source indices via case-insensitive
 * substring match. Throws SourceSelectionError on ambiguity or miss.
 */
export async function resolveSourceTitles(
  page: Page,
  titles: string[]
): Promise<{ indices: number[]; resolvedTitles: string[]; total: number }> {
  await ensureSourcePanelExpanded(page);
  // Wait briefly for rows to render
  try {
    await page.waitForSelector(".single-source-container", { timeout: 10000 });
  } catch {
    throw new SourceSelectionError("Source panel did not render any sources.");
  }

  const rows = await listSourceRows(page);
  if (rows.length === 0) {
    throw new SourceSelectionError("Source panel has no sources to filter.");
  }

  const indices: number[] = [];
  const resolvedTitles: string[] = [];

  for (const pattern of titles) {
    const normalizedPattern = pattern.trim().toLowerCase();
    if (!normalizedPattern) continue;

    const matches = rows.filter(r => r.title.toLowerCase().includes(normalizedPattern));

    if (matches.length === 0) {
      const available = rows.slice(0, 8).map(r => `"${r.title.slice(0, 60)}"`).join(", ");
      throw new SourceSelectionError(
        `No source matches "${pattern}". Available titles (first ${Math.min(rows.length, 8)}): ${available}`
      );
    }
    if (matches.length > 1) {
      const hitList = matches.map(m => `"${m.title.slice(0, 60)}"`).join(", ");
      throw new SourceSelectionError(
        `Ambiguous: "${pattern}" matches ${matches.length} sources (${hitList}). Use a more specific substring.`
      );
    }
    const m = matches[0];
    if (!indices.includes(m.index)) {
      indices.push(m.index);
      resolvedTitles.push(m.title);
    }
  }

  return { indices, resolvedTitles, total: rows.length };
}

/**
 * Apply a source-title filter on the page.
 *
 * @returns null if no filter was requested (sourceTitles undefined / empty).
 *          Otherwise an object describing what was applied.
 * @throws SourceSelectionError for unresolvable titles (caller handles).
 */
export async function applySourceFilter(
  page: Page,
  sourceTitles: string[] | undefined
): Promise<SourceFilterApplied | null> {
  if (!sourceTitles || sourceTitles.length === 0) {
    return null;
  }

  const resolved = await resolveSourceTitles(page, sourceTitles);
  log.info(`🎯 Source filter: matched ${resolved.indices.length}/${resolved.total} sources`);
  for (const t of resolved.resolvedTitles) {
    log.dim(`    • ${t.slice(0, 80)}`);
  }

  await uncheckAllSources(page);
  await checkSourceRows(page, resolved.indices);

  return {
    appliedIndices: resolved.indices,
    appliedTitles: resolved.resolvedTitles,
    totalSources: resolved.total,
  };
}
