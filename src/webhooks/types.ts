/**
 * Webhook Configuration Types
 */

import type { EventType } from "../events/event-types.js";

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  events: (EventType | "*")[]; // Which events to send
  format: "generic" | "slack" | "discord" | "teams";
  secret?: string; // For HMAC signature
  headers?: Record<string, string>; // Custom headers
  retryCount?: number; // Default: 3
  retryDelayMs?: number; // Default: 1000 (exponential backoff)
  timeoutMs?: number; // Default: 5000
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  /** Monotonic sequence number for ordering/replay across restarts */
  sequence: number;
  webhookId: string;
  eventType: EventType;
  timestamp: string;
  success: boolean;
  statusCode?: number;
  error?: string;
  attempts: number;
  durationMs: number;
}

export interface WebhookStats {
  totalDeliveries: number;
  successCount: number;
  failureCount: number;
  lastDelivery?: string;
  lastSuccess?: string;
  lastFailure?: string;
}

export interface AddWebhookInput {
  name: string;
  url: string;
  events?: (EventType | "*")[];
  format?: "generic" | "slack" | "discord" | "teams";
  secret?: string;
  headers?: Record<string, string>;
}

export interface UpdateWebhookInput {
  id: string;
  name?: string;
  url?: string;
  enabled?: boolean;
  events?: (EventType | "*")[];
  format?: "generic" | "slack" | "discord" | "teams";
  secret?: string;
  headers?: Record<string, string>;
}
