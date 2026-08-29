/**
 * Regression gate: env-dependent singletons must be rebuilt per test (FX-025).
 *
 * This is the generalised form of the FX-013 false-green. mcp-auth.ts holds a
 * module-level `globalAuthenticator` built on first use, and MCPAuthenticator
 * reads NLMCP_AUTH_DISABLED / NLMCP_AUTH_ENABLED in its CONSTRUCTOR. With
 * vitest.config.ts running sequence.shuffle, whichever test builds the
 * singleton first decides the auth state for every test after it in that
 * worker — setting the env later has no effect at all.
 *
 * A test written against that singleton can therefore assert a behaviour whose
 * PRECONDITION it never actually establishes, and pass for the wrong reason.
 * The sweep found exactly one such assertion in the existing suite
 * (tests/mcp-auth.test.ts, "requires a token when forceAuth=true and auth
 * globally disabled"): it passes whether or not the env took effect, because
 * forceAuth with no token is refused in both states.
 *
 * The first test below reproduces the hazard directly — it is red without a
 * module reset and green with one. The second is the corrected form of the
 * vacuous assertion, which now proves its own precondition.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("FX-025 — env-dependent singletons are rebuilt per test", () => {
  const envKeys = ["NLMCP_AUTH_DISABLED", "NLMCP_AUTH_ENABLED", "NLMCP_AUTH_TOKEN"] as const;
  const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("picks up an env change made after an earlier module graph built the singleton", async () => {
    // Build the singleton with auth ENABLED (the default).
    const first = await import("../src/auth/mcp-auth.js");
    expect(first.getMCPAuthenticator().isEnabled()).toBe(true);

    // Now disable auth and rebuild the module graph, exactly as a test that
    // cares about the disabled state must do.
    process.env.NLMCP_AUTH_DISABLED = "true";
    vi.resetModules();

    const second = await import("../src/auth/mcp-auth.js");
    expect(second.getMCPAuthenticator().isEnabled()).toBe(false);

    // ...and it must genuinely be a different instance, not the cached one.
    expect(second.getMCPAuthenticator()).not.toBe(first.getMCPAuthenticator());
  });

  it("refuses a forceAuth call with no token AND proves auth was really disabled", async () => {
    // The corrected form of tests/mcp-auth.test.ts:451. The original set the
    // env but never checked it applied, so the assertion held vacuously.
    process.env.NLMCP_AUTH_DISABLED = "true";
    vi.resetModules();

    const { authenticateMCPRequest, getMCPAuthenticator } = await import(
      "../src/auth/mcp-auth.js"
    );

    // Precondition, asserted rather than assumed — this is the line whose
    // absence made the original test unable to fail.
    expect(getMCPAuthenticator().isEnabled()).toBe(false);

    const res = await authenticateMCPRequest(undefined, "test-tool", true);
    expect(res.authenticated).toBe(false);
    expect(res.error).toMatch(/authentication/i);
  });

  it("lets a forceAuth-exempt call through when auth is genuinely disabled", async () => {
    // The other half of the condition: without forceAuth, a disabled
    // authenticator must allow the call. This assertion DOES depend on the env
    // having applied, so it fails outright if the singleton is stale.
    process.env.NLMCP_AUTH_DISABLED = "true";
    vi.resetModules();

    const { authenticateMCPRequest, getMCPAuthenticator } = await import(
      "../src/auth/mcp-auth.js"
    );

    expect(getMCPAuthenticator().isEnabled()).toBe(false);

    const res = await authenticateMCPRequest(undefined, "list_notebooks", false);
    expect(res.authenticated).toBe(true);
  });
});
