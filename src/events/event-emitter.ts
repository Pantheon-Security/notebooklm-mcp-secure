/**
 * Event Emitter for NotebookLM MCP
 *
 * Central event bus for system-wide events.
 * Events can trigger webhook notifications, logging, or other actions.
 */

import { log } from "../utils/logger.js";
import type { SystemEvent, EventType } from "./event-types.js";

export type EventHandler = (event: SystemEvent) => void | Promise<void>;

class EventEmitter {
  private handlers: Map<EventType | "*", EventHandler[]> = new Map();
  private eventHistory: SystemEvent[] = [];
  private maxHistorySize = 100;
  // Max time a single handler may run before emit() stops waiting on it.
  // Prevents a slow/hung handler (e.g. an unreachable webhook with retries)
  // from blocking the event-producing call path.
  private handlerTimeoutMs = 5000;
  // Leak-diagnostics threshold: when a single event type accumulates more than
  // this many handlers it usually signals a listener leak (handlers added in a
  // loop without unsubscribing). Mirrors Node's EventEmitter.maxListeners. This
  // is a soft warning only — we never throw, since some paths legitimately
  // register many handlers. Warns once per event type to avoid log spam.
  private maxHandlersPerType = 50;
  private leakWarned: Set<EventType | "*"> = new Set();

  /**
   * Subscribe to an event type
   */
  on(eventType: EventType | "*", handler: EventHandler): () => void {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);

    // Soft leak diagnostics: warn (once per type) if the handler count exceeds
    // the configured threshold. Does not block registration.
    if (
      handlers.length > this.maxHandlersPerType &&
      !this.leakWarned.has(eventType)
    ) {
      this.leakWarned.add(eventType);
      log.warning(
        `⚠️  Possible event-listener leak: ${handlers.length} handlers ` +
          `registered for "${eventType}" (threshold ${this.maxHandlersPerType}). ` +
          `Check that handlers are being unsubscribed.`
      );
    }

    // Return unsubscribe function
    return () => {
      const currentHandlers = this.handlers.get(eventType) || [];
      const index = currentHandlers.indexOf(handler);
      if (index > -1) {
        currentHandlers.splice(index, 1);
        this.handlers.set(eventType, currentHandlers);
      }
    };
  }

  /**
   * Subscribe to an event type (one-time only)
   */
  once(eventType: EventType | "*", handler: EventHandler): () => void {
    const wrappedHandler: EventHandler = (event) => {
      unsubscribe();
      return handler(event);
    };

    const unsubscribe = this.on(eventType, wrappedHandler);
    return unsubscribe;
  }

  /**
   * Emit an event
   */
  async emit(event: SystemEvent): Promise<void> {
    log.dim(`📢 Event: ${event.type}`);

    // Add to history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Get specific handlers
    const specificHandlers = this.handlers.get(event.type) || [];
    // Get wildcard handlers
    const wildcardHandlers = this.handlers.get("*") || [];

    const allHandlers = [...specificHandlers, ...wildcardHandlers];

    // Execute all handlers concurrently so one slow handler (e.g. a webhook
    // dispatch with retries/backoff) cannot block the others or stall the
    // event producer. Each handler is bounded by a per-handler timeout and
    // its errors are caught and logged (never thrown back to the producer).
    await Promise.allSettled(
      allHandlers.map((handler) => this.runHandler(handler, event))
    );
  }

  /**
   * Run a single handler with a timeout, catching and logging any error so
   * a rejected/hung handler can never produce an unhandled rejection or hang
   * emit() indefinitely.
   */
  private async runHandler(
    handler: EventHandler,
    event: SystemEvent
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(handler(event)),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `handler timed out after ${this.handlerTimeoutMs}ms`
                )
              ),
            this.handlerTimeoutMs
          );
        }),
      ]);
    } catch (error) {
      log.error(`Event handler error for ${event.type}: ${error}`);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Get recent events
   */
  getHistory(limit?: number): SystemEvent[] {
    const count = limit || this.maxHistorySize;
    return this.eventHistory.slice(-count);
  }

  /**
   * Get events by type
   */
  getEventsByType(eventType: EventType, limit?: number): SystemEvent[] {
    const filtered = this.eventHistory.filter((e) => e.type === eventType);
    return limit ? filtered.slice(-limit) : filtered;
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
  }

  /**
   * Get handler count for debugging
   */
  getHandlerCount(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [type, handlers] of this.handlers) {
      counts[type] = handlers.length;
    }
    return counts;
  }
}

// Singleton instance
const eventEmitter = new EventEmitter();

export { eventEmitter };
export default eventEmitter;
