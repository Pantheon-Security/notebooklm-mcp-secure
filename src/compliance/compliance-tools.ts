/**
 * Compliance MCP Tools
 *
 * Exposes compliance features as MCP tools for Claude integration.
 * Provides structured access to compliance dashboard, reports, and evidence.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

import type { Tool, TextContent } from "@modelcontextprotocol/sdk/types.js";
import { getComplianceDashboard, getDashboardCLI } from "./dashboard.js";
import { getReportGenerator, type ReportType, type ReportFormat } from "./report-generator.js";
import { getEvidenceCollector } from "./evidence-collector.js";
import { getConsentManager } from "./consent-manager.js";
import { getDSARHandler } from "./dsar-handler.js";
import { getDataExporter } from "./data-export.js";
import { getDataErasureManager } from "./data-erasure.js";
import { getHealthMonitor } from "./health-monitor.js";
import { getPolicyDocManager } from "./policy-docs.js";
import { getComplianceLogger } from "./compliance-logger.js";
import { getIncidentManager } from "./incident-manager.js";
import type { IncidentType, IncidentSeverity, ConsentPurpose } from "./types.js";
import { audit } from "../utils/audit-logger.js";

/**
 * Tool definitions for compliance features
 */
export function getComplianceTools(): Tool[] {
  return [
    // Dashboard Tools
    {
      name: "compliance_dashboard",
      description: "Get comprehensive compliance dashboard with GDPR, SOC2, and CSSF status. Shows overall compliance score, health status, and key metrics.",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: {
            type: "string",
            enum: ["json", "cli"],
            description: "Output format: 'json' for structured data, 'cli' for human-readable text",
            default: "cli",
          },
        },
      },
    },
    {
      name: "compliance_score",
      description: "Get current compliance score (0-100) for each regulation and overall. Includes detailed breakdown by category.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },

    // Report Tools
    {
      name: "generate_compliance_report",
      description: "Generate a compliance audit report. Supports multiple report types and formats.",
      inputSchema: {
        type: "object" as const,
        properties: {
          report_type: {
            type: "string",
            enum: [
              "compliance_summary",
              "gdpr_audit",
              "soc2_audit",
              "cssf_audit",
              "security_audit",
              "incident_report",
              "dsar_report",
              "retention_report",
              "change_management",
              "full_audit",
            ],
            description: "Type of report to generate",
          },
          format: {
            type: "string",
            enum: ["json", "csv", "html"],
            description: "Output format",
            default: "json",
          },
          from_date: {
            type: "string",
            description: "Start date (ISO format). Defaults to 30 days ago.",
          },
          to_date: {
            type: "string",
            description: "End date (ISO format). Defaults to now.",
          },
          save_to_disk: {
            type: "boolean",
            description: "Whether to save the report to disk",
            default: false,
          },
        },
        required: ["report_type"],
      },
    },

    // Evidence Collection Tools
    {
      name: "collect_audit_evidence",
      description: "Collect evidence package for compliance audits. Creates a verifiable package with checksums.",
      inputSchema: {
        type: "object" as const,
        properties: {
          regulation: {
            type: "string",
            enum: ["GDPR", "SOC2", "CSSF", "all"],
            description: "Regulation to collect evidence for, or 'all' for comprehensive package",
            default: "all",
          },
          from_date: {
            type: "string",
            description: "Start date (ISO format)",
          },
          to_date: {
            type: "string",
            description: "End date (ISO format)",
          },
          save_to_disk: {
            type: "boolean",
            description: "Whether to save the evidence package to disk",
            default: true,
          },
        },
      },
    },
    {
      name: "verify_evidence_integrity",
      description: "Verify the integrity of an evidence package using cryptographic checksums.",
      inputSchema: {
        type: "object" as const,
        properties: {
          package_id: {
            type: "string",
            description: "The evidence package ID to verify",
          },
        },
        required: ["package_id"],
      },
    },
    {
      name: "list_evidence_packages",
      description: "List all saved evidence packages with their metadata.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },

    // GDPR Data Subject Rights Tools
    {
      name: "submit_dsar",
      description: "Submit a Data Subject Access Request (GDPR Article 15-17, 20). Initiates the DSAR workflow.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["access", "rectification", "erasure", "portability", "restriction", "objection"],
            description: "Type of DSAR",
          },
          data_subject_id: {
            type: "string",
            description: "Identifier for the data subject (optional, defaults to current user)",
          },
          details: {
            type: "string",
            description: "Additional details or specific data categories requested",
          },
        },
        required: ["type"],
      },
    },
    {
      name: "export_user_data",
      description: "Export all user data in machine-readable format (GDPR Article 20 - Right to Data Portability).",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: {
            type: "string",
            enum: ["json", "csv"],
            description: "Export format",
            default: "json",
          },
          include_categories: {
            type: "array",
            items: { type: "string" },
            description: "Specific data categories to include (leave empty for all)",
          },
        },
      },
    },
    {
      name: "request_data_erasure",
      description: "Request erasure of personal data (GDPR Article 17 - Right to Erasure). Creates an erasure request for review.",
      inputSchema: {
        type: "object" as const,
        properties: {
          data_categories: {
            type: "array",
            items: { type: "string" },
            description: "Specific data categories to erase (leave empty for all erasable data)",
          },
          reason: {
            type: "string",
            description: "Reason for erasure request",
          },
        },
      },
    },

    // Consent Management Tools
    {
      name: "get_consent_status",
      description: "Get current consent status for all data processing purposes.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "grant_consent",
      description: "Grant consent for a specific data processing purpose.",
      inputSchema: {
        type: "object" as const,
        properties: {
          purpose: {
            type: "string",
            description: "The purpose for which consent is being granted",
          },
          legal_basis: {
            type: "string",
            enum: ["consent", "contract", "legal_obligation", "vital_interest", "public_interest", "legitimate_interest"],
            description: "Legal basis for processing",
            default: "consent",
          },
        },
        required: ["purpose"],
      },
    },
    {
      name: "revoke_consent",
      description: "Revoke previously granted consent for a data processing purpose.",
      inputSchema: {
        type: "object" as const,
        properties: {
          purpose: {
            type: "string",
            description: "The purpose for which consent is being revoked",
          },
        },
        required: ["purpose"],
      },
    },

    // Security & Incident Tools
    {
      name: "report_security_incident",
      description: "Report a security incident for investigation and tracking.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: [
              "data_breach",
              "unauthorized_access",
              "policy_violation",
              "suspicious_activity",
              "system_compromise",
              "data_loss",
              "other",
            ],
            description: "Type of security incident",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "Incident severity",
          },
          title: {
            type: "string",
            description: "Brief title for the incident",
          },
          description: {
            type: "string",
            description: "Detailed description of the incident",
          },
        },
        required: ["type", "severity", "title", "description"],
      },
    },
    {
      name: "get_incident_status",
      description: "Get status of security incidents including open, investigating, and resolved counts.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },

    // Health & Monitoring Tools
    {
      name: "run_health_check",
      description: "Run a comprehensive health check of all compliance components.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "verify_audit_log_integrity",
      description: "Verify the integrity of compliance audit logs using hash chain verification.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },

    // Policy Tools
    {
      name: "list_policies",
      description: "List all compliance policies with their status and review dates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          regulation: {
            type: "string",
            enum: ["GDPR", "SOC2", "CSSF"],
            description: "Filter by regulation (optional)",
          },
        },
      },
    },
    {
      name: "get_policy",
      description: "Get detailed information about a specific compliance policy.",
      inputSchema: {
        type: "object" as const,
        properties: {
          policy_id: {
            type: "string",
            description: "The policy ID to retrieve",
          },
        },
        required: ["policy_id"],
      },
    },
  ];
}

/**
 * Handle compliance tool calls
 */
export async function handleComplianceToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const startTime = Date.now();
  try {
    let result: TextContent[];
    switch (toolName) {
      // Dashboard Tools
      case "compliance_dashboard":
        result = await handleComplianceDashboard(args);
        break;
      case "compliance_score":
        result = await handleComplianceScore();
        break;

      // Report Tools
      case "generate_compliance_report":
        result = await handleGenerateReport(args);
        break;

      // Evidence Tools
      case "collect_audit_evidence":
        result = await handleCollectEvidence(args);
        break;
      case "verify_evidence_integrity":
        result = await handleVerifyEvidence(args);
        break;
      case "list_evidence_packages":
        result = await handleListEvidence();
        break;

      // DSAR Tools
      case "submit_dsar":
        result = await handleSubmitDSAR(args);
        break;
      case "export_user_data":
        result = await handleExportUserData(args);
        break;
      case "request_data_erasure":
        result = await handleRequestErasure(args);
        break;

      // Consent Tools
      case "get_consent_status":
        result = await handleGetConsentStatus();
        break;
      case "grant_consent":
        result = await handleGrantConsent(args);
        break;
      case "revoke_consent":
        result = await handleRevokeConsent(args);
        break;

      // Security Tools
      case "report_security_incident":
        result = await handleReportIncident(args);
        break;
      case "get_incident_status":
        result = await handleGetIncidentStatus();
        break;

      // Health Tools
      case "run_health_check":
        result = await handleRunHealthCheck();
        break;
      case "verify_audit_log_integrity":
        result = await handleVerifyIntegrity();
        break;

      // Policy Tools
      case "list_policies":
        result = await handleListPolicies(args);
        break;
      case "get_policy":
        result = await handleGetPolicy(args);
        break;

      default:
        result = [{ type: "text", text: `Unknown compliance tool: ${toolName}` }];
    }
    await audit.tool(toolName, args, true, Date.now() - startTime);
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await audit.tool(toolName, args, false, Date.now() - startTime, errorMessage);
    return [
      {
        type: "text",
        text: `Error executing ${toolName}: ${errorMessage}`,
      },
    ];
  }
}

// ============================================
// TOOL HANDLERS
// ============================================

async function handleComplianceDashboard(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const format = (args.format as string) || "cli";

  if (format === "cli") {
    const cliOutput = await getDashboardCLI();
    return [{ type: "text", text: cliOutput }];
  }

  const dashboard = getComplianceDashboard();
  const data = await dashboard.generateDashboard();
  return [{ type: "text", text: JSON.stringify(data, null, 2) }];
}

async function handleComplianceScore(): Promise<TextContent[]> {
  const dashboard = getComplianceDashboard();
  const score = await dashboard.getComplianceScore();
  return [{ type: "text", text: JSON.stringify(score, null, 2) }];
}

async function handleGenerateReport(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const reportGenerator = getReportGenerator();
  const reportType = args.report_type as ReportType;
  const format = (args.format as ReportFormat) || "json";
  const fromDate = args.from_date ? new Date(args.from_date as string) : undefined;
  const toDate = args.to_date ? new Date(args.to_date as string) : undefined;
  const saveToDisk = args.save_to_disk as boolean || false;

  const report = await reportGenerator.generateReport(reportType, {
    from: fromDate,
    to: toDate,
    format,
    saveToDisk,
  });

  let result = `Report generated successfully.\n`;
  result += `Report ID: ${report.metadata.report_id}\n`;
  result += `Type: ${report.metadata.report_type}\n`;
  result += `Format: ${report.metadata.format}\n`;
  result += `Period: ${report.metadata.period.from} to ${report.metadata.period.to}\n`;

  if (report.file_path) {
    result += `Saved to: ${report.file_path}\n`;
  }

  result += `\n--- Report Content ---\n\n`;
  result += report.content;

  return [{ type: "text", text: result }];
}

async function handleCollectEvidence(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const collector = getEvidenceCollector();
  const regulation = args.regulation as string | undefined;
  const fromDate = args.from_date ? new Date(args.from_date as string) : undefined;
  const toDate = args.to_date ? new Date(args.to_date as string) : undefined;
  const saveToDisk = args.save_to_disk !== false;

  let evidencePackage;

  if (regulation && regulation !== "all") {
    evidencePackage = await collector.collectRegulationEvidence(
      regulation as "GDPR" | "SOC2" | "CSSF",
      { from: fromDate, to: toDate }
    );
  } else {
    evidencePackage = await collector.collectEvidence({
      from: fromDate,
      to: toDate,
    });
  }

  let filePath: string | undefined;
  if (saveToDisk) {
    filePath = await collector.savePackage(evidencePackage);
  }

  const result = {
    package_id: evidencePackage.package_id,
    created_at: evidencePackage.created_at,
    purpose: evidencePackage.purpose,
    period: evidencePackage.period,
    item_count: evidencePackage.manifest.total_items,
    total_size_bytes: evidencePackage.manifest.total_size_bytes,
    types_included: evidencePackage.manifest.types_included,
    package_checksum: evidencePackage.manifest.package_checksum,
    saved_to: filePath,
  };

  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

async function handleVerifyEvidence(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const collector = getEvidenceCollector();
  const packageId = args.package_id as string;

  const evidencePackage = await collector.loadPackage(packageId);
  if (!evidencePackage) {
    return [{ type: "text", text: `Evidence package not found: ${packageId}` }];
  }

  const verification = collector.verifyPackageIntegrity(evidencePackage);

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          package_id: packageId,
          integrity_valid: verification.valid,
          errors: verification.errors,
        },
        null,
        2
      ),
    },
  ];
}

async function handleListEvidence(): Promise<TextContent[]> {
  const collector = getEvidenceCollector();
  const packages = collector.listPackages();
  return [{ type: "text", text: JSON.stringify(packages, null, 2) }];
}

async function handleSubmitDSAR(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const dsarHandler = getDSARHandler();
  const type = args.type as "access" | "portability" | "erasure" | "rectification" | "restriction" | "objection";

  const request = await dsarHandler.submitRequest(type);

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          request_id: request.request_id,
          type: request.type,
          status: request.status,
          submitted_at: request.submitted_at,
          message: "DSAR submitted successfully. You will be notified when processing is complete.",
        },
        null,
        2
      ),
    },
  ];
}

async function handleExportUserData(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const exporter = getDataExporter();
  const format = (args.format as "json" | "json_pretty") || "json_pretty";

  const exportContent = await exporter.exportToString({ format });

  return [
    {
      type: "text",
      text: `Data Export (JSON)\n\n${exportContent}`,
    },
  ];
}

async function handleRequestErasure(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const erasureManager = getDataErasureManager();
  const completeErasure = args.complete_erasure as boolean || false;

  const request = await erasureManager.createRequest({
    complete_erasure: completeErasure,
  });

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          request_id: request.request_id,
          requested_at: request.requested_at,
          scope: request.scope,
          confirmed: request.confirmed,
          message: "Erasure request created. Use confirmAndExecute to proceed with deletion.",
        },
        null,
        2
      ),
    },
  ];
}

async function handleGetConsentStatus(): Promise<TextContent[]> {
  const consentManager = getConsentManager();
  const consents = await consentManager.getActiveConsents();
  const validation = await consentManager.validateConsents();

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          validation_result: validation,
          consents: consents.map((c: { purposes: string[]; legal_basis: string; granted_at: string; expires_at?: string; revoked?: boolean }) => ({
            purposes: c.purposes,
            legal_basis: c.legal_basis,
            granted_at: c.granted_at,
            expires_at: c.expires_at,
            revoked: c.revoked,
          })),
        },
        null,
        2
      ),
    },
  ];
}

async function handleGrantConsent(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const consentManager = getConsentManager();
  const purpose = args.purpose as ConsentPurpose;
  const legalBasis = (args.legal_basis as string) || "consent";

  const consent = await consentManager.grantConsent([purpose], {
    legalBasis: legalBasis as "consent" | "contract" | "legal_obligation" | "vital_interests" | "public_interest" | "legitimate_interest",
    method: "explicit",
  });

  return [
    {
      type: "text",
      text: `Consent granted for purpose: ${purpose} (Legal basis: ${legalBasis})\nConsent ID: ${consent.id}`,
    },
  ];
}

async function handleRevokeConsent(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const consentManager = getConsentManager();
  const purpose = args.purpose as string;

  await consentManager.revokeConsent(purpose);

  return [{ type: "text", text: `Consent revoked for purpose: ${purpose}` }];
}

async function handleReportIncident(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const incidentManager = getIncidentManager();

  const incident = await incidentManager.createIncident(
    args.type as IncidentType,
    args.severity as IncidentSeverity,
    args.title as string,
    args.description as string
  );

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          incident_id: incident.id,
          type: incident.type,
          severity: incident.severity,
          status: incident.status,
          detected_at: incident.detected_at,
          message: "Incident reported successfully and logged for investigation.",
        },
        null,
        2
      ),
    },
  ];
}

async function handleGetIncidentStatus(): Promise<TextContent[]> {
  const incidentManager = getIncidentManager();
  const statistics = await incidentManager.getStatistics();
  const openIncidents = await incidentManager.getOpenIncidents();

  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          statistics,
          open_incidents: openIncidents.map(i => ({
            id: i.id,
            type: i.type,
            severity: i.severity,
            title: i.title,
            status: i.status,
            detected_at: i.detected_at,
          })),
        },
        null,
        2
      ),
    },
  ];
}

async function handleRunHealthCheck(): Promise<TextContent[]> {
  const monitor = getHealthMonitor();
  const metrics = await monitor.runHealthCheck();
  return [{ type: "text", text: JSON.stringify(metrics, null, 2) }];
}

async function handleVerifyIntegrity(): Promise<TextContent[]> {
  const logger = getComplianceLogger();
  const integrity = await logger.verifyIntegrity();
  return [{ type: "text", text: JSON.stringify(integrity, null, 2) }];
}

async function handleListPolicies(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const policyManager = getPolicyDocManager();
  const regulation = args.regulation as string | undefined;

  let policies;
  if (regulation) {
    policies = await policyManager.getPoliciesByRegulation(regulation);
  } else {
    policies = await policyManager.getAllPolicies();
  }

  const summary = policies.map(p => ({
    id: p.id,
    title: p.title,
    type: p.type,
    regulations: p.regulations,
    enforced: p.enforced,
    last_reviewed: p.last_reviewed,
    next_review: p.next_review,
  }));

  return [{ type: "text", text: JSON.stringify(summary, null, 2) }];
}

async function handleGetPolicy(
  args: Record<string, unknown>
): Promise<TextContent[]> {
  const policyManager = getPolicyDocManager();
  const policyId = args.policy_id as string;

  const policy = await policyManager.getPolicy(policyId);

  if (!policy) {
    return [{ type: "text", text: `Policy not found: ${policyId}` }];
  }

  return [{ type: "text", text: JSON.stringify(policy, null, 2) }];
}

