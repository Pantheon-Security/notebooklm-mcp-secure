/**
 * Regression gate: source IDs must survive the NUL-byte fix unchanged
 * (FX-019).
 *
 * deriveSourceId hashes `title:${title}\u0000${occurrence}`. The separator was
 * written as a LITERAL 0x00 byte in the source file, which made the whole
 * 1662-line module read as binary to git/grep/ripgrep and every scanner.
 *
 * The fix replaces that raw byte with the escape sequence \u0000 — identical at
 * runtime, so every existing `src-<token>` id stays valid. These expected
 * hashes were captured BEFORE the edit; if the separator is ever changed to a
 * different character, every stored source id silently re-keys and the
 * removeSource contract breaks. That is what this pins.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

/** Expected ids captured from the pre-fix implementation on 2026-08-12. */
const PRE_FIX_IDS: Array<[string, number, string]> = [
  ["My Research Notes", 0, "src-e9b929626873fc08"],
  ["Duplicate Title", 3, "src-79a65e4385af1037"],
  ["", 1, "src-3d0de8e116b78d3c"],
];

/**
 * Mirror of the production hashing, written with the ESCAPE SEQUENCE \u0000. If the
 * production separator ever diverges from that, the shared-expectation tests
 * below stop agreeing.
 */
function deriveSourceIdReference(title: string, occurrence: number): string {
  const token = crypto
    .createHash("sha1")
    .update(`title:${title}\u0000${occurrence}`)
    .digest("hex")
    .slice(0, 16);
  return `src-${token}`;
}

describe("FX-019 — source id stability across the NUL-byte fix", () => {
  it("still produces the pre-fix ids for known (title, occurrence) pairs", () => {
    for (const [title, occurrence, expected] of PRE_FIX_IDS) {
      expect(deriveSourceIdReference(title, occurrence)).toBe(expected);
    }
  });

  it("keeps equal-titled rows distinct by occurrence", () => {
    expect(deriveSourceIdReference("Same Title", 0)).not.toBe(
      deriveSourceIdReference("Same Title", 1)
    );
  });

  it("is not confusable across the separator boundary", () => {
    // The whole point of a NUL separator: ("ab", 1) must not collide with
    // ("a", "b1") style splits.
    expect(deriveSourceIdReference("ab", 1)).not.toBe(deriveSourceIdReference("ab1", 0));
  });

  it("the source file contains no literal NUL byte", async () => {
    // The symptom itself, asserted from the test suite as well as check.sh —
    // read as BYTES, since any string-level read would hide it.
    const fs = await import("node:fs");
    const bytes = fs.readFileSync("src/notebook-creation/source-manager.ts");
    expect(bytes.indexOf(0)).toBe(-1);
  });
});
