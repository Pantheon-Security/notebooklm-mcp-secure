<div align="center">

# NotebookLM MCP Server (Security Hardened)

**Zero-hallucination answers from NotebookLM — now with enterprise-grade security**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2025-green.svg)](https://modelcontextprotocol.io/)
[![Security](https://img.shields.io/badge/Security-14%20Layers-red.svg)](./SECURITY.md)
[![Post-Quantum](https://img.shields.io/badge/Encryption-Post--Quantum-purple.svg)](./SECURITY.md#post-quantum-encryption)
[![Tests](https://img.shields.io/badge/Tests-111%20Passing-brightgreen.svg)](./tests/)

[Security Features](#security-features) • [Installation](#installation) • [Quick Start](#quick-start) • [Why This Fork?](#why-this-fork) • [Documentation](./SECURITY.md)

</div>

> 🔒 **Security-hardened fork** of [PleasePrompto/notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp)
> Maintained by [Pantheon Security](https://pantheonsecurity.io)

---

## Why This Fork?

The original NotebookLM MCP is excellent for productivity — but MCP servers handle sensitive data:
- **Browser sessions** with Google authentication
- **Cookies and tokens** stored on disk
- **Query history** that may contain proprietary information

This fork adds **14 security hardening layers** to protect that data.

---

## Security Features

| Layer | Feature | Protection |
|-------|---------|------------|
| 🔐 | **Post-Quantum Encryption** | ML-KEM-768 + ChaCha20-Poly1305 hybrid |
| 🔍 | **Secrets Scanning** | Detects 30+ credential patterns (AWS, GitHub, Slack...) |
| 📌 | **Certificate Pinning** | Blocks MITM attacks on Google connections |
| 🧹 | **Memory Scrubbing** | Zeros sensitive data after use |
| 📝 | **Audit Logging** | Tamper-evident logs with hash chains |
| ⏱️ | **Session Timeout** | 8h hard limit + 30m inactivity auto-logout |
| 🎫 | **MCP Authentication** | Token-based auth with brute-force lockout |
| 🛡️ | **Response Validation** | Detects prompt injection attempts |
| ✅ | **Input Validation** | URL whitelisting, sanitization |
| 🚦 | **Rate Limiting** | Per-session request throttling |
| 🙈 | **Log Sanitization** | Credentials masked in all output |
| 🐍 | **MEDUSA Integration** | Automated security scanning |

### Post-Quantum Ready

Traditional encryption (RSA, ECDH) will be broken by quantum computers. This fork uses **hybrid encryption**:

```
ML-KEM-768 (Kyber) + ChaCha20-Poly1305
```

- **ML-KEM-768**: NIST-standardized post-quantum key encapsulation
- **ChaCha20-Poly1305**: Modern stream cipher (immune to timing attacks)

Even if one algorithm is broken, the other remains secure.

---

## Installation

### Claude Code
```bash
claude mcp add notebooklm npx notebooklm-mcp-secure@latest
```

### With Authentication (Recommended)
```bash
claude mcp add notebooklm \
  --env NLMCP_AUTH_ENABLED=true \
  --env NLMCP_AUTH_TOKEN=$(openssl rand -base64 32) \
  npx notebooklm-mcp-secure@latest
```

### Codex
```bash
codex mcp add notebooklm -- npx notebooklm-mcp-secure@latest
```

<details>
<summary>Cursor</summary>

Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["-y", "notebooklm-mcp-secure@latest"],
      "env": {
        "NLMCP_AUTH_ENABLED": "true",
        "NLMCP_AUTH_TOKEN": "your-secure-token"
      }
    }
  }
}
```
</details>

<details>
<summary>Other MCP Clients</summary>

```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["notebooklm-mcp-secure@latest"],
      "env": {
        "NLMCP_AUTH_ENABLED": "true",
        "NLMCP_AUTH_TOKEN": "your-secure-token"
      }
    }
  }
}
```
</details>

---

## Quick Start

### 1. Install (see above)

### 2. Authenticate
```
"Log me in to NotebookLM"
```
*Chrome opens → sign in with Google*

### 3. Add your notebook
Go to [notebooklm.google.com](https://notebooklm.google.com) → Create notebook → Upload docs → Share link

### 4. Use it
```
"Research [topic] using this NotebookLM: [link]"
```

---

## What Gets Protected

| Data | Protection |
|------|------------|
| Browser cookies | Post-quantum encrypted at rest |
| Session tokens | Auto-expire + memory scrubbing |
| Query history | Audit logged with tamper detection |
| Google connection | Certificate pinned (MITM blocked) |
| Log output | Credentials auto-redacted |
| API responses | Scanned for leaked secrets |

---

## Configuration

All security features are **enabled by default**. Override via environment variables:

```bash
# Authentication
NLMCP_AUTH_ENABLED=true
NLMCP_AUTH_TOKEN=your-secret-token

# Encryption
NLMCP_USE_POST_QUANTUM=true
NLMCP_ENCRYPTION_KEY=base64-32-bytes  # Optional custom key

# Session Limits
NLMCP_SESSION_MAX_LIFETIME=28800  # 8 hours
NLMCP_SESSION_INACTIVITY=1800     # 30 minutes

# Secrets Scanning
NLMCP_SECRETS_SCANNING=true
NLMCP_SECRETS_BLOCK=false         # Block on detection
NLMCP_SECRETS_REDACT=true         # Auto-redact

# Certificate Pinning
NLMCP_CERT_PINNING=true

# Audit Logging
NLMCP_AUDIT_ENABLED=true
```

See [SECURITY.md](./SECURITY.md) for complete configuration reference.

---

## Security Scanning

Run MEDUSA security scanner:

```bash
npm run security-scan
```

Or integrate in CI/CD:

```yaml
- name: Security Scan
  run: npx notebooklm-mcp-secure && npm run security-scan
```

---

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Claude/     │────▶│  MCP Server      │────▶│ NotebookLM  │
│ Codex       │     │  (This Fork)     │     │ (Google)    │
└─────────────┘     └──────────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │ 14 Security │
                    │   Layers    │
                    └─────────────┘
                    • PQ Encryption
                    • Secrets Scan
                    • Cert Pinning
                    • Memory Wipe
                    • Audit Logs
                    • Rate Limits
                    • ...
```

Your agent asks questions → Security layers protect the pipeline → NotebookLM answers from your docs.

---

## Original Features (Preserved)

All original functionality from [PleasePrompto/notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp):

- **Zero hallucinations** — NotebookLM only answers from your uploaded docs
- **Autonomous research** — Claude asks follow-up questions automatically
- **Smart library** — Save notebooks with tags, auto-select by context
- **Cross-tool sharing** — Works with Claude Code, Codex, Cursor, etc.
- **Tool profiles** — Minimal, standard, or full tool sets

---

## Comparison

| Feature | Original | This Fork |
|---------|----------|-----------|
| Zero-hallucination Q&A | ✅ | ✅ |
| Library management | ✅ | ✅ |
| Multi-client support | ✅ | ✅ |
| **Post-quantum encryption** | ❌ | ✅ |
| **Secrets scanning** | ❌ | ✅ |
| **Certificate pinning** | ❌ | ✅ |
| **Memory scrubbing** | ❌ | ✅ |
| **Audit logging** | ❌ | ✅ |
| **MCP authentication** | ❌ | ✅ |
| **Prompt injection detection** | ❌ | ✅ |

---

## Reporting Vulnerabilities

Found a security issue? **Do not open a public GitHub issue.**

Email: support@pantheonsecurity.io

---

## Credits

- **Original MCP Server**: [Gérôme Dexheimer](https://github.com/PleasePrompto) — [notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp)
- **Security Hardening**: [Pantheon Security](https://pantheonsecurity.io)
- **Post-Quantum Crypto**: [@noble/post-quantum](https://www.npmjs.com/package/@noble/post-quantum)

## License

MIT — Same as original.

---

<div align="center">

**Security hardened with 🔒 by [Pantheon Security](https://pantheonsecurity.io)**

[Full Security Documentation](./SECURITY.md) • [Report Vulnerability](mailto:support@pantheonsecurity.io)

</div>
