import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      stealthEnabled: false,
      stealthHumanTyping: false,
      stealthMouseMovements: false,
      stealthRandomDelays: false,
    },
  };
});

import { humanType, realisticClick, smoothScroll } from "../src/utils/stealth-utils.js";

describe("stealth-utils", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("humanType uses the direct fill path when stealth typing is disabled", async () => {
    const page = {
      fill: vi.fn().mockResolvedValue(undefined),
    };

    await humanType(page as never, "input[name=email]", "user@example.com", {
      withTypos: false,
    });

    expect(page.fill).toHaveBeenCalledWith("input[name=email]", "user@example.com");
  });

  it("realisticClick uses the direct click path when stealth mouse movement is disabled", async () => {
    const page = {
      click: vi.fn().mockResolvedValue(undefined),
    };

    await realisticClick(page as never, "button[type=submit]");

    expect(page.click).toHaveBeenCalledWith("button[type=submit]");
  });

  it("smoothScroll uses direct evaluate scrolling when stealth scrolling is disabled", async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    await smoothScroll(page as never, 120, "down");

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), 120);
  });
});
