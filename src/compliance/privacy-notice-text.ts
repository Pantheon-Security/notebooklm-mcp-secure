/**
 * Privacy Notice Text Content
 *
 * Contains the privacy notice content for display to users.
 * Structured for GDPR compliance (Articles 13/14).
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import type { PrivacyNotice } from "./types.js";

/**
 * Current privacy notice version
 */
export const PRIVACY_NOTICE_VERSION = "1.0.0";

/**
 * Full privacy notice content
 */
export const PRIVACY_NOTICE: PrivacyNotice = {
  version: PRIVACY_NOTICE_VERSION,
  effective_date: "2025-01-01",

  sections: {
    data_controller: `Pantheon Security
Email: support@pantheonsecurity.io
Website: https://pantheonsecurity.io

This tool is designed for local use only. All data is processed and stored on your local device.`,

    data_collected: [
      "Browser session data (cookies, local storage) - Required for NotebookLM authentication",
      "NotebookLM URLs and notebook metadata - Your saved notebook library",
      "Query history within sessions - For contextual follow-up questions",
      "Security audit logs - For security monitoring and compliance",
      "User settings and preferences - Your configuration choices",
    ],

    purposes: [
      "Service Provision - Enable access to NotebookLM through the MCP protocol",
      "Session Management - Maintain your authenticated browser session",
      "Security Logging - Detect and prevent unauthorized access",
      "Error Diagnostics - Debug issues and improve the service",
    ],

    legal_basis: [
      "Contract - Processing necessary to provide the service you requested",
      "Legitimate Interest - Security logging and error diagnostics",
      "Legal Obligation - Audit log retention for compliance (where applicable)",
    ],

    retention: `Data retention periods:
- Session data: Cleared after 24 hours or on logout
- Browser cookies: Encrypted and retained for service functionality
- Audit logs: 7 years (configurable, for regulatory compliance)
- Notebook library: Retained until you delete it
- Settings: Retained until you delete them`,

    rights: [
      "Access - Request a copy of all your personal data",
      "Portability - Export your data in machine-readable format",
      "Erasure - Request deletion of your personal data",
      "Rectification - Correct inaccurate personal data",
      "Objection - Object to processing based on legitimate interest",
      "Restriction - Request limited processing of your data",
    ],

    contact: `For data protection inquiries:
Email: support@pantheonsecurity.io
GitHub: https://github.com/Pantheon-Security/notebooklm-mcp-secure`,
  },

  summary: `This tool processes data locally on your device to enable NotebookLM access via MCP.

What we collect:
- Browser session data (cookies, local storage)
- NotebookLM URLs and metadata
- Security audit logs

All data is:
- Stored locally only (no cloud sync)
- Encrypted with post-quantum cryptography
- Subject to automatic retention policies

Your rights: Access, Export, Erasure, Portability`,
};

/**
 * CLI-formatted privacy notice for terminal display
 */
export function getPrivacyNoticeCLI(): string {
  const notice = PRIVACY_NOTICE;
  const width = 68;
  const border = "═".repeat(width);

  return `
╔${border}╗
║${"PRIVACY NOTICE v" + notice.version}${" ".repeat(width - 18 - notice.version.length)}║
╠${border}╣
║${" ".repeat(width)}║
║  This tool processes the following data locally on your device:${" ".repeat(width - 65)}║
║${" ".repeat(width)}║
║  • Browser session data (cookies, local storage)${" ".repeat(width - 51)}║
║  • NotebookLM URLs and metadata${" ".repeat(width - 34)}║
║  • Query history (for session context)${" ".repeat(width - 41)}║
║  • Security audit logs${" ".repeat(width - 25)}║
║${" ".repeat(width)}║
║  All data is:${" ".repeat(width - 15)}║
║  ✓ Stored locally only (no cloud sync)${" ".repeat(width - 41)}║
║  ✓ Encrypted with post-quantum cryptography${" ".repeat(width - 46)}║
║  ✓ Subject to automatic retention policies${" ".repeat(width - 44)}║
║${" ".repeat(width)}║
║  Your rights: Access, Export, Erasure, Portability${" ".repeat(width - 53)}║
║${" ".repeat(width)}║
║  Full policy: https://github.com/Pantheon-Security/...${" ".repeat(width - 57)}║
║${" ".repeat(width)}║
╠${border}╣
║  By continuing, you acknowledge this privacy notice.${" ".repeat(width - 55)}║
║${" ".repeat(width)}║
║  [Press Enter to continue, or Ctrl+C to exit]${" ".repeat(width - 48)}║
╚${border}╝
`;
}

/**
 * Compact privacy notice for JSON responses
 */
export function getPrivacyNoticeCompact(): {
  version: string;
  summary: string;
  data_collected: string[];
  purposes: string[];
  rights: string[];
  full_notice_url: string;
} {
  return {
    version: PRIVACY_NOTICE.version,
    summary: PRIVACY_NOTICE.summary,
    data_collected: PRIVACY_NOTICE.sections.data_collected,
    purposes: PRIVACY_NOTICE.sections.purposes,
    rights: PRIVACY_NOTICE.sections.rights,
    full_notice_url: process.env.NLMCP_PRIVACY_NOTICE_URL ||
      "https://github.com/Pantheon-Security/notebooklm-mcp-secure/blob/main/SECURITY.md",
  };
}

/**
 * Get structured privacy notice for MCP tool response
 */
export function getPrivacyNoticeStructured(): {
  version: string;
  effective_date: string;
  data_controller: string;
  data_collected: string[];
  purposes: string[];
  legal_basis: string[];
  retention: string;
  rights: string[];
  contact: string;
} {
  return {
    version: PRIVACY_NOTICE.version,
    effective_date: PRIVACY_NOTICE.effective_date,
    data_controller: PRIVACY_NOTICE.sections.data_controller,
    data_collected: PRIVACY_NOTICE.sections.data_collected,
    purposes: PRIVACY_NOTICE.sections.purposes,
    legal_basis: PRIVACY_NOTICE.sections.legal_basis,
    retention: PRIVACY_NOTICE.sections.retention,
    rights: PRIVACY_NOTICE.sections.rights,
    contact: PRIVACY_NOTICE.sections.contact,
  };
}

/**
 * Get data processing agreement summary
 */
export function getProcessingAgreement(): {
  version: string;
  processor: string;
  sub_processors: string[];
  data_location: string;
  security_measures: string[];
  breach_notification: string;
} {
  return {
    version: PRIVACY_NOTICE.version,
    processor: "Pantheon Security (local processing only)",
    sub_processors: [
      "None - All data is processed locally on your device",
    ],
    data_location: "Local device only (no cloud transfer)",
    security_measures: [
      "Post-quantum encryption (ML-KEM-768 + ChaCha20-Poly1305)",
      "Memory scrubbing for sensitive data",
      "Tamper-evident audit logging",
      "Secure file permissions",
    ],
    breach_notification: "In the unlikely event of a data breach, we will notify affected users within 72 hours as required by GDPR.",
  };
}
