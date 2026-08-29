/**
 * Response Validator for NotebookLM MCP Server
 *
 * Validates and sanitizes responses from NotebookLM:
 * - Prompt injection detection
 * - Malicious URL detection
 * - Encoded payload detection
 * - Response sanitization
 *
 * Uses patterns derived from MEDUSA AI Security Scanner.
 * Added by Pantheon Security for hardened fork.
 */

import { audit } from "./audit-logger.js";
import { log } from "./logger.js";
import { shannonEntropy } from "./secrets-scanner.js";

/**
 * Response validation result
 */
export interface ValidationResult {
  safe: boolean;
  warnings: string[];
  blocked: string[];
  sanitized: string;
  originalLength: number;
  sanitizedLength: number;
}

/**
 * Response validator configuration
 */
export interface ResponseValidatorConfig {
  /** Enable response validation (default: true) */
  enabled: boolean;
  /** Block responses containing prompt injection (default: true) */
  blockPromptInjection: boolean;
  /** Block responses containing suspicious URLs (default: true) */
  blockSuspiciousUrls: boolean;
  /** Block responses containing encoded payloads (default: false - just warn) */
  blockEncodedPayloads: boolean;
  /** Warn on suspicious content without blocking (default: true) */
  warnOnSuspicious: boolean;
  /** Allowed domains for URLs in responses */
  allowedDomains: string[];
}

/**
 * Get validator configuration from environment
 */
function getValidatorConfig(): ResponseValidatorConfig {
  return {
    enabled: process.env.NLMCP_RESPONSE_VALIDATION !== "false",
    blockPromptInjection: process.env.NLMCP_BLOCK_PROMPT_INJECTION !== "false",
    blockSuspiciousUrls: process.env.NLMCP_BLOCK_SUSPICIOUS_URLS !== "false",
    blockEncodedPayloads: process.env.NLMCP_BLOCK_ENCODED_PAYLOADS === "true",
    warnOnSuspicious: process.env.NLMCP_WARN_SUSPICIOUS !== "false",
    allowedDomains: (process.env.NLMCP_ALLOWED_DOMAINS || "").split(",").filter(d => d.length > 0),
  };
}

/**
 * Zero-width, joiner and bidirectional-control characters used to split keywords.
 *
 * Written as \uXXXX ESCAPES, never as literal characters. Literal bidi controls in
 * source are themselves a Trojan Source hazard - they reorder how the line renders
 * in an editor or review diff, so the code you read is not the code that runs. The
 * escaped form is byte-identical at runtime (proven by test) and safe to read.
 */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Normalise text before pattern matching.
 *
 * Without this, `Ign\u200Bore all previous instructions` and its full-width
 * homoglyph form both render normally to the model but match nothing. NFKC
 * folds homoglyphs to ASCII; invisible characters are stripped outright.
 */
export function normalizeForDetection(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE_CHARS, "");
}

/**
 * Prompt injection detection patterns
 * Derived from MEDUSA AI Security Scanner (AIC001-030)
 */
const PROMPT_INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string; severity: "critical" | "high" | "medium" }> = [
  // Direct instruction override attempts
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|guidelines?)/i,
    description: "Instruction override attempt",
    severity: "critical",
  },
  {
    pattern: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|text|context)/i,
    description: "Disregard instruction attempt",
    severity: "critical",
  },
  {
    pattern: /forget\s+(everything|all|your)\s+(you('ve)?|instructions?|training|learned)/i,
    description: "Memory reset attempt",
    severity: "critical",
  },
  {
    pattern: /you\s+are\s+now\s+(in\s+)?(\w+)\s+mode/i,
    description: "Mode switching attempt",
    severity: "high",
  },
  {
    pattern: /new\s+instructions?\s*:/i,
    description: "New instruction injection",
    severity: "high",
  },
  {
    pattern: /system\s*:\s*[^\n]{10,500}/i,
    description: "System prompt injection",
    severity: "critical",
  },
  {
    pattern: /\[INST\]|\[\/INST\]/i,
    description: "Instruction delimiter injection (Llama-style)",
    severity: "high",
  },
  {
    pattern: /<\|im_start\|>|<\|im_end\|>/i,
    description: "Chat template injection",
    severity: "high",
  },
  {
    pattern: /###\s*(system|user|assistant)\s*:/i,
    description: "Role delimiter injection",
    severity: "high",
  },
  {
    pattern: /pretend\s+(you('re)?|to\s+be)\s+(a|an|the)?\s*(different|new|another)/i,
    description: "Identity manipulation attempt",
    severity: "medium",
  },
  {
    pattern: /act\s+as\s+(if\s+)?(you('re)?|a|an)\s*(unrestricted|unfiltered|jailbroken)/i,
    description: "Jailbreak attempt",
    severity: "critical",
  },
  {
    pattern: /bypass\s+(your\s+)?(safety|security|restrictions?|filters?|guidelines?)/i,
    description: "Safety bypass attempt",
    severity: "critical",
  },
  {
    pattern: /do\s+not\s+(follow|obey|respect)\s+(your\s+)?(rules?|guidelines?|instructions?)/i,
    description: "Rule violation instruction",
    severity: "high",
  },
  // Claude-specific patterns
  {
    pattern: /human\s*:\s*[^\n]{20,500}/i,
    description: "Human turn injection (Claude-style)",
    severity: "high",
  },
  {
    pattern: /assistant\s*:\s*[^\n]{20,500}/i,
    description: "Assistant turn injection (Claude-style)",
    severity: "high",
  },
];

/**
 * Suspicious URL patterns
 */
// Precompiled with the global flag so detectSuspiciousUrls can call matchAll
// directly without re-allocating a RegExp per pattern per call (I-L55).
// matchAll clones the regex internally, so module-level reuse is state-safe.
const SUSPICIOUS_URL_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // URL shorteners (could hide malicious destinations)
  { pattern: /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|adf\.ly|j\.mp)\//gi, description: "URL shortener" },
  // Paste/sharing services (data exfiltration)
  { pattern: /https?:\/\/(pastebin\.com|hastebin\.com|paste\.ee|ghostbin\.com|dpaste\.org)\//gi, description: "Paste service" },
  // File sharing (potential malware)
  { pattern: /https?:\/\/(anonfiles\.com|mediafire\.com|zippyshare\.com|sendspace\.com)\//gi, description: "File sharing service" },
  // Dangerous protocols
  { pattern: /javascript:/gi, description: "JavaScript protocol" },
  { pattern: /\bdata:[a-z]+\/[a-z][\w+-]+/gi, description: "Data protocol" },
  { pattern: /file:\/\//gi, description: "File protocol" },
  { pattern: /vbscript:/gi, description: "VBScript protocol" },
  // IP addresses (potential C2)
  { pattern: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/gi, description: "Raw IP address URL" },
  // Webhook URLs (data exfiltration)
  { pattern: /https?:\/\/[^\/]*webhook/gi, description: "Webhook URL" },
  { pattern: /https?:\/\/[^\/]*discord(app)?\.com\/api\/webhooks/gi, description: "Discord webhook" },
];

/**
 * Encoded payload patterns.
 * minLength: match must be at least this long to be flagged (default 100).
 * minEntropy: match must exceed this Shannon entropy to avoid FPs like image data-URIs (I211, I212).
 */
const ENCODED_PAYLOAD_PATTERNS: Array<{ pattern: RegExp; description: string; minLength?: number; minEntropy?: number }> = [
  // Base64 — lower threshold + entropy gate to catch short secrets without flooding on images (I212, I211)
  { pattern: /[A-Za-z0-9+\/]{32,}={0,2}/g, description: "Possible Base64 encoded data", minLength: 32, minEntropy: 4.0 },
  // Hex encoded data
  { pattern: /(?:0x)?[0-9a-fA-F]{40,}/g, description: "Possible hex encoded data", minLength: 100 },
  // URL encoded data
  { pattern: /(?:%[0-9A-Fa-f]{2}){10,}/g, description: "Heavily URL encoded content", minLength: 100 },
  // Unicode escape sequences
  { pattern: /(?:\\u[0-9A-Fa-f]{4}){5,}/g, description: "Unicode escape sequences", minLength: 100 },
];

/**
 * Response Validator Class
 */
export class ResponseValidator {
  private config: ResponseValidatorConfig;
  private stats = {
    validated: 0,
    blocked: 0,
    warned: 0,
    passed: 0,
  };

  constructor(config?: Partial<ResponseValidatorConfig>) {
    this.config = { ...getValidatorConfig(), ...config };
  }

  /**
   * Validate a response from NotebookLM
   */
  async validate(response: string): Promise<ValidationResult> {
    if (!this.config.enabled) {
      return {
        safe: true,
        warnings: [],
        blocked: [],
        sanitized: response,
        originalLength: response.length,
        sanitizedLength: response.length,
      };
    }

    this.stats.validated++;

    const warnings: string[] = [];
    const blocked: string[] = [];
    // Sanitise the normalised form: matches are found against normalised text,
    // so redacting the raw string would silently miss homoglyph/zero-width
    // variants that were detected but could not be found to replace.
    let sanitized = normalizeForDetection(response);

    // Check for prompt injection
    if (this.config.blockPromptInjection) {
      const injectionResults = this.detectPromptInjection(response);
      for (const result of injectionResults) {
        if (result.severity === "critical" || result.severity === "high") {
          blocked.push(`Prompt injection (${result.severity}): ${result.description}`);
          sanitized = sanitized.replaceAll(result.match, "[REDACTED: prompt injection detected]");
        } else {
          warnings.push(`Suspicious pattern (${result.severity}): ${result.description}`);
        }
      }
    }

    // Check for suspicious URLs
    if (this.config.blockSuspiciousUrls) {
      const urlResults = this.detectSuspiciousUrls(response);
      for (const result of urlResults) {
        if (this.config.allowedDomains.length > 0) {
          // Check if URL is in allowed domains
          const isAllowed = this.config.allowedDomains.some(domain =>
            result.url.includes(domain)
          );
          if (isAllowed) continue;
        }
        blocked.push(`Suspicious URL: ${result.description} - ${result.url.substring(0, 50)}`);
        sanitized = sanitized.replaceAll(result.url, "[REDACTED: suspicious URL]");
      }
    }

    // Check for encoded payloads
    const encodedResults = this.detectEncodedPayloads(response);
    for (const result of encodedResults) {
      if (this.config.blockEncodedPayloads) {
        blocked.push(`Encoded payload: ${result.description}`);
        sanitized = sanitized.replaceAll(result.match, "[REDACTED: encoded payload]");
      } else if (this.config.warnOnSuspicious) {
        warnings.push(`Encoded content detected: ${result.description}`);
      }
    }

    // Determine if response is safe
    const safe = blocked.length === 0;

    // Update stats
    if (!safe) {
      this.stats.blocked++;
    } else if (warnings.length > 0) {
      this.stats.warned++;
    } else {
      this.stats.passed++;
    }

    // Audit if issues found
    if (blocked.length > 0 || warnings.length > 0) {
      await audit.security("response_validation", safe ? "warning" : "error", {
        blocked_count: blocked.length,
        warning_count: warnings.length,
        blocked_reasons: blocked,
        warnings: warnings,
        original_length: response.length,
        sanitized_length: sanitized.length,
      });

      if (!safe) {
        log.warning(`🛡️ Response blocked: ${blocked.join(", ")}`);
      } else {
        log.info(`⚠️ Response warnings: ${warnings.join(", ")}`);
      }
    }

    return {
      safe,
      warnings,
      blocked,
      sanitized,
      originalLength: response.length,
      sanitizedLength: sanitized.length,
    };
  }

  /**
   * Detect prompt injection attempts in text
   */
  detectPromptInjection(text: string): Array<{ pattern: RegExp; description: string; severity: string; match: string }> {
    const results: Array<{ pattern: RegExp; description: string; severity: string; match: string }> = [];
    const haystack = normalizeForDetection(text);

    for (const { pattern, description, severity } of PROMPT_INJECTION_PATTERNS) {
      // Clone with the global flag so EVERY occurrence is reported, not just
      // the first: validate() redacts per returned match, so a second
      // occurrence previously survived into the model's context.
      const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
      const global = new RegExp(pattern.source, flags);

      const seen = new Set<string>();
      for (const match of haystack.matchAll(global)) {
        if (seen.has(match[0])) {
          continue;
        }
        seen.add(match[0]);
        results.push({
          pattern,
          description,
          severity,
          match: match[0],
        });
      }
    }

    return results;
  }

  /**
   * Detect suspicious URLs in text
   */
  detectSuspiciousUrls(text: string): Array<{ pattern: RegExp; description: string; url: string }> {
    const results: Array<{ pattern: RegExp; description: string; url: string }> = [];

    for (const { pattern, description } of SUSPICIOUS_URL_PATTERNS) {
      // Reuse the precompiled global pattern; matchAll clones it so no lastIndex leak.
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        results.push({
          pattern,
          description,
          url: match[0],
        });
      }
    }

    return results;
  }

  /**
   * Detect encoded payloads in text
   */
  detectEncodedPayloads(text: string): Array<{ pattern: RegExp; description: string; match: string }> {
    const results: Array<{ pattern: RegExp; description: string; match: string }> = [];

    for (const { pattern, description, minLength = 100, minEntropy } of ENCODED_PAYLOAD_PATTERNS) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const matchStr = match[0];
        if (matchStr.length < minLength) continue;
        if (minEntropy !== undefined && shannonEntropy(matchStr) < minEntropy) continue;
        // Carry the FULL match so validate()'s replaceAll can actually redact it
        // when blockEncodedPayloads is enabled (truncating broke redaction) (I-L57).
        results.push({
          pattern,
          description,
          match: matchStr,
        });
      }
    }

    return results;
  }

  /**
   * Get validation statistics
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      validated: 0,
      blocked: 0,
      warned: 0,
      passed: 0,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ResponseValidatorConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Global validator instance
 */
let globalValidator: ResponseValidator | null = null;

/**
 * Get or create the global response validator
 */
export function getResponseValidator(): ResponseValidator {
  if (!globalValidator) {
    globalValidator = new ResponseValidator();
  }
  return globalValidator;
}

/**
 * Convenience function to validate a response
 */
export async function validateResponse(response: string): Promise<ValidationResult> {
  return getResponseValidator().validate(response);
}
