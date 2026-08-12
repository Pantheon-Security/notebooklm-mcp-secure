/**
 * Compliance Module - Shared Types
 *
 * Type definitions for GDPR, SOC2, and CSSF compliance features.
 *
 * Added by Pantheon Security for enterprise compliance support.
 */

// ============================================
// DATA CLASSIFICATION
// ============================================

/**
 * Data sensitivity classification levels
 */
export enum DataClassification {
  PUBLIC = "public",           // No restrictions
  INTERNAL = "internal",       // Internal use only
  CONFIDENTIAL = "confidential", // Restricted access
  RESTRICTED = "restricted",   // Highly sensitive (PII, credentials)
  REGULATED = "regulated"      // Subject to regulatory requirements
}

/**
 * Categories of data processed by the system
 */
export type DataCategory =
  | "personal_data"      // GDPR personal data
  | "sensitive_data"     // GDPR special categories
  | "credentials"        // Auth tokens, passwords
  | "session_data"       // Browser session state
  | "usage_data"         // Analytics, telemetry
  | "configuration"      // Settings, preferences
  | "audit_logs"         // Compliance logs
  | "notebook_metadata"; // Notebook URLs, descriptions

/**
 * Classified data with metadata
 */
export interface ClassifiedData {
  classification: DataClassification;
  data_categories: DataCategory[];
  retention_policy: string;
  encryption_required: boolean;
  audit_required: boolean;
  exportable: boolean;
  erasable: boolean;
}

// ============================================
// COMPLIANCE EVENTS
// ============================================

/**
 * Categories of compliance events
 */
export type ComplianceEventCategory =
  | "consent"           // Consent granted/revoked
  | "data_access"       // Data access requests
  | "data_export"       // Data portability requests
  | "data_deletion"     // Erasure requests
  | "data_processing"   // Processing activities
  | "security_incident" // Security events
  | "policy_change"     // Configuration changes
  | "access_control"    // Auth events
  | "retention"         // Data retention events
  | "breach";           // Breach notifications

/**
 * Actor who triggered the event
 */
export interface ComplianceActor {
  type: "user" | "system" | "admin";
  id?: string;                 // User/session ID if applicable
  ip?: string;                 // Masked IP (last octet zeroed)
}

/**
 * Resource affected by the event
 */
export interface ComplianceResource {
  type: string;                // e.g., "notebook", "session", "audit_log"
  id?: string;
}

/**
 * Full compliance event structure
 */
export interface ComplianceEvent {
  // Required fields
  id: string;                    // UUID v4
  timestamp: string;             // ISO 8601
  category: ComplianceEventCategory;
  event_type: string;            // Specific event (e.g., "consent_granted")

  // Actor information
  actor: ComplianceActor;

  // Event details
  resource?: ComplianceResource;
  details?: Record<string, unknown>;

  // Compliance metadata
  legal_basis?: LegalBasis;
  data_categories?: DataCategory[];
  retention_days?: number;       // How long to retain this event

  // Outcome
  outcome: "success" | "failure" | "pending";
  failure_reason?: string;

  // Integrity
  hash: string;
  previous_hash: string;
}

// ============================================
// CONSENT MANAGEMENT
// ============================================

/**
 * GDPR Article 6 legal bases for processing
 */
export type LegalBasis =
  | "consent"              // User explicitly consented
  | "contract"             // Necessary for contract performance
  | "legal_obligation"     // Required by law
  | "vital_interests"      // Protect vital interests
  | "public_interest"      // Public interest task
  | "legitimate_interest"; // Legitimate business interest

/**
 * Purposes for data processing
 */
export type ConsentPurpose =
  | "service_provision"    // Core service functionality
  | "session_management"   // Browser session handling
  | "security_logging"     // Security audit logging
  | "error_diagnostics"    // Error logging for debugging
  | "usage_analytics";     // Optional usage tracking

/**
 * Record of user consent
 */
export interface ConsentRecord {
  id: string;                    // UUID
  version: string;               // Consent version (e.g., "1.0.0")
  granted_at: string;            // ISO 8601
  expires_at?: string;           // Optional expiry

  // What was consented to
  purposes: ConsentPurpose[];
  data_categories: DataCategory[];

  // Legal basis (GDPR Article 6)
  legal_basis: LegalBasis;

  // Consent metadata
  method: "explicit" | "implicit" | "contractual";
  evidence?: string;             // How consent was obtained

  // Revocation
  revoked?: boolean;
  revoked_at?: string;
  revocation_reason?: string;
}

// ============================================
// PRIVACY NOTICE
// ============================================

/**
 * Privacy notice structure
 */
export interface PrivacyNotice {
  version: string;
  effective_date: string;

  sections: {
    data_controller: string;
    data_collected: string[];
    purposes: string[];
    legal_basis: string[];
    retention: string;
    rights: string[];
    contact: string;
  };

  // Short summary for CLI display
  summary: string;
}

// ============================================
// DATA SUBJECT RIGHTS (GDPR)
// ============================================

/**
 * Data export package (GDPR Article 20)
 */
export interface DataExport {
  export_metadata: {
    version: string;
    exported_at: string;
    format: "json";
    encryption: "none" | "password";
    checksum: string;
  };

  data: {
    consent_records: ConsentRecord[];
    notebook_library: unknown[];
    user_settings: unknown;
    session_history?: unknown[];
    /** Plaintext question/answer history from dataDir/query_logs (GDPR Art. 20). */
    query_logs?: unknown[];
    activity_log: unknown[];
    compliance_events: ComplianceEvent[];
  };

  data_inventory: {
    category: string;
    count: number;
    date_range: { from: string; to: string };
  }[];
}

/**
 * Export options
 */
export interface ExportOptions {
  include_notebooks: boolean;
  include_settings: boolean;
  include_sessions: boolean;
  include_audit_logs: boolean;
  include_compliance_events: boolean;
  from_date?: string;
  to_date?: string;
  encrypt_export: boolean;
  export_password?: string;
  format: "json" | "json_pretty";
  output_path?: string;
}

/**
 * Erasure scope (GDPR Article 17)
 */
export interface ErasureScope {
  notebooks: boolean;
  settings: boolean;
  browser_data: boolean;
  audit_logs: boolean;
  compliance_events: boolean;
  encryption_keys: boolean;
  complete_erasure: boolean;
}

/**
 * Erasure result
 */
export interface ErasureResult {
  data_type: string;
  path: string;
  items_deleted: number;
  size_bytes: number;
  method: "overwrite" | "delete" | "crypto_shred";
  verified: boolean;
  /**
   * Paths that did not exist when erasure ran. Recorded so an Art.17
   * certificate can distinguish "erased and confirmed gone" from "there was
   * never a file here" — both used to report verified with nothing to tell
   * them apart (FX-024).
   */
  paths_absent?: string[];
}

/**
 * Full erasure request record
 */
export interface ErasureRequest {
  request_id: string;
  requested_at: string;
  scope: ErasureScope;
  confirmed: boolean;
  confirmation_method: "explicit" | "timeout";
  executed_at?: string;
  items_deleted: ErasureResult[];
  erasure_record_retention_days: number;
}

/**
 * DSAR response (GDPR Article 15)
 */
export interface DSARResponse {
  request_id: string;
  submitted_at: string;
  completed_at: string;
  subject_verified: boolean;

  personal_data: {
    category: string;
    data: unknown;
    source: string;
    retention_period: string;
  }[];

  processing_purposes: string[];
  legal_bases: string[];
  data_recipients: string[];

  available_rights: string[];

  format: "json";
  encrypted: boolean;
}

// ============================================
// DATA INVENTORY
// ============================================

/**
 * Entry in the data inventory
 */
export interface DataInventoryEntry {
  id: string;
  data_type: string;
  description: string;
  classification: DataClassification;
  data_categories: DataCategory[];
  storage_location: string;
  encrypted: boolean;
  retention_policy: string;
  retention_days: number | "indefinite";
  legal_basis: LegalBasis;
  processing_purposes: string[];
  who_can_access: string[];
  exportable: boolean;
  erasable: boolean;
  last_updated: string;
}

// ============================================
// RETENTION POLICIES
// ============================================

/**
 * Retention policy definition
 */
export interface RetentionPolicy {
  id: string;
  name: string;
  data_types: string[];
  classifications?: DataClassification[];
  retention_days: number;
  action: "delete" | "archive" | "anonymize";
  schedule: "daily" | "weekly" | "monthly";
  exceptions?: {
    condition: string;
    extended_retention_days: number;
  }[];
  regulatory_requirement?: string;
}

// ============================================
// INCIDENT MANAGEMENT
// ============================================

/**
 * Types of security incidents
 */
export type IncidentType =
  | "unauthorized_access"
  | "data_breach"
  | "malware"
  | "dos_attack"
  | "policy_violation"
  | "data_loss"
  | "configuration_error"
  | "other";

/**
 * Incident status
 */
export type IncidentStatus =
  | "open"
  | "investigating"
  | "contained"
  | "resolved"
  | "closed";

/**
 * Incident severity
 */
export type IncidentSeverity = "low" | "medium" | "high" | "critical";

/**
 * Action taken during incident response
 */
export interface IncidentAction {
  timestamp: string;
  action: string;
  performed_by: string;
  notes?: string;
}

/**
 * Full security incident record
 */
export interface SecurityIncident {
  id: string;
  type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;

  detected_at: string;
  reported_at?: string;
  contained_at?: string;
  resolved_at?: string;
  closed_at?: string;

  title: string;
  description: string;
  affected_data: string[];
  affected_systems: string[];

  actions_taken: IncidentAction[];
  root_cause?: string;
  remediation?: string;

  notification_required: boolean;
  notification_sent?: boolean;
  notification_deadline?: string;

  related_events: string[];
}

// ============================================
// BREACH DETECTION
// ============================================

/**
 * Actions to take when breach is detected
 */
export type BreachAction =
  | "log"
  | "alert"
  | "block"
  | "notify_admin"
  | "create_incident";

/**
 * Breach detection rule
 */
export interface BreachRule {
  id: string;
  name: string;
  description: string;
  severity: IncidentSeverity;
  event_pattern: string;
  threshold?: number;
  window_seconds?: number;
  actions: BreachAction[];
  notification_required: boolean;
  notification_deadline_hours?: number;
}

// ============================================
// SIEM INTEGRATION
// ============================================

/**
 * Supported SIEM export formats
 */
export type SIEMFormat =
  | "json"
  | "cef"
  | "leef"
  | "syslog"
  | "splunk_hec";

/**
 * SIEM configuration
 */
export interface SIEMConfig {
  enabled: boolean;
  format: SIEMFormat;
  endpoint?: string;
  syslog_host?: string;
  syslog_port?: number;
  api_key?: string;
  min_severity: "info" | "warning" | "error" | "critical";
  event_types: string[];
  batch_size: number;
  flush_interval_ms: number;
  retry_attempts: number;
  queue_max_size: number;
}

// ============================================
// ALERT SYSTEM
// ============================================

/**
 * Alert severity levels
 */
export type AlertSeverity = "info" | "warning" | "error" | "critical";

/**
 * Alert configuration
 */
export interface AlertConfig {
  enabled: boolean;

  channels: {
    console: boolean;
    file?: {
      path: string;
      format: "json" | "text";
    };
    webhook?: {
      url: string;
      headers?: Record<string, string>;
      template?: string;
    };
    email?: {
      smtp_host: string;
      smtp_port: number;
      from: string;
      to: string[];
      use_tls: boolean;
    };
  };

  min_severity: AlertSeverity;
  event_types?: string[];
  cooldown_seconds: number;
  max_alerts_per_hour: number;
}

/**
 * Alert message
 */
export interface Alert {
  id: string;
  timestamp: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  source: string;
  details?: Record<string, unknown>;
  sent_to: string[];
}

// ============================================
// HEALTH MONITORING
// ============================================

/**
 * Component health status
 */
export interface ComponentHealth {
  name: string;
  status: "up" | "down" | "degraded";
  last_check: string;
  response_time_ms?: number;
  error?: string;
}

/**
 * Resource usage metrics
 */
export interface ResourceMetrics {
  memory_used_mb: number;
  memory_limit_mb: number;
  disk_used_mb: number;
  disk_available_mb: number;
}

/**
 * Security status
 */
export interface SecurityStatus {
  encryption_enabled: boolean;
  auth_enabled: boolean;
  cert_pinning_enabled: boolean;
  last_security_scan?: string;
  open_incidents: number;
}

/**
 * Compliance status
 */
export interface ComplianceStatus {
  consent_valid: boolean;
  retention_policies_active: number;
  pending_erasure_requests: number;
  last_compliance_check: string;
}

/**
 * Full health metrics
 */
export interface HealthMetrics {
  timestamp: string;
  status: "healthy" | "degraded" | "unhealthy";
  uptime_seconds: number;
  components: ComponentHealth[];
  resources: ResourceMetrics;
  security: SecurityStatus;
  compliance: ComplianceStatus;
}

// ============================================
// COMPLIANCE DASHBOARD
// ============================================

/**
 * Compliance issue found during check
 */
export interface ComplianceIssue {
  severity: IncidentSeverity;
  regulation: string;
  requirement: string;
  description: string;
  remediation: string;
}

/**
 * Regulation compliance status
 */
export interface RegulationStatus {
  name: "GDPR" | "SOC2" | "CSSF";
  status: "compliant" | "non_compliant" | "partial";
  requirements_met: number;
  requirements_total: number;
  issues: ComplianceIssue[];
}

/**
 * Compliance dashboard metrics
 */
export interface ComplianceDashboard {
  generated_at: string;
  overall_status: "compliant" | "non_compliant" | "needs_attention";
  regulations: RegulationStatus[];

  metrics: {
    active_consents: number;
    pending_dsars: number;
    pending_erasures: number;
    open_incidents: number;
    audit_log_integrity: "verified" | "issues_found";
    encryption_status: "enabled" | "disabled" | "partial";
    retention_compliance: number;
  };

  recent_compliance_events: ComplianceEvent[];

  deadlines: {
    type: string;
    deadline: string;
    days_remaining: number;
  }[];
}

// ============================================
// REPORTING
// ============================================

/**
 * Report types
 */
export type ReportType =
  | "compliance_summary"
  | "audit_trail"
  | "access_report"
  | "retention_report"
  | "incident_report"
  | "dsar_report"
  | "consent_report";

/**
 * Report configuration
 */
export interface ReportConfig {
  type: ReportType;
  from_date: string;
  to_date: string;
  format: "json" | "html" | "csv";
  regulations?: string[];
  severity_min?: string;
  output_path?: string;
  include_evidence?: boolean;
}

// ============================================
// POLICY DOCUMENTATION
// ============================================

/**
 * Policy types
 */
export type PolicyType =
  | "privacy_policy"
  | "data_retention"
  | "access_control"
  | "encryption"
  | "incident_response"
  | "acceptable_use";

/**
 * Policy document
 */
export interface PolicyDocument {
  id: string;
  type: PolicyType;
  version: string;
  effective_date: string;
  title: string;
  description: string;
  full_text: string;
  regulations: string[];
  data_types: string[];
  enforced: boolean;
  enforcement_method: "automatic" | "manual" | "audit";
  last_reviewed: string;
  next_review: string;
  approved_by: string;
}

// ============================================
// CHANGE LOG
// ============================================

/**
 * Configuration change record
 */
export interface ChangeRecord {
  id: string;
  timestamp: string;
  component: string;
  setting: string;
  old_value: unknown;
  new_value: unknown;
  changed_by: "user" | "system" | "admin";
  method: "cli" | "env" | "api" | "config_file";
  requires_approval: boolean;
  approved_by?: string;
  approved_at?: string;
  impact: "low" | "medium" | "high";
  affected_compliance: string[];
}

// ============================================
// EVIDENCE COLLECTION
// ============================================

/**
 * Evidence types
 */
export type EvidenceType =
  | "policy_document"
  | "configuration"
  | "audit_log_sample"
  | "access_review"
  | "encryption_status"
  | "retention_proof"
  | "consent_records"
  | "incident_response";

/**
 * Single evidence item
 */
export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  description: string;
  content: string | object;
  format: "json" | "text" | "screenshot" | "log";
  collected_at: string;
  source: string;
  controls: string[];
}

/**
 * Complete evidence package
 */
export interface EvidencePackage {
  id: string;
  generated_at: string;
  audit_type: "SOC2" | "GDPR" | "CSSF" | "internal";
  period: { from: string; to: string };
  items: EvidenceItem[];
  checksum: string;
  signed_by?: string;
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Compliance configuration from environment
 */
export interface ComplianceConfig {
  // Core
  enabled: boolean;
  mode: "full" | "minimal" | "audit_only";
  regulations: ("GDPR" | "SOC2" | "CSSF")[];

  // Directories
  compliance_dir: string;
  reports_dir: string;

  // Retention
  retention_years: number;
  encryption: boolean;

  // Consent
  consent_required: boolean;
  consent_version: string;
  privacy_notice_url: string;

  // Data Subject Rights
  dsar_enabled: boolean;
  erasure_enabled: boolean;
  export_enabled: boolean;
  export_encrypt: boolean;

  // Retention Policies
  retention_audit_days: number;
  retention_session_hours: number;
  retention_browser_days: number;
  retention_check_schedule: "daily" | "weekly" | "monthly";

  // SIEM
  siem: SIEMConfig;

  // Breach Detection
  breach_detection: boolean;
  breach_notification: boolean;
  breach_webhook?: string;

  // Incident Response
  incident_tracking: boolean;
  incident_auto_create: boolean;

  // Alerts
  alerts: AlertConfig;

  // Health Monitoring
  health_monitoring: boolean;
  health_check_interval: number;

  // Reporting
  reports_auto_generate: boolean;
  reports_schedule: "daily" | "weekly" | "monthly";
}
