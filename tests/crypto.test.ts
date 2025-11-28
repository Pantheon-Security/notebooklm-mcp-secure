/**
 * Unit Tests for Post-Quantum Cryptographic Utilities
 *
 * Tests ML-KEM-768 + ChaCha20-Poly1305 hybrid encryption
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveKey,
  getMachineKey,
  generatePQKeyPair,
  encryptPQ,
  decryptPQ,
  encryptClassical,
  decryptClassical,
  SecureStorage,
} from "../src/utils/crypto.js";

describe("Crypto Utilities", () => {
  describe("deriveKey", () => {
    it("should derive a 32-byte key from passphrase", () => {
      const salt = Buffer.from("test-salt-12345678901234567890");
      const key = deriveKey("my-passphrase", salt, 1000);

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("should produce consistent keys for same input", () => {
      const salt = Buffer.from("test-salt-12345678901234567890");
      const key1 = deriveKey("same-passphrase", salt, 1000);
      const key2 = deriveKey("same-passphrase", salt, 1000);

      expect(key1.equals(key2)).toBe(true);
    });

    it("should produce different keys for different passphrases", () => {
      const salt = Buffer.from("test-salt-12345678901234567890");
      const key1 = deriveKey("passphrase-1", salt, 1000);
      const key2 = deriveKey("passphrase-2", salt, 1000);

      expect(key1.equals(key2)).toBe(false);
    });

    it("should produce different keys for different salts", () => {
      const salt1 = Buffer.from("salt-1-12345678901234567890123");
      const salt2 = Buffer.from("salt-2-12345678901234567890123");
      const key1 = deriveKey("same-passphrase", salt1, 1000);
      const key2 = deriveKey("same-passphrase", salt2, 1000);

      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe("getMachineKey", () => {
    it("should return a 64-character hex string", () => {
      const key = getMachineKey();

      expect(typeof key).toBe("string");
      expect(key.length).toBe(64);
      expect(/^[0-9a-f]+$/.test(key)).toBe(true);
    });

    it("should be deterministic", () => {
      const key1 = getMachineKey();
      const key2 = getMachineKey();

      expect(key1).toBe(key2);
    });
  });

  describe("ML-KEM-768 Post-Quantum Encryption", () => {
    let keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };

    beforeEach(() => {
      keyPair = generatePQKeyPair();
    });

    it("should generate valid key pair", () => {
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.secretKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey.length).toBeGreaterThan(0);
      expect(keyPair.secretKey.length).toBeGreaterThan(0);
    });

    it("should encrypt and decrypt string data", () => {
      const plaintext = "Hello, Post-Quantum World!";
      const encrypted = encryptPQ(plaintext, keyPair.publicKey);

      expect(encrypted.version).toBe(3);
      expect(encrypted.algorithm).toBe("chacha20-poly1305");
      expect(encrypted.pqAlgorithm).toBe("ML-KEM-768");
      expect(encrypted.encapsulatedKey).toBeTruthy();
      expect(encrypted.nonce).toBeTruthy();
      expect(encrypted.ciphertext).toBeTruthy();

      const decrypted = decryptPQ(encrypted, keyPair.secretKey);
      expect(decrypted.toString("utf-8")).toBe(plaintext);
    });

    it("should encrypt and decrypt Buffer data", () => {
      const plaintext = Buffer.from("Binary data: \x00\x01\x02\x03");
      const encrypted = encryptPQ(plaintext, keyPair.publicKey);
      const decrypted = decryptPQ(encrypted, keyPair.secretKey);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it("should produce different ciphertext for same plaintext", () => {
      const plaintext = "Same message twice";
      const encrypted1 = encryptPQ(plaintext, keyPair.publicKey);
      const encrypted2 = encryptPQ(plaintext, keyPair.publicKey);

      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
      expect(encrypted1.encapsulatedKey).not.toBe(encrypted2.encapsulatedKey);
    });

    it("should fail with wrong secret key", () => {
      const plaintext = "Secret message";
      const encrypted = encryptPQ(plaintext, keyPair.publicKey);

      const wrongKeyPair = generatePQKeyPair();
      expect(() => decryptPQ(encrypted, wrongKeyPair.secretKey)).toThrow();
    });

    it("should handle empty string", () => {
      const plaintext = "";
      const encrypted = encryptPQ(plaintext, keyPair.publicKey);
      const decrypted = decryptPQ(encrypted, keyPair.secretKey);

      expect(decrypted.toString("utf-8")).toBe(plaintext);
    });

    it("should handle large data", () => {
      const plaintext = "A".repeat(100000); // 100KB
      const encrypted = encryptPQ(plaintext, keyPair.publicKey);
      const decrypted = decryptPQ(encrypted, keyPair.secretKey);

      expect(decrypted.toString("utf-8")).toBe(plaintext);
    });

    it("should handle Unicode data", () => {
      const plaintext = "Hello 世界 🌍 مرحبا";
      const encrypted = encryptPQ(plaintext, keyPair.publicKey);
      const decrypted = decryptPQ(encrypted, keyPair.secretKey);

      expect(decrypted.toString("utf-8")).toBe(plaintext);
    });
  });

  describe("ChaCha20-Poly1305 Classical Encryption", () => {
    let key: Buffer;

    beforeEach(() => {
      key = Buffer.alloc(32);
      for (let i = 0; i < 32; i++) key[i] = i;
    });

    it("should encrypt and decrypt string data", () => {
      const plaintext = "Hello, ChaCha20!";
      const encrypted = encryptClassical(plaintext, key);

      expect(encrypted.version).toBe(2);
      expect(encrypted.algorithm).toBe("chacha20-poly1305");
      expect(encrypted.nonce).toBeTruthy();
      expect(encrypted.ciphertext).toBeTruthy();

      const decrypted = decryptClassical(encrypted, key);
      expect(decrypted.toString("utf-8")).toBe(plaintext);
    });

    it("should encrypt and decrypt Buffer data", () => {
      const plaintext = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
      const encrypted = encryptClassical(plaintext, key);
      const decrypted = decryptClassical(encrypted, key);

      expect(decrypted.equals(plaintext)).toBe(true);
    });

    it("should fail with wrong key", () => {
      const plaintext = "Secret data";
      const encrypted = encryptClassical(plaintext, key);

      const wrongKey = Buffer.alloc(32);
      wrongKey.fill(0xff);

      expect(() => decryptClassical(encrypted, wrongKey)).toThrow();
    });

    it("should detect tampering", () => {
      const plaintext = "Tamper-proof data";
      const encrypted = encryptClassical(plaintext, key);

      // Tamper with ciphertext
      const tampered = { ...encrypted };
      const ciphertextBuf = Buffer.from(tampered.ciphertext, "base64");
      ciphertextBuf[0] ^= 0xff;
      tampered.ciphertext = ciphertextBuf.toString("base64");

      expect(() => decryptClassical(tampered, key)).toThrow();
    });
  });

  describe("SecureStorage", () => {
    it("should generate a valid base64 key", () => {
      const key = SecureStorage.generateKey();

      expect(typeof key).toBe("string");
      const decoded = Buffer.from(key, "base64");
      expect(decoded.length).toBe(32);
    });
  });
});
