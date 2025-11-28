/**
 * Unit Tests for Secrets Scanner
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SecretsScanner,
  scanForSecrets,
  SecretMatch,
} from "../src/utils/secrets-scanner.js";

describe("Secrets Scanner", () => {
  let scanner: SecretsScanner;

  beforeEach(() => {
    scanner = new SecretsScanner({ enabled: true, autoRedact: true });
  });

  describe("AWS Credentials", () => {
    it("should detect AWS Access Key ID", () => {
      const text = "My AWS key is AKIAIOSFODNN7EXAMPLE";
      const matches = scanner.scan(text);

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.some((m) => m.type === "AWS Access Key ID")).toBe(true);
    });

    it("should detect AWS Access Key ID variants", () => {
      const keys = [
        "AKIAIOSFODNN7EXAMPLE",
        "ASIAIOSFODNN7EXAMPLE",
        "AIDAIOSFODNN7EXAMPLE",
        "AROAIOSFODNN7EXAMPLE",
      ];

      for (const key of keys) {
        const matches = scanner.scan(`key: ${key}`);
        expect(matches.some((m) => m.type === "AWS Access Key ID")).toBe(true);
      }
    });
  });

  describe("Google API Keys", () => {
    it("should detect Google API Key", () => {
      const text = 'const apiKey = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe"';
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Google API Key")).toBe(true);
    });

    it("should detect Google OAuth Client Secret", () => {
      // Pattern requires GOCspx- (case-sensitive) + exactly 28 chars
      const text = "GOCspx-ABCDEFGHIJKLMNOPQRSTUVWXabcd";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Google OAuth Client Secret")).toBe(true);
    });
  });

  describe("GitHub Tokens", () => {
    it("should detect GitHub Personal Access Token", () => {
      // Pattern requires ghp_ + 36+ alphanumeric chars
      const text = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "GitHub Personal Access Token")).toBe(true);
    });

    it("should detect various GitHub token types", () => {
      // Pattern requires prefix + 36+ chars
      const tokens = [
        "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      ];

      for (const token of tokens) {
        const matches = scanner.scan(token);
        expect(matches.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Slack Tokens", () => {
    it("should detect Slack Bot Token", () => {
      const text = "SLACK_TOKEN=xoxb-1234567890-1234567890-AbCdEfGhIjKlMnOpQrStUvWx";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Slack Bot Token")).toBe(true);
    });

    it("should detect Slack Webhook URL", () => {
      const text = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Slack Webhook URL")).toBe(true);
    });
  });

  describe("Stripe Keys", () => {
    it("should detect Stripe test key", () => {
      const text = 'stripe.api_key = "sk_test_4eC39HqLyjWDarjtT1zdp7dc"';
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Stripe API Key")).toBe(true);
    });

    it("should detect Stripe live key", () => {
      const text = 'STRIPE_KEY=pk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Stripe API Key")).toBe(true);
    });
  });

  describe("AI Service Keys", () => {
    it("should detect OpenAI API Key", () => {
      // Pattern requires sk- + exactly 48 alphanumeric chars (48 total after sk-)
      const text = "OPENAI_API_KEY=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "OpenAI API Key")).toBe(true);
    });

    it("should detect Anthropic API Key", () => {
      // Pattern requires sk-ant- + 40+ chars (with underscores/hyphens allowed)
      const text = "ANTHROPIC_KEY=sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Anthropic API Key")).toBe(true);
    });
  });

  describe("Private Keys", () => {
    it("should detect RSA Private Key", () => {
      const text = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy
-----END RSA PRIVATE KEY-----`;
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "RSA Private Key")).toBe(true);
    });

    it("should detect generic Private Key", () => {
      const text = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEA
-----END PRIVATE KEY-----`;
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Generic Private Key")).toBe(true);
    });

    it("should detect SSH Private Key", () => {
      const text = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB
-----END OPENSSH PRIVATE KEY-----`;
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "SSH Private Key")).toBe(true);
    });
  });

  describe("JWT Tokens", () => {
    it("should detect JSON Web Token", () => {
      const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "JSON Web Token")).toBe(true);
    });
  });

  describe("Database Connection Strings", () => {
    it("should detect PostgreSQL connection string", () => {
      const text = "DATABASE_URL=postgres://user:password123@localhost:5432/mydb";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "PostgreSQL Connection String")).toBe(true);
    });

    it("should detect MongoDB connection string", () => {
      const text = "MONGO_URI=mongodb+srv://admin:secret@cluster0.abc123.mongodb.net/mydb";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "MongoDB Connection String")).toBe(true);
    });

    it("should detect MySQL connection string", () => {
      const text = "mysql://root:password@localhost:3306/database";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "MySQL Connection String")).toBe(true);
    });
  });

  describe("Password Patterns", () => {
    it("should detect password in URL", () => {
      const text = "https://admin:supersecret@api.example.com/data";
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Password in URL")).toBe(true);
    });

    it("should detect password assignment", () => {
      const text = 'password = "MySecretPass123!"';
      const matches = scanner.scan(text);

      expect(matches.some((m) => m.type === "Password Assignment")).toBe(true);
    });
  });

  describe("Redaction", () => {
    it("should redact detected secrets", async () => {
      const text = "My API key is AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe";
      const result = await scanner.scanAndRedact(text);

      expect(result.secrets.length).toBeGreaterThan(0);
      expect(result.clean).not.toContain("AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe");
      expect(result.clean).toContain("AIza");
      expect(result.clean).toContain("****");
    });

    it("should handle multiple secrets", async () => {
      const text = `
        AWS_KEY=AKIAIOSFODNN7EXAMPLE
        GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh
      `;
      const result = await scanner.scanAndRedact(text);

      expect(result.secrets.length).toBeGreaterThanOrEqual(2);
      expect(result.clean).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(result.clean).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh");
    });
  });

  describe("Configuration", () => {
    it("should respect minSeverity setting", () => {
      const highOnlyScanner = new SecretsScanner({ minSeverity: "high" });
      const text = "Some base64: YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw";
      const matches = highOnlyScanner.scan(text);

      // Should not detect low-severity high-entropy strings
      expect(matches.every((m) => m.severity !== "low")).toBe(true);
    });

    it("should allow disabling scanner", () => {
      const disabledScanner = new SecretsScanner({ enabled: false });
      const text = "AKIAIOSFODNN7EXAMPLE";
      const matches = disabledScanner.scan(text);

      expect(matches.length).toBe(0);
    });

    it("should allow ignoring patterns", () => {
      const customScanner = new SecretsScanner({
        ignoredPatterns: ["AWS Access Key ID"],
      });
      const text = "AKIAIOSFODNN7EXAMPLE";
      const matches = customScanner.scan(text);

      expect(matches.some((m) => m.type === "AWS Access Key ID")).toBe(false);
    });
  });

  describe("Statistics", () => {
    it("should track scanning statistics", () => {
      scanner.scan("text1");
      scanner.scan("AKIAIOSFODNN7EXAMPLE");
      scanner.scan("text3");

      const stats = scanner.getStats();
      expect(stats.scanned).toBe(3);
      expect(stats.secretsFound).toBeGreaterThan(0);
    });

    it("should reset statistics", () => {
      scanner.scan("AKIAIOSFODNN7EXAMPLE");
      scanner.resetStats();

      const stats = scanner.getStats();
      expect(stats.scanned).toBe(0);
      expect(stats.secretsFound).toBe(0);
    });
  });

  describe("False Positive Handling", () => {
    it("should not flag normal text", () => {
      const text = "Hello, this is a normal message without any secrets.";
      const matches = scanner.scan(text);

      expect(matches.length).toBe(0);
    });

    it("should not flag short strings", () => {
      const text = "key=abc123";
      const matches = scanner.scan(text);

      // Should not match as it's too short to be a real secret
      expect(matches.filter((m) => m.severity === "critical").length).toBe(0);
    });
  });
});
