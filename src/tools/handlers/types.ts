/**
 * Shared types for handler domain modules
 */

import type { SessionManager } from "../../session/session-manager.js";
import type { AuthManager } from "../../auth/auth-manager.js";
import type { NotebookLibrary } from "../../library/notebook-library.js";
import type { RateLimiter } from "../../utils/security.js";
import type { GeminiClient } from "../../gemini/index.js";

/**
 * Shared context passed to all domain handler functions
 */
export interface HandlerContext {
  sessionManager: SessionManager;
  authManager: AuthManager;
  library: NotebookLibrary;
  rateLimiter: RateLimiter;
  getGeminiClient: () => GeminiClient | null;
}
