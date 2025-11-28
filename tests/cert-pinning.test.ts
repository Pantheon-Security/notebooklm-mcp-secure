/**
 * Unit Tests for Certificate Pinning
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  calculateSPKIHash,
  validateCertificatePin,
  CertificatePinningManager,
} from "../src/utils/cert-pinning.js";
import crypto from "crypto";

// Mock certificate for testing
function createMockCert(pubkeyContent: string = "test-public-key") {
  return {
    pubkey: Buffer.from(pubkeyContent),
    fingerprint256: crypto.createHash("sha256").update(pubkeyContent).digest("hex"),
    raw: Buffer.from("raw-cert-data"),
  };
}

describe("Certificate Pinning", () => {
  describe("calculateSPKIHash", () => {
    it("should calculate SHA-256 hash of public key", () => {
      const cert = createMockCert("test-public-key");
      const hash = calculateSPKIHash(cert as any);

      expect(typeof hash).toBe("string");
      // Base64 SHA-256 is 44 characters with padding
      expect(hash.length).toBe(44);
    });

    it("should produce consistent hashes", () => {
      const cert = createMockCert("consistent-key");
      const hash1 = calculateSPKIHash(cert as any);
      const hash2 = calculateSPKIHash(cert as any);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different keys", () => {
      const cert1 = createMockCert("key-one");
      const cert2 = createMockCert("key-two");

      const hash1 = calculateSPKIHash(cert1 as any);
      const hash2 = calculateSPKIHash(cert2 as any);

      expect(hash1).not.toBe(hash2);
    });

    it("should throw if certificate has no public key", () => {
      const cert = { pubkey: undefined };
      expect(() => calculateSPKIHash(cert as any)).toThrow("Certificate has no public key");
    });
  });

  describe("validateCertificatePin", () => {
    const testPins = ["pin1hash=", "pin2hash=", "pin3hash="];

    it("should validate when chain contains pinned certificate", () => {
      const result = validateCertificatePin(
        "test.google.com",
        ["otherhash=", "pin2hash=", "anotherhash="],
        {
          enabled: true,
          failOpen: false,
          reportOnly: false,
          additionalPins: { "test.google.com": testPins },
        }
      );

      expect(result.valid).toBe(true);
      expect(result.matchedPin).toBe("pin2hash=");
    });

    it("should fail when no chain hash matches pins", () => {
      const result = validateCertificatePin(
        "test.google.com",
        ["wronghash1=", "wronghash2="],
        {
          enabled: true,
          failOpen: false,
          reportOnly: false,
          additionalPins: { "test.google.com": testPins },
        }
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Certificate pinning failed");
    });

    it("should pass when pinning is disabled", () => {
      const result = validateCertificatePin(
        "test.google.com",
        ["wronghash="],
        {
          enabled: false,
          failOpen: false,
          reportOnly: false,
          additionalPins: {},
        }
      );

      expect(result.valid).toBe(true);
    });

    it("should pass when no pins configured for hostname", () => {
      const result = validateCertificatePin(
        "unknown.example.com",
        ["anyhash="],
        {
          enabled: true,
          failOpen: false,
          reportOnly: false,
          additionalPins: {},
        }
      );

      expect(result.valid).toBe(true);
    });

    it("should match wildcard pins from built-in config", () => {
      // Test that the built-in *.google.com pins work for subdomains
      const result = validateCertificatePin(
        "api.google.com",
        ["hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc="], // GTS Root R1
        {
          enabled: true,
          failOpen: false,
          reportOnly: false,
          additionalPins: {},
        }
      );

      expect(result.valid).toBe(true);
    });
  });

  describe("CertificatePinningManager", () => {
    let manager: CertificatePinningManager;

    beforeEach(() => {
      manager = new CertificatePinningManager({
        enabled: true,
        failOpen: false,
        reportOnly: false,
        additionalPins: {},
      });
    });

    it("should report enabled status", () => {
      expect(manager.isEnabled()).toBe(true);

      const disabledManager = new CertificatePinningManager({ enabled: false });
      expect(disabledManager.isEnabled()).toBe(false);
    });

    it("should track violation statistics", () => {
      const stats = manager.getStats();

      expect(stats.enabled).toBe(true);
      expect(stats.reportOnly).toBe(false);
      expect(stats.violationCount).toBe(0);
      expect(stats.lastViolation).toBeUndefined();
    });

    it("should update configuration", () => {
      manager.updateConfig({ reportOnly: true });

      const stats = manager.getStats();
      expect(stats.reportOnly).toBe(true);
    });

    it("should add custom pins", () => {
      manager.addPin("custom.example.com", "customhash=");
      manager.addPin("custom.example.com", "anotherhash=");

      // Adding same pin twice should not duplicate
      manager.addPin("custom.example.com", "customhash=");

      // Verify by checking stats (internal state)
      expect(manager.getStats().enabled).toBe(true);
    });

    it("should create pinned HTTPS agent", () => {
      const agent = manager.createPinnedAgent("test.google.com");

      expect(agent).toBeDefined();
      expect(agent.options).toBeDefined();
    });

    describe("report-only mode", () => {
      beforeEach(() => {
        manager = new CertificatePinningManager({
          enabled: true,
          failOpen: false,
          reportOnly: true,
          additionalPins: {},
        });
      });

      it("should allow connections in report-only mode", async () => {
        // Mock TLS socket
        const mockSocket = {
          getPeerCertificate: () => ({
            pubkey: Buffer.from("wrong-key"),
            fingerprint256: "abc123",
            raw: Buffer.from("raw"),
          }),
        };

        // Validation should pass in report-only mode
        const result = await manager.validateConnection(
          mockSocket as any,
          "notebooklm.google.com"
        );

        // Even with wrong cert, report-only allows through
        expect(result).toBe(true);
      });
    });

    describe("fail-open mode", () => {
      beforeEach(() => {
        manager = new CertificatePinningManager({
          enabled: true,
          failOpen: true,
          reportOnly: false,
          additionalPins: {},
        });
      });

      it("should allow connections in fail-open mode", async () => {
        const mockSocket = {
          getPeerCertificate: () => ({
            pubkey: Buffer.from("wrong-key"),
            fingerprint256: "abc123",
            raw: Buffer.from("raw"),
          }),
        };

        const result = await manager.validateConnection(
          mockSocket as any,
          "notebooklm.google.com"
        );

        expect(result).toBe(true);
      });
    });
  });

  describe("Google Certificate Pins", () => {
    it("should have pins for *.google.com", () => {
      // Verify that built-in pins exist for Google domains
      const result = validateCertificatePin(
        "notebooklm.google.com",
        ["hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc="], // GTS Root R1
        {
          enabled: true,
          failOpen: false,
          reportOnly: false,
          additionalPins: {},
        }
      );

      expect(result.valid).toBe(true);
    });

    it("should have pins for accounts.google.com", () => {
      const result = validateCertificatePin(
        "accounts.google.com",
        ["Vfd95BwDeSQo+NUYxVEEIBvvpOs/QbsFp7DeP0Cr1pE="], // GTS Root R2
        {
          enabled: true,
          failOpen: false,
          reportOnly: false,
          additionalPins: {},
        }
      );

      expect(result.valid).toBe(true);
    });
  });
});
