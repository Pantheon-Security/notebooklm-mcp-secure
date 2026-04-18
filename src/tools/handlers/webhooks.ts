/**
 * Webhook handler functions
 *
 * Extracted from handlers.ts — configure, list, test, and remove webhooks.
 */

import type { HandlerContext } from "./types.js";
import type { ToolResult } from "../../types.js";
import { log } from "../../utils/logger.js";
import { getWebhookDispatcher, type WebhookConfig, type WebhookStats } from "../../webhooks/index.js";
import type { EventType } from "../../events/event-types.js";

export async function handleConfigureWebhook(
  _ctx: HandlerContext,
  args: {
    id?: string;
    name: string;
    url: string;
    enabled?: boolean;
    events?: string[];
    format?: "generic" | "slack" | "discord" | "teams";
    secret?: string;
  },
): Promise<ToolResult<WebhookConfig>> {
  log.info(`🔧 [TOOL] configure_webhook called`);
  log.info(`  Name: ${args.name}`);

  try {
    const dispatcher = getWebhookDispatcher();

    if (args.id) {
      // Update existing (URL is revalidated inside updateWebhook).
      const updated = await dispatcher.updateWebhook({
        id: args.id,
        name: args.name,
        url: args.url,
        enabled: args.enabled,
        events: args.events as EventType[] | ["*"],
        format: args.format,
        secret: args.secret,
      });

      if (!updated) {
        throw new Error(`Webhook not found: ${args.id}`);
      }

      log.success(`✅ [TOOL] configure_webhook updated: ${updated.name}`);
      return { success: true, data: updated };
    } else {
      // Create new (URL is validated inside addWebhook; throws on failure).
      const webhook = await dispatcher.addWebhook({
        name: args.name,
        url: args.url,
        events: args.events as EventType[] | ["*"],
        format: args.format,
        secret: args.secret,
      });

      log.success(`✅ [TOOL] configure_webhook created: ${webhook.name}`);
      return { success: true, data: webhook };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] configure_webhook failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleListWebhooks(
  _ctx: HandlerContext,
): Promise<ToolResult<{
  webhooks: WebhookConfig[];
  stats: WebhookStats;
}>> {
  log.info(`🔧 [TOOL] list_webhooks called`);

  try {
    const dispatcher = getWebhookDispatcher();
    const webhooks = dispatcher.listWebhooks();
    const stats = dispatcher.getStats();

    log.success(`✅ [TOOL] list_webhooks completed (${webhooks.length} webhooks)`);
    return {
      success: true,
      data: { webhooks, stats },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] list_webhooks failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleTestWebhook(
  _ctx: HandlerContext,
  args: { id: string },
): Promise<ToolResult<{
  success: boolean;
  message: string;
}>> {
  log.info(`🔧 [TOOL] test_webhook called`);
  log.info(`  ID: ${args.id}`);

  try {
    const dispatcher = getWebhookDispatcher();
    const result = await dispatcher.testWebhook(args.id);

    if (result.success) {
      log.success(`✅ [TOOL] test_webhook succeeded`);
      return {
        success: true,
        data: { success: true, message: "Test event delivered successfully" },
      };
    } else {
      log.warning(`⚠️ [TOOL] test_webhook failed: ${result.error}`);
      return {
        success: false,
        data: { success: false, message: result.error || "Test failed" },
        error: result.error,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] test_webhook failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

export async function handleRemoveWebhook(
  _ctx: HandlerContext,
  args: { id: string },
): Promise<ToolResult<{
  removed: boolean;
  id: string;
}>> {
  log.info(`🔧 [TOOL] remove_webhook called`);
  log.info(`  ID: ${args.id}`);

  try {
    const dispatcher = getWebhookDispatcher();
    const removed = dispatcher.removeWebhook(args.id);

    if (removed) {
      log.success(`✅ [TOOL] remove_webhook completed`);
      return {
        success: true,
        data: { removed: true, id: args.id },
      };
    } else {
      log.warning(`⚠️ [TOOL] Webhook not found: ${args.id}`);
      return {
        success: false,
        error: `Webhook not found: ${args.id}`,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`❌ [TOOL] remove_webhook failed: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}
