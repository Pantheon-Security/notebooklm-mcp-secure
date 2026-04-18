import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * Coverage provider is v8; reports are emitted to `coverage/` and the
 * summary is printed with `text` reporter. Target modules — mcp-auth,
 * webhook-dispatcher, quota-manager, dsar-handler, data-erasure, and
 * auth-manager — are included in the scope so progress against
 * security-critical coverage is visible.
 */
export default defineConfig({
  test: {
    // Match the existing convention: all tests under tests/
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Scope coverage to src/. dist/ and tests/ are excluded by default.
      include: ["src/**/*.ts"],
      // Exclude things that can't (or shouldn't) be unit-tested without
      // a real browser/runtime or are pure type shims.
      exclude: [
        "src/**/*.d.ts",
        "src/**/types.ts",
        "src/notebook-creation/**", // patchright-heavy, belongs in integration tests
        "src/session/**", // browser session management
        "src/gemini/**", // external API client
        "src/index.ts", // entry point; covered via startup integration tests
      ],
    },
  },
});
