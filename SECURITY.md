# Security Hardening Documentation

This is a security-hardened fork of [PleasePrompto/notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp), maintained by [Pantheon Security](https://pantheonsecurity.io).

**Version**: 1.4.0-secure
**Security Features**: 14 hardening layers

## Security Features Overview

| Feature | Status | Description |
|---------|--------|-------------|
| Input Validation | ✅ | URL whitelisting, sanitization |
| Rate Limiting | ✅ | Per-session request throttling |
| Log Sanitization | ✅ | Credential masking |
| Audit Logging | ✅ | Tamper-evident event logging |
| Session Timeout | ✅ | Hard lifetime + inactivity limits |
| MCP Authentication | ✅ | Token-based auth with lockout |
| Response Validation | ✅ | Prompt injection detection |
| **Post-Quantum Encryption** | ✅ | ML-KEM-768 + ChaCha20-Poly1305 |
| **Secrets Scanning** | ✅ | Detect API keys, tokens, passwords |
| **Certificate Pinning** | ✅ | Google TLS MITM protection |
| **Memory Scrubbing** | ✅ | Zero sensitive data after use |
| **MEDUSA Integration** | ✅ | Automated security scanning |

---

## Post-Quantum Encryption (NEW)

### Why Post-Quantum?

Recent events (including alleged quantum computer attacks on major infrastructure) highlight the urgency of preparing for "Q-Day" - when quantum computers can break classical encryption.

This MCP uses **hybrid post-quantum encryption** that combines:
- **ML-KEM-768 (Kyber)** - NIST-standardized post-quantum key encapsulation
- **ChaCha20-Poly1305** - Modern stream cipher (NOT AES-GCM)

### Why ChaCha20-Poly1305 over AES-GCM?

| Property | ChaCha20-Poly1305 | AES-GCM |
|----------|-------------------|---------|
| Timing attacks | Immune (constant-time) | Vulnerable without AES-NI |
| Software speed | Fast everywhere | Slow without hardware |
| Complexity | Simple | Complex (GCM mode) |
| Adoption | Google, Cloudflare TLS | Legacy systems |

This provides **double protection**: even if one algorithm is broken, the other remains secure.

### What's Encrypted

- Browser session state (cookies, localStorage)
- Session storage data
- Post-quantum key pairs (double-encrypted)

### Encrypted File Format

Files are saved with `.pqenc` extension:
```json
{
  "version": 3,
  "algorithm": "chacha20-poly1305",
  "pqAlgorithm": "ML-KEM-768",
  "encapsulatedKey": "<base64>",
  "nonce": "<base64>",
  "salt": "<base64>",
  "ciphertext": "<base64 with Poly1305 tag appended>"
}
```

### Configuration

```bash
# Enable/disable post-quantum encryption (default: enabled)
NLMCP_USE_POST_QUANTUM=true

# Provide your own classical key (optional)
NLMCP_ENCRYPTION_KEY=<base64-32-bytes>

# Disable encryption entirely (NOT recommended)
NLMCP_ENCRYPTION_ENABLED=false
```

### Automatic Migration

When you upgrade, existing unencrypted files are automatically:
1. Loaded
2. Re-encrypted with ML-KEM-768 + ChaCha20-Poly1305
3. Old unencrypted files are deleted

---

## Secrets Scanning (NEW)

Real-time detection of credentials in logs and responses using patterns from TruffleHog and GitLeaks.

### Detected Secret Types

| Category | Types |
|----------|-------|
| Cloud | AWS Access Keys, GCP API Keys, Azure Tokens |
| AI Services | OpenAI, Anthropic, Google AI API keys |
| Source Control | GitHub PATs, GitLab tokens |
| Communication | Slack tokens/webhooks |
| Payment | Stripe API keys |
| Auth | JWTs, Bearer tokens, Basic Auth |
| Databases | PostgreSQL, MongoDB, MySQL connection strings |
| Keys | RSA, EC, SSH, PGP private keys |

### Configuration

```bash
NLMCP_SECRETS_SCANNING=true       # Enable scanning (default: true)
NLMCP_SECRETS_BLOCK=false         # Block on detection (default: false, just warn)
NLMCP_SECRETS_REDACT=true         # Auto-redact secrets (default: true)
NLMCP_SECRETS_MIN_SEVERITY=low    # Minimum severity: critical, high, medium, low
NLMCP_SECRETS_IGNORE=pattern1,pattern2  # Ignore specific patterns
```

### Example Detection

```
🔐 Secrets detected: 1 critical, 0 high
   - AWS Access Key ID at line 42
```

---

## Certificate Pinning (NEW)

Protects HTTPS connections to Google by validating server certificate chains against known-good SPKI hashes.

### Why Certificate Pinning?

Prevents man-in-the-middle attacks even if:
- A rogue CA certificate is installed on the system
- Corporate proxies attempt SSL inspection
- DNS is compromised

### Pinned Certificates

- **GTS Root R1-R4** - Google Trust Services roots
- **GlobalSign Root CA R2** - Backup root
- **DigiCert Global Root G2** - Backup root

### Configuration

```bash
NLMCP_CERT_PINNING=true          # Enable pinning (default: true)
NLMCP_CERT_FAIL_OPEN=false       # Allow on failure (default: false)
NLMCP_CERT_REPORT_ONLY=false     # Log but don't block (default: false)
```

### Violation Response

```
🔒 Certificate pinning violation for notebooklm.google.com
   Chain hashes: abc123...
   Expected one of: hxqRlP..., Vfd95B...
```

---

## Memory Scrubbing (NEW)

Sensitive data is securely wiped from memory after use to prevent:
- Memory dump attacks
- Cold boot attacks
- Credential persistence in RAM

### Features

| Feature | Description |
|---------|-------------|
| `zeroBuffer()` | Securely zero-fill Buffer objects |
| `SecureString` | String wrapper with `.wipe()` method |
| `SecureCredential` | Auto-expiring credential with timer |
| `SecureObject` | Object with dispose-and-wipe capability |
| `secureCompare()` | Timing-safe string comparison |

### Auto-cleanup

Using `FinalizationRegistry`, secure buffers are automatically wiped when garbage collected.

### Usage

```typescript
import { SecureCredential, withSecureCredential } from './utils/secure-memory.js';

// Auto-wipe after 5 minutes
const cred = new SecureCredential(apiKey, 300000);

// Or use helper that auto-wipes after function completes
await withSecureCredential(apiKey, async (cred) => {
  await makeRequest(cred.getValue());
});
// Credential is now wiped
```

---

## MEDUSA Integration (NEW)

Automated security scanning using [MEDUSA](https://github.com/Pantheon-Security/medusa) - Multi-Language Security Scanner with 46+ analyzers.

### Quick Scan

```bash
npm run security-scan
# or
medusa scan . --fail-on high
```

### Configuration

See `.medusa.yml` in project root.

### CI/CD Integration

```yaml
# GitHub Actions
- name: Security Scan
  run: npm run security-scan
```

---

## Audit Logging

All events are logged with cryptographic integrity:

```
~/.local/share/notebooklm-mcp/audit/
├── audit-2025-11-28.jsonl
└── ...
```

### Log Format (JSONL with hash chain)

```json
{"timestamp":"2025-11-28T10:30:00Z","type":"tool","event":"ask_question","success":true,"duration_ms":3420,"hash":"a1b2c3..."}
```

Each entry's hash includes the previous entry, making tampering detectable.

### Configuration

```bash
NLMCP_AUDIT_ENABLED=true       # Default: true
NLMCP_AUDIT_DIR=/path/to/audit # Default: ~/.local/share/notebooklm-mcp/audit
```

---

## Session Timeout

Sessions are protected by dual timeout enforcement:

| Timeout | Default | Purpose |
|---------|---------|---------|
| Max Lifetime | 8 hours | Hard limit regardless of activity |
| Inactivity | 30 minutes | Closes idle sessions |

### Configuration

```bash
NLMCP_SESSION_MAX_LIFETIME=28800   # 8 hours in seconds
NLMCP_SESSION_INACTIVITY=1800      # 30 minutes in seconds
```

---

## MCP Authentication

Require authentication for all MCP requests.

### Setup

On first run with auth enabled, a token is auto-generated:
```
╔════════════════════════════════════════════════════════════╗
║  NEW MCP AUTHENTICATION TOKEN GENERATED                     ║
╠════════════════════════════════════════════════════════════╣
║  Token: <your-token>                                        ║
╠════════════════════════════════════════════════════════════╣
║  Add to your MCP client config:                            ║
║    NLMCP_AUTH_TOKEN=<token>                                ║
╚════════════════════════════════════════════════════════════╝
```

### Claude Code Configuration

```bash
claude mcp add notebooklm \
  --env NLMCP_AUTH_ENABLED=true \
  --env NLMCP_AUTH_TOKEN=<your-token> \
  npx notebooklm-mcp-secure
```

### Rate Limiting for Failed Auth

- 5 failed attempts = 5 minute lockout
- Prevents brute force attacks

---

## Response Validation

All responses from NotebookLM are scanned for:

### Prompt Injection Detection
- `ignore previous instructions`
- `you are now in [mode]`
- `system:` injections
- Chat template delimiters (`[INST]`, `<|im_start|>`)

### Suspicious URL Detection
- URL shorteners (bit.ly, tinyurl)
- Paste services (pastebin)
- File/JavaScript protocols
- Raw IP addresses
- Webhook URLs

### Encoded Payload Detection
- Long Base64 strings
- Hex encoded data
- Heavy URL encoding
- Unicode escape sequences

### Configuration

```bash
NLMCP_RESPONSE_VALIDATION=true
NLMCP_BLOCK_PROMPT_INJECTION=true
NLMCP_BLOCK_SUSPICIOUS_URLS=true
NLMCP_BLOCK_ENCODED_PAYLOADS=false  # Just warn by default
```

---

## Input Validation

All user inputs are validated:

| Input | Validation |
|-------|-----------|
| `notebook_url` | HTTPS only, domain whitelist (notebooklm.google.com variants) |
| `notebook_id` | Alphanumeric + dashes only, max 128 chars |
| `session_id` | Alphanumeric + dashes only, max 64 chars |
| `question` | Non-empty, max 32,000 chars |

### URL Whitelisting

Allowed domains:
- `notebooklm.google.com`
- Regional variants (`.co.uk`, `.de`, `.fr`, etc.)

Blocked:
- `javascript:` URLs
- `data:` URLs
- `file:` URLs
- Non-HTTPS URLs
- Path traversal attempts

---

## Log Sanitization

Sensitive data is masked in all log output:
- Email: `j***n@example.com`
- Passwords: `[REDACTED]`
- API keys: `[REDACTED]`
- Tokens: `[REDACTED]`

---

## Rate Limiting

Built-in rate limiting prevents abuse:
- 100 requests per minute per session
- Configurable via `RateLimiter` class

---

## Remaining Considerations

### Browser Automation Risks

This MCP uses browser automation (Patchright) which:
- May violate Google's Terms of Service
- Could be detected and blocked

**Recommendations:**
- Use a dedicated Google account (not your primary)
- Run in an isolated environment (VM or container)

### Not Encrypted (Chrome Profile)

The Chrome profile directory itself is not fully encrypted:
- `~/.local/share/notebooklm-mcp/chrome_profile/`

The sensitive state files (cookies, session) ARE encrypted with post-quantum cryptography.

---

## Quick Start

```bash
# Install
npm install notebooklm-mcp-secure

# Or with Claude Code
claude mcp add notebooklm npx notebooklm-mcp-secure@latest

# With all security features
claude mcp add notebooklm \
  --env NLMCP_AUTH_ENABLED=true \
  --env NLMCP_AUTH_TOKEN=$(openssl rand -base64 32) \
  --env NLMCP_USE_POST_QUANTUM=true \
  npx notebooklm-mcp-secure@latest
```

---

## Security Module API

```typescript
// Input validation & rate limiting
import {
  validateNotebookUrl,
  validateSessionId,
  validateQuestion,
  sanitizeForLogging,
  maskEmail,
  RateLimiter,
  SecurityError,
} from './utils/security.js';

// Post-quantum encryption (ML-KEM-768 + ChaCha20-Poly1305)
import {
  getSecureStorage,
  SecureStorage,
  encryptPQ,
  decryptPQ,
  generatePQKeyPair,
} from './utils/crypto.js';

// Response validation & prompt injection detection
import { getResponseValidator, validateResponse } from './utils/response-validator.js';

// Tamper-evident audit logging
import { getAuditLogger, audit } from './utils/audit-logger.js';

// MCP token authentication
import { getMCPAuthenticator, authenticateMCPRequest } from './auth/mcp-auth.js';

// Secrets scanning
import {
  SecretsScanner,
  scanForSecrets,
  scanAndRedactSecrets,
} from './utils/secrets-scanner.js';

// Certificate pinning
import {
  CertificatePinningManager,
  getCertificatePinningManager,
  validateCertificatePin,
} from './utils/cert-pinning.js';

// Memory security
import {
  SecureString,
  SecureCredential,
  SecureObject,
  zeroBuffer,
  withSecureCredential,
  secureCompare,
} from './utils/secure-memory.js';

// === USAGE EXAMPLES ===

// Post-quantum encrypted storage
const storage = getSecureStorage();
await storage.save('/path/to/file', sensitiveData);
const data = await storage.load('/path/to/file');

// Direct post-quantum encryption
const keyPair = generatePQKeyPair();
const encrypted = encryptPQ('secret data', keyPair.publicKey);
const decrypted = decryptPQ(encrypted, keyPair.secretKey);

// Secrets scanning
const secrets = scanForSecrets(responseText);
if (secrets.length > 0) {
  console.log('Found secrets:', secrets.map(s => s.type));
}

// Auto-redact secrets
const { clean, secrets: found } = await scanAndRedactSecrets(responseText);

// Memory-safe credential handling
await withSecureCredential(apiKey, async (cred) => {
  await makeRequest(cred.getValue());
}); // Auto-wiped after use

// Timing-safe comparison (prevents timing attacks)
if (secureCompare(userToken, storedToken)) {
  // Authenticated
}

// Response validation
const result = await validateResponse(notebookLMResponse);
if (!result.safe) {
  console.log('Blocked:', result.blocked);
}

// Audit logging
await audit.tool('ask_question', true, 3420, { question_length: 150 });
await audit.security('prompt_injection_detected', 'critical', { pattern: '...' });
```

---

## Reporting Vulnerabilities

If you discover a security vulnerability:
- Email: support@pantheonsecurity.io
- Do NOT open a public GitHub issue for security vulnerabilities

---

## Credits

- Original implementation: [Gérôme Dexheimer](https://github.com/PleasePrompto)
- Security hardening: [Pantheon Security](https://pantheonsecurity.io)
- Post-quantum crypto: [@noble/post-quantum](https://www.npmjs.com/package/@noble/post-quantum)

## License

MIT License (same as original)
