import { describe, expect, it } from "vitest";
import { buildAskQuestionDescription } from "../src/tools/definitions/ask-question.js";
import type { NotebookLibrary } from "../src/library/notebook-library.js";

describe("ask_question tool definition", () => {
  it("keeps the active-notebook description compact and non-identifying", () => {
    const library = {
      getActiveNotebook: () => ({
        id: "nb-1",
        name: "Confidential Notebook",
        description: "Sensitive description",
        topics: ["secret-topic"],
        use_cases: ["private use case"],
      }),
    } as unknown as NotebookLibrary;

    const description = buildAskQuestionDescription(library);

    expect(description.split("\n").length).toBeLessThanOrEqual(10);
    expect(description).not.toContain("Confidential Notebook");
    expect(description).not.toContain("Sensitive description");
    expect(description).not.toContain("private use case");
  });
});
