# Security Implementation Plan - High Priority Features

## Overview

This plan outlines the implementation of 5 high-priority security features for the notebooklm-mcp-secure fork.

**Target Version**: 1.3.0-secure
**Status**: ✅ ALL PHASES COMPLETE
**Estimated Files**: 8 new, 6 modified

### Implementation Status

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Audit Logging | ✅ Complete |
| 2 | Session Timeout | ✅ Complete |
| 3 | MCP Authentication | ✅ Complete |
| 4 | Response Validation | ✅ Complete |
| 5 | Post-Quantum Encrypted Storage | ✅ Complete |

---

## Feature 1: Post-Quantum Encrypted Credential Storage ✅

### Problem
Chrome profile stores session cookies and auth state in plaintext on disk at:
- `~/.local/share/notebooklm-mcp/chrome_profile/`
- `~/.local/share/notebooklm-mcp/browser_state/state.json`

Anyone with disk access can steal the Google session. Additionally, classical encryption may be vulnerable to future quantum computer attacks.

### Solution
Encrypt sensitive files at rest using **hybrid post-quantum encryption**:
- **ML-KEM-768 (Kyber)** for quantum-resistant key encapsulation
- **AES-256-GCM** for symmetric encryption
- **PBKDF2** for classical key derivation from passwords

This hybrid approach provides both current security and future quantum resistance.

### Implementation (COMPLETE)

```
src/utils/crypto.ts (NEW) ✅
├── deriveKey(passphrase, salt) → Key derivation using PBKDF2
├── getMachineKey() → Derive key from machine ID (fallback)
├── generatePQKeyPair() → Generate ML-KEM-768 key pair
├── encryptPQ(data, publicKey) → Hybrid PQ+AES-256-GCM encryption
├── decryptPQ(ciphertext, secretKey) → Hybrid PQ decryption
├── encryptClassical(data, key) → AES-256-GCM encryption (fallback)
├── decryptClassical(ciphertext, key) → AES-256-GCM decryption
└── SecureStorage class
    ├── initialize() → Load/generate PQ keys
    ├── save(filename, data) → Encrypt with ML-KEM-768 + AES-256-GCM
    ├── load(filename) → Decrypt and return data
    ├── loadJSON<T>(filename) → Parse JSON after decryption
    ├── delete(filename) → Remove all encrypted versions
    ├── exists(filename) → Check any version exists
    ├── getStatus() → Return encryption status
    └── getPublicKey() → Export PQ public key
```

### Encrypted File Format
```json
{
  "version": 2,
  "algorithm": "aes-256-gcm",
  "pqAlgorithm": "ML-KEM-768",
  "encapsulatedKey": "<base64>",
  "iv": "<base64>",
  "salt": "<base64>",
  "tag": "<base64>",
  "ciphertext": "<base64>"
}
```

### Files Modified
- `src/auth/auth-manager.ts` ✅ - Use SecureStorage for state.json, session.json
- `package.json` ✅ - Added `@noble/post-quantum` dependency

### Environment Variables
```
NLMCP_ENCRYPTION_ENABLED=true         # Default: true
NLMCP_ENCRYPTION_KEY=<base64-key>     # Optional: User-provided classical key
NLMCP_USE_POST_QUANTUM=true           # Default: true
NLMCP_USE_MACHINE_KEY=true            # Default: true (fallback)
NLMCP_PBKDF2_ITERATIONS=100000        # Default: 100000
```

### Dependencies
- Node.js `crypto` module (built-in)
- `@noble/post-quantum` v0.2.1 - ML-KEM (Kyber) implementation

### Security Properties
1. **Quantum Resistance**: ML-KEM-768 provides ~192-bit post-quantum security
2. **Hybrid Security**: Even if PQ crypto is broken, AES-256-GCM remains secure
3. **Forward Secrecy**: New encapsulated key per file save
4. **Automatic Migration**: Unencrypted files are automatically encrypted on load

---

## Feature 2: Session Timeout Enforcement

### Problem
Sessions can remain active indefinitely. Stale sessions with valid cookies pose security risk.

### Solution
Implement configurable hard timeout that:
1. Forces session closure after max lifetime (e.g., 8 hours)
2. Forces re-authentication after inactivity (e.g., 30 minutes)
3. Clears sensitive memory on timeout

### Implementation

```
src/session/session-timeout.ts (NEW)
├── SessionTimeoutManager class
│   ├── startSession(sessionId)
│   ├── touchSession(sessionId) → Reset inactivity timer
│   ├── isExpired(sessionId) → boolean
│   ├── getTimeRemaining(sessionId) → { lifetime, inactivity }
│   └── onTimeout callback → Cleanup handler
└── TimeoutConfig interface
    ├── maxLifetimeMs: number (default: 8 hours)
    ├── inactivityTimeoutMs: number (default: 30 min)
    └── warningBeforeMs: number (default: 5 min)
```

### Files Modified
- `src/session/session-manager.ts` - Integrate timeout checks
- `src/session/browser-session.ts` - Call touchSession on activity
- `src/tools/handlers.ts` - Return timeout warnings in responses
- `src/config.ts` - Add timeout config options

### Environment Variables
```
NLMCP_SESSION_MAX_LIFETIME=28800      # 8 hours in seconds
NLMCP_SESSION_INACTIVITY_TIMEOUT=1800 # 30 minutes in seconds
```

---

## Feature 3: Audit Logging

### Problem
No record of what operations were performed, when, or by whom. Critical for:
- Security incident investigation
- Compliance requirements
- Debugging production issues

### Solution
Comprehensive audit log with:
- All tool invocations with sanitized parameters
- Authentication events (login, logout, failures)
- Session lifecycle events
- Security events (validation failures, rate limits)

### Implementation

```
src/utils/audit-logger.ts (NEW)
├── AuditLogger class
│   ├── logToolCall(tool, args, result, duration)
│   ├── logAuthEvent(event, success, details)
│   ├── logSessionEvent(event, sessionId, details)
│   ├── logSecurityEvent(event, severity, details)
│   └── flush() → Force write to disk
├── AuditEvent interface
│   ├── timestamp: ISO8601 string
│   ├── eventType: 'tool' | 'auth' | 'session' | 'security'
│   ├── eventName: string
│   ├── success: boolean
│   ├── duration_ms?: number
│   ├── details: Record<string, any> (sanitized)
│   └── hash: SHA256 of previous entry (tamper detection)
└── Log rotation and retention config
```

### Log Format (JSONL)
```json
{"timestamp":"2025-11-28T10:30:00Z","eventType":"tool","eventName":"ask_question","success":true,"duration_ms":3420,"details":{"question_length":150,"session_id":"abc123"},"hash":"a1b2c3..."}
{"timestamp":"2025-11-28T10:30:05Z","eventType":"security","eventName":"rate_limit_exceeded","success":false,"details":{"session_id":"abc123","remaining":0},"hash":"d4e5f6..."}
```

### Files Modified
- `src/tools/handlers.ts` - Add audit logging to all handlers
- `src/auth/auth-manager.ts` - Log auth events
- `src/session/session-manager.ts` - Log session events
- `src/index.ts` - Initialize audit logger on startup

### Log Location
```
~/.local/share/notebooklm-mcp/audit/
├── audit-2025-11-28.jsonl
├── audit-2025-11-27.jsonl
└── ...
```

### Environment Variables
```
NLMCP_AUDIT_ENABLED=true
NLMCP_AUDIT_DIR=~/.local/share/notebooklm-mcp/audit
NLMCP_AUDIT_RETENTION_DAYS=30
```

---

## Feature 4: Content Security Policy (Response Validation)

### Problem
NotebookLM responses could potentially contain:
- Malicious links
- Prompt injection attempts targeting Claude
- Encoded payloads
- Exfiltration URLs

### Solution
Validate and sanitize all responses before returning to the MCP client.

### Implementation

```
src/utils/response-validator.ts (NEW)
├── ResponseValidator class
│   ├── validate(response) → { safe: boolean, warnings: string[], sanitized: string }
│   ├── detectMaliciousUrls(text) → URLs to untrusted domains
│   ├── detectPromptInjection(text) → Injection patterns
│   ├── detectEncodedPayloads(text) → Base64, hex, etc.
│   ├── sanitizeResponse(text) → Cleaned text
│   └── getStats() → { blocked, warned, passed }
└── ValidationConfig
    ├── blockMaliciousUrls: boolean
    ├── blockPromptInjection: boolean
    ├── warnOnSuspicious: boolean
    └── allowedDomains: string[]
```

### Detection Patterns
```typescript
// Prompt injection patterns (from MEDUSA AI security scanner)
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+in\s+(\w+)\s+mode/i,
  /forget\s+(everything|all|your)\s+(you|instructions)/i,
  /new\s+instructions?:/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<\|im_start\|>/i,
];

// Suspicious URL patterns
const SUSPICIOUS_URL_PATTERNS = [
  /bit\.ly|tinyurl|t\.co/i,  // URL shorteners
  /pastebin|hastebin/i,       // Paste services
  /file:\/\//i,               // File protocol
  /javascript:/i,             // JS protocol
];
```

### Files Modified
- `src/tools/handlers.ts` - Validate responses before returning
- `src/session/browser-session.ts` - Optional: validate at capture time

### Environment Variables
```
NLMCP_RESPONSE_VALIDATION=true
NLMCP_BLOCK_PROMPT_INJECTION=true
NLMCP_BLOCK_SUSPICIOUS_URLS=true
```

---

## Feature 5: MCP Authentication

### Problem
Any process on the local machine can connect to the MCP server via stdio. No authentication means:
- Malicious processes can use your Google session
- No accountability for requests
- Shared machines are especially vulnerable

### Solution
Require authentication token for MCP requests.

### Implementation Options

#### Option A: Environment Token (Simple)
```
NLMCP_AUTH_TOKEN=<random-32-char-token>
```
Client must include in request metadata.

#### Option B: Unix Socket Permissions (Linux/Mac)
Instead of stdio, use Unix socket with file permissions.

#### Option C: Challenge-Response (Most Secure)
1. Server generates challenge on connect
2. Client signs challenge with shared secret
3. Server validates signature

### Chosen: Option A (Environment Token) + Option B (Unix Socket)

```
src/auth/mcp-auth.ts (NEW)
├── MCPAuthenticator class
│   ├── validateToken(token) → boolean
│   ├── generateToken() → string (for initial setup)
│   ├── hashToken(token) → string (stored hash, not plaintext)
│   └── isEnabled() → boolean
└── Token storage in encrypted config
```

### Files Modified
- `src/index.ts` - Add auth middleware to MCP server
- `src/config.ts` - Add auth config options

### Environment Variables
```
NLMCP_AUTH_ENABLED=true
NLMCP_AUTH_TOKEN=<token>              # Or auto-generated on first run
NLMCP_AUTH_TOKEN_FILE=~/.config/notebooklm-mcp/token
```

### Client Configuration (Claude Code)
```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["notebooklm-mcp-secure"],
      "env": {
        "NLMCP_AUTH_TOKEN": "<your-token>"
      }
    }
  }
}
```

---

## Implementation Order

| Phase | Feature | Complexity | Dependencies |
|-------|---------|------------|--------------|
| 1 | Audit Logging | Medium | None |
| 2 | Session Timeout | Low | None |
| 3 | MCP Authentication | Medium | None |
| 4 | Response Validation | Medium | MEDUSA patterns |
| 5 | Encrypted Storage | High | Phase 1 (for key storage) |

### Rationale
1. **Audit Logging first** - Enables monitoring of all subsequent changes
2. **Session Timeout second** - Quick win, low risk
3. **MCP Auth third** - Critical for shared environments
4. **Response Validation fourth** - Leverages MEDUSA patterns
5. **Encrypted Storage last** - Most complex, benefits from audit logs

---

## Testing Plan

### Unit Tests
```
tests/
├── crypto.test.ts
├── session-timeout.test.ts
├── audit-logger.test.ts
├── response-validator.test.ts
└── mcp-auth.test.ts
```

### Integration Tests
- Full flow with all security features enabled
- Timeout behavior under load
- Audit log integrity verification
- Auth token rotation

### Security Tests
- Attempt to bypass auth
- Inject malicious responses
- Tamper with audit logs
- Access encrypted data without key

---

## Rollout

### Version 1.3.0-secure.1
- Audit Logging
- Session Timeout

### Version 1.3.0-secure.2
- MCP Authentication
- Response Validation

### Version 1.3.0-secure.3
- Encrypted Storage
- Full integration testing

---

## Success Metrics

| Feature | Metric |
|---------|--------|
| Encrypted Storage | 0 plaintext credentials on disk |
| Session Timeout | 100% sessions expire correctly |
| Audit Logging | All events logged with <1ms overhead |
| Response Validation | 0 prompt injections passed through |
| MCP Auth | 0 unauthorized requests processed |

---

## Appendix: File Structure After Implementation

```
src/
├── auth/
│   ├── auth-manager.ts (modified)
│   └── mcp-auth.ts (NEW)
├── session/
│   ├── browser-session.ts (modified)
│   ├── session-manager.ts (modified)
│   └── session-timeout.ts (NEW)
├── utils/
│   ├── security.ts (existing)
│   ├── crypto.ts (NEW)
│   ├── audit-logger.ts (NEW)
│   └── response-validator.ts (NEW)
├── config.ts (modified)
└── index.ts (modified)
```

---

**Document Version**: 1.0
**Created**: 2025-11-28
**Author**: Pantheon Security
