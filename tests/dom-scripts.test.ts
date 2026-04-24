import { afterEach, describe, expect, it, vi } from "vitest";
import { clickCopiedTextSourceOption } from "../src/notebook-creation/dom-scripts.js";

interface FakeElement {
  textContent?: string;
  tagName?: string;
  parentElement?: FakeElement | null;
  click?: ReturnType<typeof vi.fn>;
}

function setDocument(elements: {
  byData?: FakeElement | null;
  chips?: FakeElement[];
  spans?: FakeElement[];
}): void {
  globalThis.document = {
    querySelector: vi.fn(() => elements.byData ?? null),
    querySelectorAll: vi.fn((selector: string) => {
      if (selector === "span") return elements.spans ?? [];
      return elements.chips ?? [];
    }),
  } as unknown as Document;
}

describe("notebook-creation dom scripts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { document?: unknown }).document;
  });

  it("clicks the direct copied-text source selector first", () => {
    const click = vi.fn();
    setDocument({ byData: { click } });

    expect(clickCopiedTextSourceOption()).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("walks from the Copied text span to a clickable parent", () => {
    const click = vi.fn();
    const parent = { tagName: "BUTTON", click };
    setDocument({
      byData: null,
      chips: [],
      spans: [{ textContent: "Copied text", parentElement: parent }],
    });

    expect(clickCopiedTextSourceOption()).toEqual({ clicked: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("returns false when no copied-text option exists", () => {
    setDocument({ byData: null, chips: [], spans: [] });

    expect(clickCopiedTextSourceOption()).toEqual({ clicked: false });
  });
});
