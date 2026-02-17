# Medusa Scan — False Positive Analysis Report

**Project:** `@pan-sec/notebooklm-mcp` v2026.1.12
**Scan Date:** 2026-02-16T07:07:43Z
**Medusa Version:** 2026.2.4
**Scan Report:** `medusa-testing/.medusa/reports/medusa-scan-20260216-070743.json`
**Analyst:** Pantheon Security

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Files scanned | 113 |
| Lines scanned | 49,159 |
| Total raw findings | 812 |
| Auto-filtered by Medusa FP engine | 807 |
| Retained for manual review | **5** |
| Security score | **87 / 100** |
| Risk level | **GOOD** |

### Manual Review Results

| # | File | Issue | Severity | Verdict |
|---|------|-------|----------|---------|
| 1 | `resource-handlers.ts:496` | Prompt exposed in error | HIGH | **False Positive** |
| 2 | `query-logger.ts:147` | Raw SQL concatenation | MEDIUM | **False Positive** |
| 3 | `cleanup-manager.ts:680` | Raw SQL concatenation | MEDIUM | **False Positive** |
| 4 | `index.ts:150` | Sensitive data in logs | MEDIUM | **False Positive** |
| 5 | `gemini-client.ts:99` | No LLM toxicity check | MEDIUM | **Advisory — Accepted** |

**Effective true positives requiring code changes: 0**

---

## Detailed Analysis

---

### Finding 1 — HIGH: "Prompt exposed in error message"

| Field | Value |
|-------|-------|
| Scanner | MCPServerScanner |
| File | `src/resources/resource-handlers.ts:496` |
| Severity | **HIGH** |
| Confidence | HIGH |
| Reported Issue | Information Disclosure: Prompt exposed in error message |

#### Flagged Code

```typescript
// src/resources/resource-handlers.ts — lines 495-498
        default:
          throw new Error("Unknown prompt requested");
      }
    });
```

#### What the scanner expects to see

The scanner expects user-supplied data leaking into error messages, e.g.:

```typescript
// BAD — this was the ORIGINAL code (before v2026.1.12):
throw new Error(`Unknown prompt: ${name}`);
//                                ^^^^^^^ user input leaks
```

#### What the code actually does

This was **already fixed** in v2026.1.12 (commit `16114b1`). The error message is now a **hardcoded static string** — `"Unknown prompt requested"` — with zero variable interpolation:

```typescript
// FIXED — current code:
throw new Error("Unknown prompt requested");
//               ^^^^^^^^^^^^^^^^^^^^^^^^^ static literal, no variables
```

#### Why this is a false positive

The scanner is keyword-matching the word `"prompt"` inside the string and interpreting it as a dynamic prompt value being exposed. It does not distinguish between:
- `\`Unknown prompt: ${name}\`` (dynamic — leaks input)
- `"Unknown prompt requested"` (static — leaks nothing)

#### Risk Assessment

**None.** A hardcoded string literal cannot disclose runtime information.

---

### Finding 2 — MEDIUM: "Raw SQL with concatenation"

| Field | Value |
|-------|-------|
| Scanner | SemgrepScanner |
| File | `src/logging/query-logger.ts:147` |
| Severity | **MEDIUM** |
| Confidence | HIGH |
| Reported Issue | Raw SQL with concatenation |

#### Flagged Code

```typescript
// src/logging/query-logger.ts — lines 145-148
        if (fileDate < cutoffDate) {
          fs.unlinkSync(path.join(this.config.logDir, file));
          deletedCount++;
        }
```

#### Module Imports (proof of no SQL)

```typescript
// src/logging/query-logger.ts — lines 17-26
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CONFIG } from "../config.js";
import { mkdirSecure, appendFileSecure, PERMISSION_MODES } from "../utils/file-permissions.js";
import { log } from "../utils/logger.js";
```

No SQL library (`pg`, `mysql2`, `better-sqlite3`, `knex`, `prisma`, `typeorm`, `sequelize`, etc.) is imported.

#### What the module actually does

The module docstring (lines 1-15) explicitly states:

> *"JSONL format with daily rotation... 90-day retention (configurable)"*

Data is written as **JSONL** (JSON Lines) to local files:

```typescript
// src/logging/query-logger.ts — lines 172-181
        const lines = batch.map(e => JSON.stringify(e)).join("\n") + "\n";
        const today = new Date().toISOString().split("T")[0];
        const expectedFile = path.join(this.config.logDir, `query-log-${today}.jsonl`);
        // ...
        appendFileSecure(this.currentLogFile, lines, PERMISSION_MODES.OWNER_READ_WRITE);
```

The flagged line 147 is `fs.unlinkSync()` — a **filesystem delete** for old log file rotation, not a SQL `DELETE` statement.

#### Why this is a false positive

The Semgrep rule pattern-matches string interpolation with date variables near file operations and interprets it as SQL query construction. Two things likely triggered it:
1. The module name contains "query" (`query-logger.ts`)
2. `path.join()` with string interpolation resembles SQL string building

**There is no SQL database anywhere in this module.** The entire persistence layer is JSONL files on the local filesystem.

#### Risk Assessment

**None.** No SQL engine exists to inject into.

---

### Finding 3 — MEDIUM: "Raw SQL with concatenation"

| Field | Value |
|-------|-------|
| Scanner | SemgrepScanner |
| File | `src/utils/cleanup-manager.ts:680` |
| Severity | **MEDIUM** |
| Confidence | HIGH |
| Reported Issue | Raw SQL with concatenation |
| Medusa FP Hint | `is_likely_fp: true` (confidence 0.5, reason: `"example_file"`) |

#### Flagged Code

```typescript
// src/utils/cleanup-manager.ts — lines 673-688
      for (const itemPath of category.paths) {
        try {
          if (await this.pathExists(itemPath)) {
            const size = await this.getDirectorySize(itemPath);
            log.info(`  Deleting: ${itemPath}`);
            await fs.rm(itemPath, { recursive: true, force: true });
            deletedPaths.push(itemPath);
            categoryDeleted++;                                          // <-- line 680
            categoryBytes += size;
            log.success(`  Deleted: ${itemPath} (${this.formatBytes(size)})`);
          }
        } catch (error) {
          log.error(`  Failed to delete: ${itemPath} - ${error}`);
          failedPaths.push(itemPath);
        }
      }
```

#### Module Imports (proof of no SQL)

```typescript
// src/utils/cleanup-manager.ts — lines 20-25
import fs from "fs/promises";
import path from "path";
import { globby } from "globby";
import envPaths from "env-paths";
import os from "os";
import { log } from "./logger.js";
```

No SQL library is imported. The module docstring (lines 1-18) describes it as a **filesystem cleanup utility** for temporary files, browser profiles, caches, and trash.

#### Why this is a false positive

Identical root cause to Finding 2 — the scanner is flagging template literal log statements (`\`Deleted: ${itemPath}\``) as SQL string concatenation. The code is calling `fs.rm()` (filesystem removal), not executing SQL.

Medusa's own FP analyzer partially caught this, flagging `is_likely_fp: true` with 50% confidence.

#### Risk Assessment

**None.** No SQL engine exists to inject into.

---

### Finding 4 — MEDIUM: "Sensitive data in MCP logs"

| Field | Value |
|-------|-------|
| Scanner | MCPServerScanner |
| File | `src/index.ts:150` |
| Severity | **MEDIUM** |
| Confidence | HIGH |
| Reported Issue | Sensitive data in MCP logs |

#### Flagged Code

```typescript
// src/index.ts — lines 137-162
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const progressToken = (args as any)?._meta?.progressToken;
      const authToken = (args as any)?._meta?.authToken || process.env.NLMCP_AUTH_TOKEN;

      log.info(`[MCP] Tool call: ${name}`);

      // === SECURITY: MCP Authentication ===
      const authResult = await authenticateMCPRequest(authToken, name);
      if (!authResult.authenticated) {
        log.warning(`[MCP] Authentication failed for tool: ${name}`);   // <-- line 150
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: authResult.error || "Authentication required",
            }),
          }],
        };
      }
```

#### What `name` actually contains

The `name` variable is the **MCP tool name** — a public identifier from the protocol schema. Example values:

- `"ask_question"`
- `"list_notebooks"`
- `"get_health"`
- `"select_notebook"`

These names are **publicly advertised** by the server via the `tools/list` MCP endpoint. Every MCP client sees them.

#### What IS sensitive and IS properly handled

| Data | Logged? | Protection |
|------|---------|------------|
| Auth token (`authToken`) | Never logged | Passed to `authenticateMCPRequest()` which uses `secureCompare()` |
| Tool arguments (`args`) | Never logged | Only `name` appears in the log, not the arguments |
| Progress token | Logged (line 144) | Opaque session ID, not a credential |
| Tool name (`name`) | Logged (line 150) | **Public metadata** — not sensitive |

#### Why this is a false positive

The scanner flags any variable interpolation in log statements near authentication code as "sensitive data in logs." It does not perform data-flow analysis to determine *what* the variable contains.

Logging the tool name during authentication failures is a **security best practice** for audit trails — SOC2 and CSSF compliance require knowing *which resources* unauthorized clients attempted to access.

#### Risk Assessment

**None.** Tool names are public protocol metadata, not credentials or PII.

---

### Finding 5 — MEDIUM: "LLM output without toxicity check"

| Field | Value |
|-------|-------|
| Scanner | SemgrepScanner |
| File | `src/gemini/gemini-client.ts:99` |
| Severity | **MEDIUM** |
| Confidence | HIGH |
| Reported Issue | LLM output returned without toxicity check. Consider adding content moderation. |

#### Flagged Code

```typescript
// src/gemini/gemini-client.ts — lines 60-105
  async query(options: GeminiQueryOptions): Promise<GeminiInteraction> {
    if (!this.client) {
      throw new Error("Gemini API key not configured.");
    }

    const model = options.model || CONFIG.geminiDefaultModel || "gemini-2.5-flash";
    log.info(`Gemini query to ${model}: ${options.query.substring(0, 50)}...`);

    try {
      const tools: unknown[] = [];
      if (options.tools) {
        for (const tool of options.tools) {
          tools.push({ type: tool });
        }
      }

      let input: string = options.query;
      if (options.urls && options.urls.length > 0) {
        input = `${options.query}\n\nPlease analyze these URLs:\n${options.urls.join("\n")}`;
      }

      const response = await (this.client.interactions as any).create({
        model,
        input,
        tools: tools.length > 0 ? tools : undefined,
        previousInteractionId: options.previousInteractionId,
        store: true,
        generationConfig: options.generationConfig ? {
          temperature: options.generationConfig.temperature,
          maxOutputTokens: options.generationConfig.maxOutputTokens,
          thinkingLevel: options.generationConfig.thinkingLevel,
        } : undefined,
      });

      return this.mapInteraction(response);                             // <-- line 99
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Gemini query failed: ${msg}`);
      throw error;
    }
  }
```

#### Verdict: ADVISORY — ACCEPTED RISK

This is **not a false positive** in the traditional sense. The scanner correctly identifies that no explicit content moderation layer sits between the Gemini API response and the return value. However, this is an **intentional architectural decision**:

**1. Upstream moderation already exists**
The Gemini API applies Google's built-in safety filters and harm category thresholds before returning any response.

**2. This is middleware, not a user-facing app**
The MCP server is a transparent proxy between an AI client (Claude, GPT, etc.) and Google's APIs. The consuming AI client applies its own output safety checks. Adding a third moderation layer in the middle would:
- Double latency and API costs
- Create "who watches the watchmen" problems (filtering LLM output with another LLM)
- Risk blocking legitimate research content

**3. Response validation does exist**
The project includes `src/utils/response-validator.ts` which checks for injection patterns, data exfiltration, and suspicious content — just not "toxicity" in the content moderation sense.

**4. Consumer responsibility**
Per the MCP specification, tool outputs are consumed by an AI model that applies its own safety filters before presenting results to users.

#### Risk Assessment

**Low — accepted by design.** Both upstream (Gemini API) and downstream (MCP client) have their own moderation. Adding a third middleware layer would increase cost/latency with minimal security benefit.

**Recommendation for future:** If content moderation is required for a regulated deployment, add it as an optional configurable middleware layer, not hardcoded into the Gemini client.

---

## Recommendations for Medusa Scanner Improvement

Based on these 5 findings, we suggest the following detection improvements:

### 1. SQL concatenation: check for database imports first

Findings 2 and 3 flagged `path.join()` and `log.success()` interpolation as SQL injection. The rule should verify that the file imports a SQL/database library before firing. A quick heuristic: scan the import block for `pg`, `mysql`, `sqlite`, `knex`, `prisma`, `typeorm`, `sequelize`, `drizzle`, `better-sqlite3`, or `sql` before flagging string concatenation.

### 2. "Prompt in error": distinguish static vs dynamic strings

Finding 1 flagged `throw new Error("Unknown prompt requested")` — a static string literal. The rule should only fire when variable interpolation is present (template literals with `${}` or string concatenation with `+`).

### 3. "Sensitive data in logs": add data-flow awareness

Finding 4 flagged logging a public MCP tool name. The rule should trace what the interpolated variable contains. Variables destructured from `request.params.name` (MCP schema) are public protocol identifiers, not credentials. A heuristic: if the variable name is `name`, `method`, `tool`, `action`, or `endpoint`, it's likely operational metadata.

### 4. LLM toxicity: reduce severity for middleware

Finding 5 is a valid advisory for user-facing applications but not for middleware/proxy servers. Consider auto-reducing severity to LOW or INFORMATIONAL when the module wraps an external API that provides its own moderation (detectable via imports like `@google/genai`, `openai`, `@anthropic-ai/sdk`).

---

## Historical Scan Progression

| Scan Date | Medusa Version | Raw Findings | After FP Filter | True Positives | Score |
|-----------|---------------|-------------|-----------------|----------------|-------|
| 2025-12-18 | pre-2026 | 107 | 107 (no filter) | 7 | N/A |
| 2026-02-15 | 2026.2.x | ~812 | 7 | ~2 | N/A |
| 2026-02-16 | 2026.2.4 | 812 | 5 | **0** | **87** |

All 7 original true positives from the 2025-12-18 scan were fixed in v2026.1.12:

1. Constant-time auth token comparison (`secureCompare`)
2. Command injection in `file-permissions.ts` (`execFileSync`)
3. `--no-install-recommends` in Dockerfile
4. Error message information disclosure (generic message)
5. npm audit HIGH vulnerability (MCP SDK updated)
6. Default profile changed from `"full"` to `"standard"`
7. `medusa-fp-analysis.md` excluded from scanner
