/**
 * Policy Documentation
 *
 * Machine-readable policy documentation for compliance.
 * Provides structured policies for GDPR, SOC2, and CSSF requirements.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import path from "path";
import fs from "fs";
import { CONFIG } from "../config.js";
import { mkdirSecure, writeFileSecure } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
import type { PolicyDocument, PolicyType } from "./types.js";

/**
 * Default policies
 */
const DEFAULT_POLICIES: PolicyDocument[] = [
  {
    id: "policy_privacy",
    type: "privacy_policy",
    version: "1.0.0",
    effective_date: "2025-01-01",
    title: "Privacy Policy",
    description: "Defines how personal data is collected, processed, and protected.",
    full_text: `
# Privacy Policy

## 1. Data Controller
Pantheon Security acts as the data processor. The user is the data controller for their own data.

## 2. Data Collected
- Browser session data (cookies, local storage)
- NotebookLM URLs and metadata
- Query history within sessions
- Security audit logs

## 3. Purpose of Processing
- Service provision: Enable NotebookLM access via MCP
- Session management: Maintain authenticated sessions
- Security: Audit logging and threat detection
- Compliance: Regulatory requirements

## 4. Legal Basis
- Contract: Core service functionality
- Legitimate Interest: Security logging
- Legal Obligation: Audit trail retention

## 5. Data Retention
- Session data: 24 hours
- Audit logs: 7 years (CSSF requirement)
- Consent records: 7 years

## 6. Data Subject Rights
- Access: Request copy of personal data
- Portability: Export in machine-readable format
- Erasure: Request deletion of personal data
- Rectification: Correct inaccurate data

## 7. Security Measures
- Hybrid post-quantum encryption for local at-rest secrets
- Memory scrubbing
- Tamper-evident logging
    `,
    regulations: ["GDPR"],
    data_types: ["personal_data", "session_data", "audit_logs"],
    enforced: true,
    enforcement_method: "automatic",
    last_reviewed: "2025-01-01",
    next_review: "2026-01-01",
    approved_by: "Pantheon Security",
  },
  {
    id: "policy_retention",
    type: "data_retention",
    version: "1.0.0",
    effective_date: "2025-01-01",
    title: "Data Retention Policy",
    description: "Defines retention periods and disposal procedures for all data types.",
    full_text: `
# Data Retention Policy

## 1. Purpose
Ensure data is retained for appropriate periods and disposed of securely.

## 2. Retention Periods

| Data Type | Retention Period | Reason |
|-----------|-----------------|--------|
| Audit logs | 7 years | CSSF Circular 20/750 |
| Compliance events | 7 years | CSSF Circular 20/750 |
| Consent records | 7 years | GDPR Article 7 |
| Session data | 24 hours | Operational necessity |
| Browser cache | 7 days | Performance |
| Error logs | 30 days | Troubleshooting |

## 3. Disposal Procedures
- Audit logs: Archived with integrity verification
- Session data: Secure deletion (3-pass overwrite)
- Credentials: Crypto shred (key destruction)

## 4. Exceptions
- Data involved in legal proceedings: Extended retention
- Security incidents: Extended retention for investigation

## 5. Review
This policy is reviewed annually or upon regulatory change.
    `,
    regulations: ["GDPR", "CSSF"],
    data_types: ["audit_logs", "session_data", "credentials"],
    enforced: true,
    enforcement_method: "automatic",
    last_reviewed: "2025-01-01",
    next_review: "2026-01-01",
    approved_by: "Pantheon Security",
  },
  {
    id: "policy_access_control",
    type: "access_control",
    version: "1.0.0",
    effective_date: "2025-01-01",
    title: "Access Control Policy",
    description: "Defines authentication and authorization requirements.",
    full_text: `
# Access Control Policy

## 1. Authentication
- Token-based MCP authentication (optional, recommended)
- Rate limiting: 5 failed attempts = 5 minute lockout
- Session timeout: 8 hours hard limit, 30 minutes inactivity

## 2. Authorization
- All data is local to the user
- No multi-user access control required
- Browser sessions are user-specific

## 3. Password/Token Requirements
- Minimum 32 bytes of entropy
- Generated via cryptographically secure random number generator

## 4. Session Management
- Hard timeout: 8 hours maximum session duration
- Inactivity timeout: 30 minutes
- Secure session storage (encrypted)

## 5. Logging
- All authentication events are logged
- Failed attempts are tracked for lockout
- Session lifecycle events recorded
    `,
    regulations: ["SOC2"],
    data_types: ["credentials", "session_data"],
    enforced: true,
    enforcement_method: "automatic",
    last_reviewed: "2025-01-01",
    next_review: "2026-01-01",
    approved_by: "Pantheon Security",
  },
  {
    id: "policy_encryption",
    type: "encryption",
    version: "1.0.0",
    effective_date: "2025-01-01",
    title: "Encryption Policy",
    description: "Defines encryption standards and key management procedures.",
    full_text: `
# Encryption Policy

## 1. Encryption at Rest
- Algorithm: ML-KEM-768 + ChaCha20-Poly1305 (hybrid post-quantum, local)
- Scope: secrets on disk (cookies, session state, auth tokens)
- Threat model: offline file theft. NOT Harvest-Now-Decrypt-Later
  (would require a remote PQ recipient, which this does not have)
- Key derivation: HKDF with secure random salt
- All sensitive data encrypted by default

## 2. Encryption in Transit
- TLS 1.3 minimum (system trust store)
- HSTS enforced

## 3. Key Management
- Keys generated using CSPRNG
- Keys stored in encrypted format
- Key rotation: On demand (manual)
- Key destruction: Secure overwrite (7 passes)

## 4. What's Encrypted
- Browser cookies and session state
- Notebook library metadata
- Audit logs (optional)
- PQ encryption keys (double encrypted)

## 5. Post-Quantum Readiness
Hybrid local encryption provides protection against:
- Current classical attacks
- Offline decryption attempts against locally stored secrets if quantum-capable attacks become practical
    `,
    regulations: ["SOC2", "GDPR"],
    data_types: ["credentials", "session_data", "notebook_metadata"],
    enforced: true,
    enforcement_method: "automatic",
    last_reviewed: "2025-01-01",
    next_review: "2026-01-01",
    approved_by: "Pantheon Security",
  },
  {
    id: "policy_incident_response",
    type: "incident_response",
    version: "1.0.0",
    effective_date: "2025-01-01",
    title: "Incident Response Policy",
    description: "Defines procedures for security incident detection and response.",
    full_text: `
# Incident Response Policy

## 1. Incident Classification
- Critical: Data breach, unauthorized access
- High: Failed encryption, repeated auth failures
- Medium: Unusual access patterns, mass export
- Low: Policy violations, configuration errors

## 2. Detection
- Automated breach detection rules
- Real-time monitoring of security events
- Threshold-based alerting

## 3. Response Procedures
1. Detect: Automated detection via rules
2. Contain: Block affected patterns/users
3. Investigate: Root cause analysis
4. Remediate: Fix underlying issue
5. Recover: Restore normal operations
6. Review: Post-incident analysis

## 4. Notification Requirements
- GDPR: 72 hours for data breaches
- CSSF: Immediate for significant incidents
- Internal: Alert on detection

## 5. Documentation
- All incidents logged with full timeline
- Actions taken recorded
- Root cause documented
- Remediation tracked
    `,
    regulations: ["GDPR", "SOC2", "CSSF"],
    data_types: ["audit_logs", "security_logs"],
    enforced: true,
    enforcement_method: "automatic",
    last_reviewed: "2025-01-01",
    next_review: "2026-01-01",
    approved_by: "Pantheon Security",
  },
];

/**
 * Policy Documentation Manager class
 */
export class PolicyDocManager {
  private static instance: PolicyDocManager;
  private policiesFile: string;
  private policies: Map<string, PolicyDocument> = new Map();
  private loaded: boolean = false;

  private constructor() {
    const config = CONFIG;
    this.policiesFile = path.join(config.configDir, "policies.json");
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): PolicyDocManager {
    if (!PolicyDocManager.instance) {
      PolicyDocManager.instance = new PolicyDocManager();
    }
    return PolicyDocManager.instance;
  }

  /**
   * Load policies
   */
  private async load(): Promise<void> {
    if (this.loaded) return;

    // Load default policies
    for (const policy of DEFAULT_POLICIES) {
      this.policies.set(policy.id, policy);
    }

    // Load custom policies
    try {
      if (fs.existsSync(this.policiesFile)) {
        const content = fs.readFileSync(this.policiesFile, "utf-8");
        const data = JSON.parse(content);
        if (data.policies && Array.isArray(data.policies)) {
          for (const policy of data.policies) {
            this.policies.set(policy.id, policy);
          }
        }
      }
    } catch (err) {
      log.debug(`policy-docs: load policies from file: ${err instanceof Error ? err.message : String(err)}`);
      // Use defaults
    }

    this.loaded = true;
  }

  /**
   * Save custom policies
   */
  private async save(): Promise<void> {
    const dir = path.dirname(this.policiesFile);
    mkdirSecure(dir);

    // Only save custom policies
    const customPolicies = Array.from(this.policies.values()).filter(
      p => !DEFAULT_POLICIES.find(dp => dp.id === p.id)
    );

    const data = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      policies: customPolicies,
    };

    writeFileSecure(this.policiesFile, JSON.stringify(data, null, 2));
  }

  /**
   * Get all policies
   */
  public async getAllPolicies(): Promise<PolicyDocument[]> {
    await this.load();
    return Array.from(this.policies.values());
  }

  /**
   * Get policy by ID
   */
  public async getPolicy(policyId: string): Promise<PolicyDocument | null> {
    await this.load();
    return this.policies.get(policyId) || null;
  }

  /**
   * Get policies by type
   */
  public async getPoliciesByType(type: PolicyType): Promise<PolicyDocument[]> {
    await this.load();
    return Array.from(this.policies.values()).filter(p => p.type === type);
  }

  /**
   * Get policies by regulation
   */
  public async getPoliciesByRegulation(regulation: string): Promise<PolicyDocument[]> {
    await this.load();
    return Array.from(this.policies.values()).filter(
      p => p.regulations.includes(regulation)
    );
  }

  /**
   * Get enforced policies
   */
  public async getEnforcedPolicies(): Promise<PolicyDocument[]> {
    await this.load();
    return Array.from(this.policies.values()).filter(p => p.enforced);
  }

  /**
   * Get policies due for review
   */
  public async getPoliciesDueForReview(): Promise<PolicyDocument[]> {
    await this.load();
    const now = new Date();

    return Array.from(this.policies.values()).filter(p => {
      const nextReview = new Date(p.next_review);
      return nextReview <= now;
    });
  }

  /**
   * Add or update a custom policy
   */
  public async upsertPolicy(policy: PolicyDocument): Promise<void> {
    await this.load();
    this.policies.set(policy.id, policy);
    await this.save();
  }

  /**
   * Remove a custom policy
   */
  public async removePolicy(policyId: string): Promise<boolean> {
    await this.load();

    // Don't remove default policies
    if (DEFAULT_POLICIES.find(p => p.id === policyId)) {
      return false;
    }

    if (!this.policies.has(policyId)) {
      return false;
    }

    this.policies.delete(policyId);
    await this.save();

    return true;
  }

  /**
   * Get policy summary for compliance dashboard
   */
  public async getPolicySummary(): Promise<{
    total_policies: number;
    enforced_policies: number;
    by_type: Record<PolicyType, number>;
    by_regulation: Record<string, number>;
    due_for_review: number;
  }> {
    await this.load();

    const policies = Array.from(this.policies.values());

    const byType: Record<PolicyType, number> = {
      privacy_policy: 0,
      data_retention: 0,
      access_control: 0,
      encryption: 0,
      incident_response: 0,
      acceptable_use: 0,
    };

    const byRegulation: Record<string, number> = {};

    for (const policy of policies) {
      byType[policy.type]++;
      for (const reg of policy.regulations) {
        byRegulation[reg] = (byRegulation[reg] || 0) + 1;
      }
    }

    const dueForReview = (await this.getPoliciesDueForReview()).length;

    return {
      total_policies: policies.length,
      enforced_policies: policies.filter(p => p.enforced).length,
      by_type: byType,
      by_regulation: byRegulation,
      due_for_review: dueForReview,
    };
  }

  /**
   * Export policies for audit
   */
  public async exportForAudit(): Promise<{
    exported_at: string;
    summary: {
      total_policies: number;
      enforced_policies: number;
      by_type: Record<PolicyType, number>;
      by_regulation: Record<string, number>;
      due_for_review: number;
    };
    policies: PolicyDocument[];
  }> {
    const summary = await this.getPolicySummary();
    const policies = await this.getAllPolicies();

    return {
      exported_at: new Date().toISOString(),
      summary,
      policies,
    };
  }
}

// ============================================
// SINGLETON ACCESS
// ============================================

/**
 * Get the policy documentation manager instance
 */
export function getPolicyDocManager(): PolicyDocManager {
  return PolicyDocManager.getInstance();
}

// ============================================
// CONVENIENCE EXPORTS
// ============================================

/**
 * Get all policies
 */
export async function getAllPolicies(): Promise<PolicyDocument[]> {
  return getPolicyDocManager().getAllPolicies();
}

/**
 * Get policy by ID
 */
export async function getPolicy(policyId: string): Promise<PolicyDocument | null> {
  return getPolicyDocManager().getPolicy(policyId);
}

/**
 * Get policies by regulation
 */
export async function getPoliciesByRegulation(regulation: string): Promise<PolicyDocument[]> {
  return getPolicyDocManager().getPoliciesByRegulation(regulation);
}

/**
 * Get policy summary
 */
export async function getPolicySummary(): Promise<ReturnType<PolicyDocManager["getPolicySummary"]>> {
  return getPolicyDocManager().getPolicySummary();
}
