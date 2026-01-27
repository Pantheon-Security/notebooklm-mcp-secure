/**
 * Post-Quantum Cryptographic Utilities for NotebookLM MCP Server
 *
 * Provides quantum-resistant encryption at rest using hybrid encryption:
 * - ML-KEM-768 (Kyber) for post-quantum key encapsulation
 * - ChaCha20-Poly1305 for symmetric encryption (NOT AES-GCM)
 * - PBKDF2 for key derivation from passwords
 * - Machine-derived keys (fallback)
 *
 * Why ChaCha20-Poly1305 over AES-GCM:
 * - Constant-time by design (no cache timing side-channels)
 * - Faster in software without hardware AES-NI
 * - Simpler construction, less prone to implementation errors
 * - Used by Google, Cloudflare for TLS
 *
 * This hybrid approach ensures:
 * 1. Current security via ChaCha20-Poly1305
 * 2. Future quantum resistance via ML-KEM-768
 *
 * Added by Pantheon Security for hardened fork.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { log } from "./logger.js";
import { audit } from "./audit-logger.js";
import {
  mkdirSecure,
  writeFileSecure,
  PERMISSION_MODES,
} from "./file-permissions.js";

/**
 * Encryption configuration
 */
export interface EncryptionConfig {
  /** Enable encryption (default: true) */
  enabled: boolean;
  /** User-provided encryption key (base64) */
  key?: string;
  /** Key file path */
  keyFile?: string;
  /** Use machine-derived key as fallback */
  useMachineKey: boolean;
  /** PBKDF2 iterations (default: 100000) */
  pbkdf2Iterations: number;
  /** Use post-quantum encryption (default: true) */
  usePostQuantum: boolean;
}

/**
 * Post-Quantum encrypted data format (hybrid encryption)
 */
interface PQEncryptedData {
  version: number;
  algorithm: string;
  pqAlgorithm: string;
  encapsulatedKey: string;  // Base64 - ML-KEM encapsulated key
  nonce: string;            // Base64 - 12 bytes for ChaCha20
  salt: string;             // Base64
  ciphertext: string;       // Base64 (includes Poly1305 tag)
}

/**
 * Classical encrypted data format (fallback)
 */
interface ClassicalEncryptedData {
  version: number;
  algorithm: string;
  nonce: string;       // Base64
  salt: string;        // Base64
  ciphertext: string;  // Base64 (includes Poly1305 tag)
}

/**
 * Legacy AES-GCM format (for migration)
 */
interface LegacyAESEncryptedData {
  version: number;
  algorithm: string;
  pqAlgorithm?: string;
  encapsulatedKey?: string;
  iv: string;
  salt: string;
  tag: string;
  ciphertext: string;
}

type EncryptedData = PQEncryptedData | ClassicalEncryptedData;

/**
 * Constants
 */
const ALGORITHM = "chacha20-poly1305";
const PQ_ALGORITHM = "ML-KEM-768";
const KEY_LENGTH = 32; // 256 bits
const NONCE_LENGTH = 12;  // 96 bits for ChaCha20
const SALT_LENGTH = 32;
const CURRENT_VERSION = 3; // Version 3 = Post-Quantum + ChaCha20-Poly1305
const CLASSICAL_VERSION = 2; // Version 2 = ChaCha20-Poly1305 classical
// Legacy versions for migration (detected by presence of 'iv' and 'tag' fields)
// LEGACY_PQ_VERSION = 2 (old PQ with AES-GCM)
// LEGACY_CLASSICAL_VERSION = 1 (old classical with AES-GCM)

/**
 * Get encryption configuration from environment
 */
function getEncryptionConfig(): EncryptionConfig {
  return {
    enabled: process.env.NLMCP_ENCRYPTION_ENABLED !== "false",
    key: process.env.NLMCP_ENCRYPTION_KEY,
    keyFile: process.env.NLMCP_ENCRYPTION_KEY_FILE,
    useMachineKey: process.env.NLMCP_USE_MACHINE_KEY !== "false",
    pbkdf2Iterations: parseInt(process.env.NLMCP_PBKDF2_ITERATIONS || "100000", 10),
    usePostQuantum: process.env.NLMCP_USE_POST_QUANTUM !== "false",
  };
}

/**
 * Derive a key from a passphrase using PBKDF2
 */
export function deriveKey(passphrase: string, salt: Buffer, iterations: number = 100000): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, iterations, KEY_LENGTH, "sha256");
}

/**
 * Generate a machine-derived key based on hardware/OS identifiers
 *
 * Note: This provides obscurity, not true security. It's a fallback
 * when no user key is provided.
 */
export function getMachineKey(): string {
  const components = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || "unknown",
    os.homedir(),
  ];

  // Create a deterministic key from machine components
  const combined = components.join("|");
  const hash = crypto.createHash("sha256").update(combined).digest("hex");

  return hash;
}

/**
 * Generate ML-KEM key pair for post-quantum encryption
 */
export function generatePQKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const keys = ml_kem768.keygen();
  return {
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
  };
}

/**
 * Encrypt data using hybrid post-quantum encryption
 * ML-KEM-768 + ChaCha20-Poly1305
 *
 * Process:
 * 1. Encapsulate a shared secret using recipient's public key (ML-KEM-768)
 * 2. Derive ChaCha20 key from shared secret + salt
 * 3. Encrypt data with ChaCha20-Poly1305 (AEAD)
 */
export function encryptPQ(
  data: string | Buffer,
  recipientPublicKey: Uint8Array
): PQEncryptedData {
  // Step 1: Encapsulate a shared secret using ML-KEM
  const { cipherText: encapsulatedKey, sharedSecret } = ml_kem768.encapsulate(recipientPublicKey);

  // Step 2: Generate nonce and salt
  const salt = crypto.randomBytes(SALT_LENGTH);
  const nonce = crypto.randomBytes(NONCE_LENGTH);

  // Step 3: Derive ChaCha20 key from shared secret + salt
  const chachaKey = crypto.createHash("sha256")
    .update(Buffer.from(sharedSecret))
    .update(salt)
    .digest();

  // Step 4: Encrypt with ChaCha20-Poly1305
  const cipher = crypto.createCipheriv(ALGORITHM, chachaKey, nonce, {
    authTagLength: 16,
  });

  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine ciphertext + auth tag (standard practice for ChaCha20-Poly1305)
  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);

  // Clear sensitive data from memory
  chachaKey.fill(0);

  return {
    version: CURRENT_VERSION,
    algorithm: ALGORITHM,
    pqAlgorithm: PQ_ALGORITHM,
    encapsulatedKey: Buffer.from(encapsulatedKey).toString("base64"),
    nonce: nonce.toString("base64"),
    salt: salt.toString("base64"),
    ciphertext: ciphertextWithTag.toString("base64"),
  };
}

/**
 * Decrypt data using hybrid post-quantum decryption
 * ML-KEM-768 + ChaCha20-Poly1305
 */
export function decryptPQ(
  encryptedData: PQEncryptedData,
  recipientSecretKey: Uint8Array
): Buffer {
  if (encryptedData.version !== CURRENT_VERSION) {
    throw new Error(`Unsupported PQ encryption version: ${encryptedData.version}`);
  }

  // Step 1: Decapsulate the shared secret
  const encapsulatedKey = new Uint8Array(Buffer.from(encryptedData.encapsulatedKey, "base64"));
  const sharedSecret = ml_kem768.decapsulate(encapsulatedKey, recipientSecretKey);

  // Step 2: Derive ChaCha20 key
  const salt = Buffer.from(encryptedData.salt, "base64");
  const chachaKey = crypto.createHash("sha256")
    .update(Buffer.from(sharedSecret))
    .update(salt)
    .digest();

  // Step 3: Split ciphertext and auth tag
  const ciphertextWithTag = Buffer.from(encryptedData.ciphertext, "base64");
  const ciphertext = ciphertextWithTag.subarray(0, -16);
  const authTag = ciphertextWithTag.subarray(-16);

  // Step 4: Decrypt with ChaCha20-Poly1305
  const nonce = Buffer.from(encryptedData.nonce, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, chachaKey, nonce, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Clear sensitive data from memory
  chachaKey.fill(0);

  return decrypted;
}

/**
 * Classical ChaCha20-Poly1305 encryption (fallback)
 */
export function encryptClassical(data: string | Buffer, key: Buffer): ClassicalEncryptedData {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: 16,
  });

  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf-8");
  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine ciphertext + auth tag
  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);

  return {
    version: CLASSICAL_VERSION,
    algorithm: ALGORITHM,
    nonce: nonce.toString("base64"),
    salt: salt.toString("base64"),
    ciphertext: ciphertextWithTag.toString("base64"),
  };
}

/**
 * Classical ChaCha20-Poly1305 decryption (fallback)
 */
export function decryptClassical(encryptedData: ClassicalEncryptedData, key: Buffer): Buffer {
  if (encryptedData.version !== CLASSICAL_VERSION) {
    throw new Error(`Unsupported classical encryption version: ${encryptedData.version}`);
  }

  const nonce = Buffer.from(encryptedData.nonce, "base64");
  const ciphertextWithTag = Buffer.from(encryptedData.ciphertext, "base64");
  const ciphertext = ciphertextWithTag.subarray(0, -16);
  const authTag = ciphertextWithTag.subarray(-16);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, {
    authTagLength: 16,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted;
}

/**
 * Decrypt legacy AES-GCM encrypted data (for migration)
 */
function decryptLegacyAES(
  encryptedData: LegacyAESEncryptedData,
  key: Buffer,
  pqSecretKey?: Uint8Array
): Buffer {
  let aesKey: Buffer;

  // Check if this is PQ encrypted (has encapsulatedKey)
  if (encryptedData.encapsulatedKey && pqSecretKey) {
    const encapsulatedKey = new Uint8Array(Buffer.from(encryptedData.encapsulatedKey, "base64"));
    const sharedSecret = ml_kem768.decapsulate(encapsulatedKey, pqSecretKey);
    const salt = Buffer.from(encryptedData.salt, "base64");
    aesKey = crypto.createHash("sha256")
      .update(Buffer.from(sharedSecret))
      .update(salt)
      .digest();
  } else {
    aesKey = key;
  }

  const iv = Buffer.from(encryptedData.iv, "base64");
  const tag = Buffer.from(encryptedData.tag, "base64");
  const ciphertext = Buffer.from(encryptedData.ciphertext, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, {
    authTagLength: 16,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Clear key if we derived it
  if (encryptedData.encapsulatedKey) {
    aesKey.fill(0);
  }

  return decrypted;
}

/**
 * Check if encrypted data is legacy AES-GCM format
 */
function isLegacyFormat(data: any): data is LegacyAESEncryptedData {
  return data && data.iv !== undefined && data.tag !== undefined;
}

/**
 * Post-Quantum Secure Storage Class
 *
 * Provides encrypted file storage using hybrid post-quantum encryption
 * with ChaCha20-Poly1305 (NOT AES-GCM).
 */
export class SecureStorage {
  private config: EncryptionConfig;
  private classicalKey: Buffer | null = null;
  private pqKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array } | null = null;
  private initialized: boolean = false;
  private keyStorePath: string;

  constructor(config?: Partial<EncryptionConfig>) {
    this.config = { ...getEncryptionConfig(), ...config };
    this.keyStorePath = path.join(
      process.env.NLMCP_CONFIG_DIR || path.join(os.homedir(), ".notebooklm-mcp"),
      "pq-keys.enc"
    );
  }

  /**
   * Initialize the secure storage (derive/load keys)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.config.enabled) {
      log.info("🔓 Encryption is disabled");
      this.initialized = true;
      return;
    }

    log.info("🔐 Initializing post-quantum secure storage (ChaCha20-Poly1305)...");

    try {
      // Initialize classical key for backward compatibility
      await this.initializeClassicalKey();

      // Initialize post-quantum keys if enabled
      if (this.config.usePostQuantum) {
        await this.initializePQKeys();
      }

      this.initialized = true;
    } catch (error) {
      log.error(`  ❌ Failed to initialize encryption: ${error}`);
      this.config.enabled = false;
      await audit.security("encryption_init_failed", "error", { error: String(error) });
    }
  }

  /**
   * Initialize classical encryption key
   */
  private async initializeClassicalKey(): Promise<void> {
    // Priority 1: Environment variable key
    if (this.config.key) {
      this.classicalKey = Buffer.from(this.config.key, "base64");
      if (this.classicalKey.length !== KEY_LENGTH) {
        throw new Error(`Invalid key length: expected ${KEY_LENGTH} bytes, got ${this.classicalKey.length}`);
      }
      log.success("  ✅ Using classical key from environment");
      await audit.security("encryption_init", "info", { key_source: "environment", algorithm: ALGORITHM });
      return;
    }

    // Priority 2: Key file
    if (this.config.keyFile && fs.existsSync(this.config.keyFile)) {
      const keyBase64 = fs.readFileSync(this.config.keyFile, "utf-8").trim();
      this.classicalKey = Buffer.from(keyBase64, "base64");
      if (this.classicalKey.length !== KEY_LENGTH) {
        throw new Error(`Invalid key length in file: expected ${KEY_LENGTH} bytes`);
      }
      log.success("  ✅ Using classical key from file");
      await audit.security("encryption_init", "info", { key_source: "file", algorithm: ALGORITHM });
      return;
    }

    // Priority 3: Machine-derived key (fallback)
    if (this.config.useMachineKey) {
      const machineKey = getMachineKey();
      const salt = Buffer.from("notebooklm-mcp-secure-salt-v3", "utf-8");
      this.classicalKey = deriveKey(machineKey, salt, this.config.pbkdf2Iterations);
      log.warning("  ⚠️ Using machine-derived classical key (less secure)");
      log.info("     Set NLMCP_ENCRYPTION_KEY for better security");
      await audit.security("encryption_init", "warning", { key_source: "machine_derived", algorithm: ALGORITHM });
      return;
    }

    // No key available
    log.warning("  ⚠️ No classical encryption key available");
    this.config.enabled = false;
    await audit.security("encryption_disabled", "warning", { reason: "no_key_available" });
  }

  /**
   * Initialize post-quantum keys
   */
  private async initializePQKeys(): Promise<void> {
    // Try to load existing PQ keys (may be in legacy or new format)
    if (fs.existsSync(this.keyStorePath) && this.classicalKey) {
      try {
        const content = fs.readFileSync(this.keyStorePath, "utf-8");
        const encrypted = JSON.parse(content);

        let decrypted: Buffer;

        // Check if legacy AES-GCM format
        if (isLegacyFormat(encrypted)) {
          log.info("  🔄 Migrating PQ keys from AES-GCM to ChaCha20-Poly1305...");
          decrypted = decryptLegacyAES(encrypted, this.classicalKey);
        } else {
          decrypted = decryptClassical(encrypted, this.classicalKey);
        }

        const keys = JSON.parse(decrypted.toString("utf-8"));

        this.pqKeyPair = {
          publicKey: new Uint8Array(Buffer.from(keys.publicKey, "base64")),
          secretKey: new Uint8Array(Buffer.from(keys.secretKey, "base64")),
        };

        // Re-save with new format if it was legacy
        if (isLegacyFormat(encrypted)) {
          await this.savePQKeys();
          log.success("  ✅ PQ keys migrated to ChaCha20-Poly1305");
        } else {
          log.success("  ✅ Loaded existing ML-KEM-768 key pair");
        }

        await audit.security("pq_keys_loaded", "info", { algorithm: ALGORITHM });
        return;
      } catch (error) {
        log.warning(`  ⚠️ Failed to load PQ keys, generating new: ${error}`);
      }
    }

    // Generate new PQ key pair
    log.info("  🔑 Generating new ML-KEM-768 key pair...");
    this.pqKeyPair = generatePQKeyPair();

    // Save encrypted PQ keys
    await this.savePQKeys();
    log.success("  ✅ Generated and saved ML-KEM-768 key pair");
    await audit.security("pq_keys_generated", "info", { algorithm: ALGORITHM });
  }

  /**
   * Save PQ keys with ChaCha20-Poly1305 encryption
   */
  private async savePQKeys(): Promise<void> {
    if (!this.classicalKey || !this.pqKeyPair) return;

    const keysJson = JSON.stringify({
      publicKey: Buffer.from(this.pqKeyPair.publicKey).toString("base64"),
      secretKey: Buffer.from(this.pqKeyPair.secretKey).toString("base64"),
    });

    const encrypted = encryptClassical(keysJson, this.classicalKey);

    const dir = path.dirname(this.keyStorePath);
    mkdirSecure(dir, PERMISSION_MODES.OWNER_FULL);

    writeFileSecure(
      this.keyStorePath,
      JSON.stringify(encrypted, null, 2),
      PERMISSION_MODES.OWNER_READ_WRITE
    );
  }

  /**
   * Save data to an encrypted file
   */
  async save(filePath: string, data: string | object): Promise<void> {
    await this.initialize();

    const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const dir = path.dirname(filePath);

    // Ensure directory exists with secure permissions
    mkdirSecure(dir, PERMISSION_MODES.OWNER_FULL);

    if (!this.config.enabled) {
      // Save unencrypted
      writeFileSecure(filePath, dataStr, PERMISSION_MODES.OWNER_READ_WRITE);
      log.info(`📝 Saved (unencrypted): ${path.basename(filePath)}`);
      return;
    }

    let encrypted: EncryptedData;
    let encryptedPath: string;

    // Use post-quantum encryption if available
    if (this.config.usePostQuantum && this.pqKeyPair) {
      encrypted = encryptPQ(dataStr, this.pqKeyPair.publicKey);
      encryptedPath = filePath + ".pqenc";
      log.info(`🔐 Saved with ML-KEM-768 + ChaCha20-Poly1305: ${path.basename(encryptedPath)}`);
    } else if (this.classicalKey) {
      encrypted = encryptClassical(dataStr, this.classicalKey);
      encryptedPath = filePath + ".enc";
      log.info(`🔐 Saved with ChaCha20-Poly1305: ${path.basename(encryptedPath)}`);
    } else {
      // Save unencrypted as fallback
      writeFileSecure(filePath, dataStr, PERMISSION_MODES.OWNER_READ_WRITE);
      log.warning(`⚠️ Saved unencrypted (no keys): ${path.basename(filePath)}`);
      return;
    }

    writeFileSecure(
      encryptedPath,
      JSON.stringify(encrypted, null, 2),
      PERMISSION_MODES.OWNER_READ_WRITE
    );

    // Remove unencrypted and other encrypted versions if they exist
    const extensions = ["", ".enc", ".pqenc"];
    for (const ext of extensions) {
      const oldPath = filePath + ext;
      if (oldPath !== encryptedPath && fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }
  }

  /**
   * Load data from an encrypted file
   */
  async load(filePath: string): Promise<string | null> {
    await this.initialize();

    // Check for PQ encrypted version first
    const pqEncryptedPath = filePath + ".pqenc";
    if (this.pqKeyPair && fs.existsSync(pqEncryptedPath)) {
      try {
        const content = fs.readFileSync(pqEncryptedPath, "utf-8");
        const encrypted = JSON.parse(content);

        let decrypted: Buffer;

        // Check if legacy AES-GCM format
        if (isLegacyFormat(encrypted)) {
          log.info(`🔄 Migrating ${path.basename(pqEncryptedPath)} from AES-GCM to ChaCha20-Poly1305...`);
          decrypted = decryptLegacyAES(encrypted, this.classicalKey!, this.pqKeyPair.secretKey);
          // Re-save with new format
          await this.save(filePath, decrypted.toString("utf-8"));
          log.success(`  ✅ Migration complete`);
        } else {
          decrypted = decryptPQ(encrypted as PQEncryptedData, this.pqKeyPair.secretKey);
        }

        log.info(`🔓 Loaded (ML-KEM-768 + ChaCha20): ${path.basename(pqEncryptedPath)}`);
        return decrypted.toString("utf-8");
      } catch (error) {
        log.error(`❌ Failed to decrypt ${pqEncryptedPath}: ${error}`);
        await audit.security("decryption_failed", "error", {
          file: pqEncryptedPath,
          type: "post-quantum",
          error: String(error),
        });
        return null;
      }
    }

    // Check for classical encrypted version
    const classicalEncryptedPath = filePath + ".enc";
    if (this.classicalKey && fs.existsSync(classicalEncryptedPath)) {
      try {
        const content = fs.readFileSync(classicalEncryptedPath, "utf-8");
        const encrypted = JSON.parse(content);

        let decrypted: Buffer;

        // Check if legacy AES-GCM format
        if (isLegacyFormat(encrypted)) {
          log.info(`🔄 Migrating ${path.basename(classicalEncryptedPath)} from AES-GCM to ChaCha20-Poly1305...`);
          decrypted = decryptLegacyAES(encrypted, this.classicalKey);
        } else {
          decrypted = decryptClassical(encrypted as ClassicalEncryptedData, this.classicalKey);
        }

        log.info(`🔓 Loaded (ChaCha20-Poly1305): ${path.basename(classicalEncryptedPath)}`);

        // Migrate to PQ encryption if enabled
        if (this.config.usePostQuantum && this.pqKeyPair) {
          log.info(`🔄 Upgrading ${path.basename(filePath)} to post-quantum encryption`);
          await this.save(filePath, decrypted.toString("utf-8"));
        } else if (isLegacyFormat(encrypted)) {
          // Re-save with ChaCha20-Poly1305 if it was legacy AES
          await this.save(filePath, decrypted.toString("utf-8"));
          log.success(`  ✅ Migration complete`);
        }

        return decrypted.toString("utf-8");
      } catch (error) {
        log.error(`❌ Failed to decrypt ${classicalEncryptedPath}: ${error}`);
        await audit.security("decryption_failed", "error", {
          file: classicalEncryptedPath,
          type: "classical",
          error: String(error),
        });
        return null;
      }
    }

    // Fall back to unencrypted version
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      log.info(`📝 Loaded (unencrypted): ${path.basename(filePath)}`);

      // Migrate to encrypted storage if enabled
      if (this.config.enabled && (this.pqKeyPair || this.classicalKey)) {
        log.info(`🔄 Encrypting ${path.basename(filePath)} with ChaCha20-Poly1305`);
        await this.save(filePath, content);
      }

      return content;
    }

    return null;
  }

  /**
   * Load JSON data from an encrypted file
   */
  async loadJSON<T>(filePath: string): Promise<T | null> {
    const content = await this.load(filePath);
    if (!content) return null;

    try {
      return JSON.parse(content) as T;
    } catch (error) {
      log.error(`❌ Failed to parse JSON from ${filePath}: ${error}`);
      return null;
    }
  }

  /**
   * Delete an encrypted file
   */
  async delete(filePath: string): Promise<boolean> {
    let deleted = false;

    const extensions = ["", ".enc", ".pqenc"];
    for (const ext of extensions) {
      const fullPath = filePath + ext;
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        deleted = true;
      }
    }

    return deleted;
  }

  /**
   * Check if a file exists (any encrypted or unencrypted version)
   */
  exists(filePath: string): boolean {
    return (
      fs.existsSync(filePath) ||
      fs.existsSync(filePath + ".enc") ||
      fs.existsSync(filePath + ".pqenc")
    );
  }

  /**
   * Get encryption status
   */
  getStatus(): {
    enabled: boolean;
    classicalKeySource: string;
    postQuantumEnabled: boolean;
    algorithm: string;
    pqAlgorithm: string | null;
  } {
    let classicalKeySource = "none";
    if (this.config.enabled && this.classicalKey) {
      if (this.config.key) classicalKeySource = "environment";
      else if (this.config.keyFile) classicalKeySource = "file";
      else classicalKeySource = "machine_derived";
    }

    return {
      enabled: this.config.enabled,
      classicalKeySource,
      postQuantumEnabled: this.config.usePostQuantum && this.pqKeyPair !== null,
      algorithm: ALGORITHM,
      pqAlgorithm: this.pqKeyPair ? PQ_ALGORITHM : null,
    };
  }

  /**
   * Generate a new random encryption key (classical)
   */
  static generateKey(): string {
    const key = crypto.randomBytes(KEY_LENGTH);
    return key.toString("base64");
  }

  /**
   * Export public key for sharing (e.g., for external encryption)
   */
  getPublicKey(): string | null {
    if (!this.pqKeyPair) return null;
    return Buffer.from(this.pqKeyPair.publicKey).toString("base64");
  }
}

/**
 * Global secure storage instance
 */
let globalSecureStorage: SecureStorage | null = null;

/**
 * Get or create the global secure storage
 */
export function getSecureStorage(): SecureStorage {
  if (!globalSecureStorage) {
    globalSecureStorage = new SecureStorage();
  }
  return globalSecureStorage;
}
