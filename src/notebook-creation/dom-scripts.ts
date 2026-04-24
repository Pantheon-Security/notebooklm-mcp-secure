/**
 * Browser-context DOM scripts used by notebook creation.
 *
 * Keep these helpers closure-free so Patchright can serialize them into
 * page.evaluate().
 */

interface BrowserElementLike {
  textContent?: string | null;
  tagName?: string;
  parentElement?: BrowserElementLike | null;
  click?: () => void;
}

interface BrowserDocumentLike {
  querySelector: (selector: string) => BrowserElementLike | null;
  querySelectorAll: (selector: string) => Iterable<BrowserElementLike> | ArrayLike<BrowserElementLike>;
}

function getBrowserDocument(): BrowserDocumentLike {
  return (globalThis as unknown as { document: BrowserDocumentLike }).document;
}

function asArray<T>(items: Iterable<T> | ArrayLike<T>): T[] {
  return Array.from(items as ArrayLike<T>);
}

export function clickCopiedTextSourceOption(): { clicked: boolean } {
  const document = getBrowserDocument();
  const byData = document.querySelector(
    '[data-source-type="text"], [data-type="text"], mat-chip[value="text"]'
  );
  if (byData?.click) {
    byData.click();
    return { clicked: true };
  }

  const chips = asArray(document.querySelectorAll("mat-chip, mat-chip-option, [mat-chip-option]"));
  for (const chip of chips) {
    const chipText = chip.textContent?.trim() || "";
    if (chipText.includes("Copied text") && chip.click) {
      chip.click();
      return { clicked: true };
    }
  }

  const spans = asArray(document.querySelectorAll("span"));
  for (const span of spans) {
    const spanText = span.textContent?.trim() || "";
    if (spanText !== "Copied text") continue;

    let target: BrowserElementLike = span;
    for (let i = 0; i < 5; i++) {
      if (!target.parentElement) break;
      target = target.parentElement;
      const tagName = target.tagName?.toLowerCase();
      if ((tagName === "mat-chip" || tagName === "mat-chip-option" || tagName === "button") && target.click) {
        target.click();
        return { clicked: true };
      }
    }

    if (span.click) {
      span.click();
      return { clicked: true };
    }
  }

  return { clicked: false };
}
