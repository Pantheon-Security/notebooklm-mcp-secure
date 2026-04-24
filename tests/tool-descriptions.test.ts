import { describe, expect, it } from "vitest";
import { notebookManagementTools } from "../src/tools/definitions/notebook-management.js";
import { systemTools } from "../src/tools/definitions/system.js";
import { videoTools } from "../src/tools/definitions/video.js";

function toolDescription(tools: Array<{ name: string; description?: string }>, name: string): string {
  return tools.find((tool) => tool.name === name)?.description ?? "";
}

describe("tool descriptions", () => {
  it("keeps add_notebook and cleanup_data descriptions compact", () => {
    expect(toolDescription(notebookManagementTools, "add_notebook").split("\n").length).toBeLessThanOrEqual(5);
    expect(toolDescription(systemTools, "cleanup_data").split("\n").length).toBeLessThanOrEqual(5);
  });

  it("documents list_sources active-notebook fallback", () => {
    const description = toolDescription(notebookManagementTools, "list_sources");
    expect(description).toContain("active notebook");
    expect(description).toContain("notebook_id");
    expect(description).toContain("notebook_url");
  });

  it("documents the video download gap", () => {
    const description = toolDescription(videoTools, "generate_video_overview");
    expect(description).toContain("does not currently expose");
    expect(description).toContain("video download");
  });
});
