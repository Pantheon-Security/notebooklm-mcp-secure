/**
 * Event Types for Webhook Notifications
 *
 * Defines all events that can trigger webhook notifications.
 */

import { createRequire } from "module";

// Read version from package.json so emitted events/webhooks report the real
// package version (avoids stale hardcoded values that corrupt SIEM/audit
// correlation). Mirrors the version-loading pattern in src/index.ts.
const require = createRequire(import.meta.url);
const packageJson = require("../../package.json");
const VERSION: string = packageJson.version;

export type EventType =
  | "question_answered"    // Research query completed
  | "notebook_created"     // Notebook created
  | "notebook_deleted"     // Notebook removed from library
  | "source_added"         // Source added to notebook
  | "source_removed"       // Source removed from notebook
  | "session_created"      // Browser session started
  | "session_expired"      // Session timeout/closed
  | "auth_required"        // Re-authentication needed
  | "rate_limit_hit"       // Rate limit reached
  | "security_incident"    // Security event detected
  | "quota_warning"        // Approaching quota limit
  | "audio_generated"      // Audio overview ready
  | "batch_complete";      // Batch operation finished

export interface BaseEvent {
  type: EventType;
  timestamp: string; // ISO timestamp
  source: "notebooklm-mcp";
  version: string;
}

export interface QuestionAnsweredEvent extends BaseEvent {
  type: "question_answered";
  payload: {
    question_length: number;
    answer_length: number;
    session_id: string;
    notebook_url?: string;
    duration_ms: number;
  };
}

export interface NotebookCreatedEvent extends BaseEvent {
  type: "notebook_created";
  payload: {
    notebook_url: string;
    name: string;
    source_count: number;
    topics?: string[];
  };
}

export interface NotebookDeletedEvent extends BaseEvent {
  type: "notebook_deleted";
  payload: {
    notebook_id: string;
    name: string;
  };
}

export interface SourceAddedEvent extends BaseEvent {
  type: "source_added";
  payload: {
    notebook_url: string;
    source_type: "url" | "text" | "file";
    source_title?: string;
  };
}

export interface SourceRemovedEvent extends BaseEvent {
  type: "source_removed";
  payload: {
    notebook_url: string;
    source_id: string;
  };
}

export interface SessionCreatedEvent extends BaseEvent {
  type: "session_created";
  payload: {
    session_id: string;
    notebook_url?: string;
  };
}

export interface SessionExpiredEvent extends BaseEvent {
  type: "session_expired";
  payload: {
    session_id: string;
    reason: "timeout" | "manual" | "error";
    age_seconds: number;
  };
}

export interface AuthRequiredEvent extends BaseEvent {
  type: "auth_required";
  payload: {
    reason: "expired" | "invalid" | "missing";
  };
}

export interface RateLimitHitEvent extends BaseEvent {
  type: "rate_limit_hit";
  payload: {
    limit_type: "query" | "notebook" | "api";
    current_count: number;
    limit: number;
  };
}

export interface SecurityIncidentEvent extends BaseEvent {
  type: "security_incident";
  payload: {
    severity: "low" | "medium" | "high" | "critical";
    incident_type: string;
    description: string;
    blocked?: boolean;
  };
}

export interface QuotaWarningEvent extends BaseEvent {
  type: "quota_warning";
  payload: {
    resource: "notebooks" | "sources" | "queries";
    used: number;
    limit: number;
    percent: number;
  };
}

export interface AudioGeneratedEvent extends BaseEvent {
  type: "audio_generated";
  payload: {
    notebook_url: string;
    duration_seconds?: number;
  };
}

export interface BatchCompleteEvent extends BaseEvent {
  type: "batch_complete";
  payload: {
    operation: "create_notebooks" | "sync_library";
    total: number;
    succeeded: number;
    failed: number;
  };
}

export type SystemEvent =
  | QuestionAnsweredEvent
  | NotebookCreatedEvent
  | NotebookDeletedEvent
  | SourceAddedEvent
  | SourceRemovedEvent
  | SessionCreatedEvent
  | SessionExpiredEvent
  | AuthRequiredEvent
  | RateLimitHitEvent
  | SecurityIncidentEvent
  | QuotaWarningEvent
  | AudioGeneratedEvent
  | BatchCompleteEvent;

/**
 * Create an event with standard fields
 */
export function createEvent<T extends EventType>(
  type: T,
  payload: Extract<SystemEvent, { type: T }>["payload"]
): SystemEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    source: "notebooklm-mcp",
    version: VERSION,
    payload,
  } as SystemEvent;
}
