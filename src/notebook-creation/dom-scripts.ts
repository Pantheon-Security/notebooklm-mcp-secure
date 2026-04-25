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
  getAttribute?: (name: string) => string | null;
  click?: () => void;
}

interface BrowserDocumentLike {
  querySelector: (selector: string) => BrowserElementLike | null;
  querySelectorAll: (selector: string) => Iterable<BrowserElementLike> | ArrayLike<BrowserElementLike>;
}

export function clickCopiedTextSourceOption(): { clicked: boolean } {
  const document = (globalThis as unknown as { document: BrowserDocumentLike }).document;
  const asArray = <T>(items: Iterable<T> | ArrayLike<T>): T[] => Array.from(items as ArrayLike<T>);
  const normalized = (value?: string | null) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const isCopiedTextLabel = (value?: string | null) => {
    const text = normalized(value);
    return text.includes("copied text") || text.includes("paste as text");
  };
  const isSearchUi = (value?: string | null) => {
    const text = normalized(value);
    return text.includes("search the web") || text.includes("discover sources");
  };

  const byData = document.querySelector(
    '[data-source-type="text"], [data-type="text"], mat-chip[value="text"]'
  );
  if (byData?.click) {
    byData.click();
    return { clicked: true };
  }

  const chips = asArray(document.querySelectorAll("mat-chip, mat-chip-option, [mat-chip-option]"));
  for (const chip of chips) {
    const chipText = chip.textContent;
    if (isCopiedTextLabel(chipText) && !isSearchUi(chipText) && chip.click) {
      chip.click();
      return { clicked: true };
    }
  }

  const spans = asArray(document.querySelectorAll("span"));
  for (const span of spans) {
    const spanText = span.textContent;
    if (!isCopiedTextLabel(spanText) || isSearchUi(spanText)) continue;

    let target: BrowserElementLike = span;
    for (let i = 0; i < 5; i++) {
      if (!target.parentElement) break;
      target = target.parentElement;
      const tagName = target.tagName?.toLowerCase();
      const aria = target.getAttribute?.("aria-label");
      if (isSearchUi(target.textContent) || isSearchUi(aria)) continue;
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
