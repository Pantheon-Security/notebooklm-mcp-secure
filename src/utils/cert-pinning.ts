/**
 * Certificate Pinning for NotebookLM MCP Server
 *
 * Provides certificate pinning for HTTPS connections:
 * - Pin Google's root CA certificates
 * - Detect MITM attacks
 * - Validate certificate chains
 *
 * Why this matters:
 * - Prevents man-in-the-middle attacks
 * - Protects against rogue CA certificates
 * - Ensures only Google's real servers are trusted
 *
 * Added by Pantheon Security for hardened fork.
 */

import https from "https";
import tls from "tls";
import crypto from "crypto";
import { log } from "./logger.js";
import { audit } from "./audit-logger.js";

/**
 * Google's trusted root CA Subject Public Key Info (SPKI) hashes
 * These are SHA-256 hashes of the Subject Public Key Info
 *
 * Updated: November 2025
 * Sources:
 * - Google Trust Services roots: https://pki.goog/
 * - GTS Root R1, R2, R3, R4
 * - GlobalSign Root CA (backup)
 */
const PINNED_CERTIFICATES: Record<string, string[]> = {
  // Google Trust Services roots
  "*.google.com": [
    // GTS Root R1
    "hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=",
    // GTS Root R2
    "Vfd95BwDeSQo+NUYxVEEIBvvpOs/QbsFp7DeP0Cr1pE=",
    // GTS Root R3
    "QXnt2YHvdHR3tJYmQIr0Paosp6t/nggsEGD4QJZ3Q0g=",
    // GTS Root R4
    "mEflZT5enoR1FuXLgYYGqnVEoZvmf9c2bVBpiOjYQ0c=",
    // GlobalSign Root CA - R2 (backup)
    "iie1VXtL7HzAMF+/PVPR9xzT80kQxdZeJ+zduCB3uj0=",
    // DigiCert Global Root G2 (backup)
    "i7WTqTvh0OioIruIfFR4kMPnBqrS2rdiVPl/s2uC/CY=",
  ],
  "notebooklm.google.com": [
    // Same as *.google.com
    "hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=",
    "Vfd95BwDeSQo+NUYxVEEIBvvpOs/QbsFp7DeP0Cr1pE=",
    "QXnt2YHvdHR3tJYmQIr0Paosp6t/nggsEGD4QJZ3Q0g=",
    "mEflZT5enoR1FuXLgYYGqnVEoZvmf9c2bVBpiOjYQ0c=",
    "iie1VXtL7HzAMF+/PVPR9xzT80kQxdZeJ+zduCB3uj0=",
    "i7WTqTvh0OioIruIfFR4kMPnBqrS2rdiVPl/s2uC/CY=",
  ],
  "accounts.google.com": [
    // Same as *.google.com
    "hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=",
    "Vfd95BwDeSQo+NUYxVEEIBvvpOs/QbsFp7DeP0Cr1pE=",
    "QXnt2YHvdHR3tJYmQIr0Paosp6t/nggsEGD4QJZ3Q0g=",
    "mEflZT5enoR1FuXLgYYGqnVEoZvmf9c2bVBpiOjYQ0c=",
    "iie1VXtL7HzAMF+/PVPR9xzT80kQxdZeJ+zduCB3uj0=",
    "i7WTqTvh0OioIruIfFR4kMPnBqrS2rdiVPl/s2uC/CY=",
  ],
};

/**
 * Configuration for certificate pinning
 */
export interface CertPinningConfig {
  /** Enable certificate pinning (default: true) */
  enabled: boolean;
  /** Allow connections to fail open if pinning fails (default: false for security) */
  failOpen: boolean;
  /** Report-only mode - log but don't block (default: false) */
  reportOnly: boolean;
  /** Additional pinned certificates (SPKI hashes) */
  additionalPins: Record<string, string[]>;
}

/**
 * Get certificate pinning configuration
 */
function getPinningConfig(): CertPinningConfig {
  return {
    enabled: process.env.NLMCP_CERT_PINNING !== "false",
    failOpen: process.env.NLMCP_CERT_FAIL_OPEN === "true",
    reportOnly: process.env.NLMCP_CERT_REPORT_ONLY === "true",
    additionalPins: {},
  };
}

/**
 * Calculate SPKI hash for a certificate
 */
export function calculateSPKIHash(cert: tls.PeerCertificate): string {
  // Get the public key in DER format
  const pubkey = cert.pubkey;
  if (!pubkey) {
    throw new Error("Certificate has no public key");
  }

  // Calculate SHA-256 hash and encode as base64
  const hash = crypto.createHash("sha256").update(pubkey).digest("base64");
  return hash;
}

/**
 * Get all SPKI hashes from a certificate chain
 */
export function getCertificateChainHashes(socket: tls.TLSSocket): string[] {
  const hashes: string[] = [];
  const cert = socket.getPeerCertificate(true);

  if (!cert || !cert.raw) {
    return hashes;
  }

  // Walk the certificate chain
  let current: tls.DetailedPeerCertificate | undefined = cert as tls.DetailedPeerCertificate;
  const seen = new Set<string>();

  while (current && current.raw) {
    const fingerprint = current.fingerprint256;
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);

    try {
      if (current.pubkey) {
        const hash = crypto.createHash("sha256").update(current.pubkey).digest("base64");
        hashes.push(hash);
      }
    } catch {
      // Skip certificates we can't hash
    }

    current = current.issuerCertificate as tls.DetailedPeerCertificate | undefined;
  }

  return hashes;
}

/**
 * Validate a certificate chain against pinned certificates
 */
export function validateCertificatePin(
  hostname: string,
  chainHashes: string[],
  config: CertPinningConfig = getPinningConfig()
): { valid: boolean; matchedPin?: string; error?: string } {
  if (!config.enabled) {
    return { valid: true };
  }

  // Get pins for this hostname
  const pins = getPinsForHostname(hostname, config);

  if (pins.length === 0) {
    // No pins configured for this host
    return { valid: true };
  }

  // Check if any certificate in the chain matches a pin
  for (const hash of chainHashes) {
    if (pins.includes(hash)) {
      return { valid: true, matchedPin: hash };
    }
  }

  // No match found
  const error = `Certificate pinning failed for ${hostname}. ` +
    `Chain hashes: [${chainHashes.join(", ")}]. ` +
    `Expected one of: [${pins.join(", ")}]`;

  return { valid: false, error };
}

/**
 * Get pinned certificates for a hostname
 */
function getPinsForHostname(hostname: string, config: CertPinningConfig): string[] {
  const pins: string[] = [];

  // Check exact match
  if (PINNED_CERTIFICATES[hostname]) {
    pins.push(...PINNED_CERTIFICATES[hostname]);
  }

  // Check wildcard match
  const parts = hostname.split(".");
  if (parts.length >= 2) {
    const wildcard = "*." + parts.slice(1).join(".");
    if (PINNED_CERTIFICATES[wildcard]) {
      pins.push(...PINNED_CERTIFICATES[wildcard]);
    }
  }

  // Check additional pins from config
  if (config.additionalPins[hostname]) {
    pins.push(...config.additionalPins[hostname]);
  }

  return [...new Set(pins)]; // Deduplicate
}

/**
 * Certificate Pinning Manager
 */
export class CertificatePinningManager {
  private config: CertPinningConfig;
  private violationCount: number = 0;
  private lastViolation?: {
    hostname: string;
    timestamp: Date;
    chainHashes: string[];
  };

  constructor(config?: Partial<CertPinningConfig>) {
    this.config = { ...getPinningConfig(), ...config };
  }

  /**
   * Check if pinning is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Validate a TLS connection
   */
  async validateConnection(socket: tls.TLSSocket, hostname: string): Promise<boolean> {
    if (!this.config.enabled) {
      return true;
    }

    const chainHashes = getCertificateChainHashes(socket);
    const result = validateCertificatePin(hostname, chainHashes, this.config);

    if (!result.valid) {
      this.violationCount++;
      this.lastViolation = {
        hostname,
        timestamp: new Date(),
        chainHashes,
      };

      // Log the violation
      log.error(`🔒 Certificate pinning violation for ${hostname}`);
      log.error(`   Chain hashes: ${chainHashes.join(", ")}`);

      await audit.security("cert_pinning_violation", "critical", {
        hostname,
        chain_hashes: chainHashes,
        error: result.error,
        report_only: this.config.reportOnly,
      });

      if (this.config.reportOnly) {
        log.warning("   (Report-only mode - connection allowed)");
        return true;
      }

      if (this.config.failOpen) {
        log.warning("   (Fail-open mode - connection allowed)");
        return true;
      }

      return false;
    }

    if (result.matchedPin) {
      log.info(`🔒 Certificate pinning verified for ${hostname}`);
    }

    return true;
  }

  /**
   * Create an HTTPS agent with certificate pinning
   */
  createPinnedAgent(_hostname: string): https.Agent {
    const self = this;

    return new https.Agent({
      checkServerIdentity: (host: string, cert: tls.PeerCertificate) => {
        // First do normal hostname verification
        const err = tls.checkServerIdentity(host, cert);
        if (err) {
          return err;
        }

        // Then check certificate pinning
        if (self.config.enabled && cert.pubkey) {
          const hash = crypto.createHash("sha256").update(cert.pubkey).digest("base64");
          const pins = getPinsForHostname(host, self.config);

          if (pins.length > 0 && !pins.includes(hash)) {
            self.violationCount++;

            if (!self.config.reportOnly && !self.config.failOpen) {
              return new Error(`Certificate pinning failed for ${host}`);
            }
          }
        }

        return undefined;
      },
    });
  }

  /**
   * Get violation statistics
   */
  getStats(): {
    enabled: boolean;
    reportOnly: boolean;
    violationCount: number;
    lastViolation?: {
      hostname: string;
      timestamp: Date;
    };
  } {
    return {
      enabled: this.config.enabled,
      reportOnly: this.config.reportOnly,
      violationCount: this.violationCount,
      lastViolation: this.lastViolation
        ? {
            hostname: this.lastViolation.hostname,
            timestamp: this.lastViolation.timestamp,
          }
        : undefined,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CertPinningConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Add a custom pin for a hostname
   */
  addPin(hostname: string, spkiHash: string): void {
    if (!this.config.additionalPins[hostname]) {
      this.config.additionalPins[hostname] = [];
    }
    if (!this.config.additionalPins[hostname].includes(spkiHash)) {
      this.config.additionalPins[hostname].push(spkiHash);
    }
  }
}

/**
 * Global certificate pinning manager
 */
let globalPinningManager: CertificatePinningManager | null = null;

/**
 * Get or create the global pinning manager
 */
export function getCertificatePinningManager(): CertificatePinningManager {
  if (!globalPinningManager) {
    globalPinningManager = new CertificatePinningManager();
  }
  return globalPinningManager;
}

/**
 * Utility to extract and display certificate pins from a hostname
 * Useful for updating pinned certificates
 */
export async function extractCertificatePins(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const options = {
      host: hostname,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
    };

    const socket = tls.connect(options, () => {
      try {
        const hashes = getCertificateChainHashes(socket);
        socket.end();
        resolve(hashes);
      } catch (error) {
        socket.end();
        reject(error);
      }
    });

    socket.on("error", reject);
    socket.setTimeout(10000, () => {
      socket.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}
