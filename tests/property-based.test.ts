import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  validateNotebookUrl,
  sanitizeForLogging,
} from "../src/utils/security.js";
import {
  deriveKey,
  decryptPQ,
  encryptPQ,
  generatePQKeyPair,
} from "../src/utils/crypto.js";
import { SecretsScanner } from "../src/utils/secrets-scanner.js";

describe("property-based invariants", () => {
  it("validateNotebookUrl normalizes generated allowed NotebookLM URLs", () => {
    const allowedDomains = [
      "notebooklm.google.com",
      "notebooklm.google.co.uk",
      "notebooklm.google.de",
      "notebooklm.google.fr",
      "notebooklm.google.it",
    ] as const;

    fc.assert(
      fc.property(
        fc.constantFrom(...allowedDomains),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
        fc.integer({ min: 0, max: 999 }),
        (domain, notebookId, q) => {
          const normalized = validateNotebookUrl(
            ` https://${domain}/notebook/${notebookId}?q=${q} `
          );

          expect(normalized).toBe(`https://${domain}/notebook/${notebookId}?q=${q}`);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("sanitizeForLogging is idempotent across generated secret-bearing inputs", () => {
    fc.assert(
      fc.property(
        fc.record({
          emailUser: fc.stringMatching(/^[a-z0-9]{3,12}$/),
          host: fc.stringMatching(/^[a-z]{4,10}$/),
          secret: fc.stringMatching(/^[A-Za-z0-9]{12,24}$/),
          token: fc.stringMatching(/^[A-Za-z0-9]{16,32}$/),
        }),
        ({ emailUser, host, secret, token }) => {
          const input = [
            `${emailUser}@${host}.com`,
            `password=${secret}`,
            `token=${token}`,
            `https://${emailUser}:${secret}@${host}.com/path`,
          ].join(" | ");

          const once = sanitizeForLogging(input);
          const twice = sanitizeForLogging(once);

          expect(twice).toBe(once);
          expect(once).not.toContain(secret);
          expect(once).not.toContain(token);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("deriveKey stays deterministic for generated passphrase and salt pairs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (passphrase, saltBytes) => {
          const salt = Buffer.from(saltBytes);
          const key1 = deriveKey(passphrase, salt, 1000);
          const key2 = deriveKey(passphrase, salt, 1000);

          expect(key1.equals(key2)).toBe(true);
        }
      ),
      { numRuns: 30 }
    );
  });

  it("encryptPQ/decryptPQ round-trips generated binary payloads", () => {
    const keyPair = generatePQKeyPair();

    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (payload) => {
        const plaintext = Buffer.from(payload);
        const encrypted = encryptPQ(plaintext, keyPair.publicKey);
        const decrypted = decryptPQ(encrypted, keyPair.secretKey);

        expect(decrypted.equals(plaintext)).toBe(true);
      }),
      { numRuns: 20 }
    );
  });

  it("secrets-scanner detects and redacts generated secrets", async () => {
    const scanner = new SecretsScanner({ enabled: true, autoRedact: true });

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("AKIA", "ASIA", "AIDA"),
        fc.stringMatching(/^[A-Z0-9]{16}$/),
        fc.stringMatching(/^[A-Za-z0-9]{36}$/),
        async (awsPrefix, awsSuffix, githubTail) => {
          const awsKey = `${awsPrefix}${awsSuffix}`;
          const githubToken = `ghp_${githubTail}`;
          const text = `AWS=${awsKey}\nGITHUB=${githubToken}`;

          const matches = scanner.scan(text);
          expect(matches.length).toBeGreaterThanOrEqual(2);

          const redacted = await scanner.scanAndRedact(text);
          expect(redacted.clean).not.toContain(awsKey);
          expect(redacted.clean).not.toContain(githubToken);
        }
      ),
      { numRuns: 25 }
    );
  });
});
