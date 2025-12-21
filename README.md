<div align="center">

# NotebookLM MCP Server (Security Hardened)

**Zero-hallucination answers from NotebookLM + Gemini Deep Research — with enterprise-grade security**

[![npm](https://img.shields.io/npm/v/@pan-sec/notebooklm-mcp?color=blue)](https://www.npmjs.com/package/@pan-sec/notebooklm-mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-2025-green.svg)](https://modelcontextprotocol.io/)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey.svg)](#cross-platform-support)
[![Security](https://img.shields.io/badge/Security-14%20Layers-red.svg)](./SECURITY.md)
[![Post-Quantum](https://img.shields.io/badge/Encryption-Post--Quantum-purple.svg)](./SECURITY.md#post-quantum-encryption)
[![Gemini](https://img.shields.io/badge/Gemini-Deep%20Research-4285F4.svg)](#-gemini-deep-research-v180)
[![Documents](https://img.shields.io/badge/Documents-API%20Upload-34A853.svg)](#-document-api-v190)
[![Notebooks](https://img.shields.io/badge/Notebooks-Create%20%26%20Manage-orange.svg)](#programmatic-notebook-creation-v170)
[![Compliance](https://img.shields.io/badge/Compliance-GDPR%20%7C%20SOC2%20%7C%20CSSF-blue.svg)](./docs/COMPLIANCE-SPEC.md)
[![Tests](https://img.shields.io/badge/Tests-111%20Passing-brightgreen.svg)](./tests/)

[**Gemini Deep Research**](#-gemini-deep-research-v180) • [**Document API**](#-document-api-v190) • [**Notebook Creation**](#programmatic-notebook-creation-v170) • [Security](#security-features) • [Install](#installation)

</div>

> **Security-hardened fork** of [PleasePrompto/notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp)
> Maintained by [Pantheon Security](https://pantheonsecurity.io)

---

## Gemini Deep Research (v1.8.0)

**The most powerful research capability for AI agents — now in your MCP toolkit.**

v1.8.0 introduces the **Gemini Interactions API** as a stable, API-based research backend alongside browser automation. This gives your agents access to Google's state-of-the-art Deep Research agent.

### Why This Matters

| Challenge | Solution |
|-----------|----------|
| Browser UI changes break automation | **Gemini API is stable and versioned** |
| Need comprehensive research but no research agent | **Deep Research agent does it for you** |
| Want current information with citations | **Google Search grounding built-in** |
| Need reliable, fast queries | **API-based = no UI dependencies** |

### New Tools

#### `deep_research` — Comprehensive Research Agent

```
"Research the security implications of post-quantum cryptography adoption in financial services"
```

- Runs Google's **Deep Research agent** (same as Gemini Advanced)
- Takes 1-5 minutes for comprehensive, web-grounded analysis
- Returns structured answers with **citations and sources**
- Perfect for complex topics requiring multi-source synthesis

#### `gemini_query` — Fast Grounded Queries

```
"What are the latest CVEs for Log4j in 2025?" (with Google Search)
"Calculate the compound interest on $10,000 at 5% over 10 years" (with code execution)
"Summarize this security advisory: [URL]" (with URL context)
```

- **Google Search grounding** — Current information, not just training data
- **Code execution** — Run calculations, data analysis
- **URL context** — Analyze web pages on demand
- Models: `gemini-2.5-flash` (fast), `gemini-2.5-pro` (powerful), `gemini-3-flash-preview` (latest)

#### `get_research_status` — Background Task Monitoring

Run deep research in the background and check progress:
```
"Start researching [topic] in the background"
... continue other work ...
"Check research status for interaction_abc123"
```

### Hybrid Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         NotebookLM MCP Server v1.9.0                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────┐    ┌──────────────────────────────────┐  │
│  │      BROWSER AUTOMATION        │    │          GEMINI API              │  │
│  │      (Your Documents)          │    │    (Research & Documents)        │  │
│  ├────────────────────────────────┤    ├──────────────────────────────────┤  │
│  │                                │    │                                  │  │
│  │  QUERY                         │    │  RESEARCH                  v1.8  │  │
│  │  • ask_question                │    │  • deep_research                 │  │
│  │                                │    │  • gemini_query                  │  │
│  │  CREATE & MANAGE         v1.7  │    │  • get_research_status           │  │
│  │  • create_notebook             │    │                                  │  │
│  │  • batch_create_notebooks      │    │  DOCUMENTS (NEW!)          v1.9  │  │
│  │  • manage_sources              │    │  • upload_document               │  │
│  │  • generate_audio              │    │  • query_document                │  │
│  │  • sync_notebook               │    │  • list_documents                │  │
│  │                                │    │  • delete_document               │  │
│  │  Grounded on YOUR docs         │    │                                  │  │
│  │  Permanent storage             │    │  Fast API • 48h retention        │  │
│  └────────────────────────────────┘    └──────────────────────────────────┘  │
│                                                                              │
│                      ┌─────────────────────────────────┐                     │
│                      │       14 SECURITY LAYERS        │                     │
│                      │   Post-Quantum • Audit Logs     │                     │
│                      │   Cert Pinning • Memory Wipe    │                     │
│                      │   GDPR • SOC2 • CSSF Ready      │                     │
│                      └─────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Gemini Configuration

```bash
# Required for Gemini features
GEMINI_API_KEY=your-api-key          # Get from https://aistudio.google.com/apikey

# Optional settings
GEMINI_DEFAULT_MODEL=gemini-2.5-flash    # Default model
GEMINI_DEEP_RESEARCH_ENABLED=true        # Enable Deep Research
GEMINI_TIMEOUT_MS=30000                  # API timeout
```

### When to Use Which

| Task | Best Tool | Why |
|------|-----------|-----|
| Questions about YOUR documents | `ask_question` | Grounded on your uploaded sources |
| Comprehensive topic research | `deep_research` | Multi-source synthesis with citations |
| Current events / recent info | `gemini_query` + google_search | Live web data |
| Code calculations | `gemini_query` + code_execution | Reliable computation |
| Analyze a webpage | `gemini_query` + url_context | Direct page analysis |
| **Quick PDF/document analysis** | `upload_document` + `query_document` | **Fast API, no browser** (NEW!) |

---

## 📄 Document API (v1.9.0)

**Upload and query documents directly via Gemini API — no browser automation needed.**

v1.9.0 introduces the **Gemini Files API** for fast, reliable document analysis. Upload PDFs, analyze them instantly, and delete when done.

### Why This Matters

| Feature | Browser Mode | Document API |
|---------|--------------|--------------|
| Speed | Seconds | **Milliseconds** |
| Reliability | UI-dependent | **API-stable** |
| File Support | Via NotebookLM | **50MB PDFs, 1000 pages** |
| Retention | Permanent | 48 hours |
| Setup | Auth + cookies | **Just API key** |

### New Tools

#### `upload_document` — Fast Document Upload

Upload any document to Gemini for instant querying:

```
Upload /path/to/research-paper.pdf
```

- **Supported**: PDF (50MB, 1000 pages), TXT, MD, HTML, CSV, JSON, DOCX, images, audio, video
- **48-hour retention** — files auto-expire, or delete manually
- Returns a file ID for querying

#### `query_document` — Ask Questions About Documents

```
"What are the main findings in this research paper?"
"Summarize section 3 of the document"
"Extract all statistics mentioned in the PDF"
```

- Full document understanding (text, tables, charts, diagrams)
- Multi-document queries (compare multiple files)
- Fast API response (no browser wait)

#### `list_documents` — See All Uploaded Files

```
List all my uploaded documents
```

Shows file names, sizes, MIME types, and expiration times.

#### `delete_document` — Clean Up Sensitive Files

```
Delete file xyz123
```

Immediately remove files (don't wait for 48h expiration).

### Workflow Example

```
1. upload_document("/research/paper.pdf")
   → Returns: files/abc123

2. query_document("files/abc123", "What methodology was used?")
   → Returns: "The paper uses a mixed-methods approach combining..."

3. query_document("files/abc123", "List all cited authors")
   → Returns: "Smith et al. (2024), Johnson (2023)..."

4. delete_document("files/abc123")
   → File removed
```

### When to Use Document API vs NotebookLM

| Scenario | Use |
|----------|-----|
| Quick one-off document analysis | **Document API** — fast, no setup |
| Building a permanent knowledge base | **NotebookLM** — permanent storage |
| Analyzing sensitive documents | **Document API** — 48h auto-delete |
| Multi-source research over time | **NotebookLM** — organized notebooks |
| CI/CD pipeline document processing | **Document API** — API-native |

---

## Programmatic Notebook Creation (v1.7.0+)

**Create NotebookLM notebooks entirely from code — no manual clicks required.**

Most MCP servers can only *read* from NotebookLM. This one can **create notebooks, add sources, and generate audio** — all programmatically.

### `create_notebook` — Build Notebooks Instantly

Create a complete notebook with multiple sources in one command:

```json
{
  "name": "Security Research 2025",
  "sources": [
    { "type": "url", "value": "https://owasp.org/Top10" },
    { "type": "file", "value": "/path/to/security-report.pdf" },
    { "type": "text", "value": "Custom analysis notes...", "title": "My Notes" }
  ],
  "description": "OWASP security best practices",
  "topics": ["security", "owasp", "vulnerabilities"]
}
```

**Supported source types:**
- **URL** — Web pages, documentation, articles
- **File** — PDF, DOCX, TXT, and more
- **Text** — Raw text, code snippets, notes

### `batch_create_notebooks` — Scale Up

Create **up to 10 notebooks** in a single operation:

```json
{
  "notebooks": [
    { "name": "React Docs", "sources": [{ "type": "url", "value": "https://react.dev/reference" }] },
    { "name": "Node.js API", "sources": [{ "type": "url", "value": "https://nodejs.org/api/" }] },
    { "name": "TypeScript Handbook", "sources": [{ "type": "url", "value": "https://www.typescriptlang.org/docs/" }] }
  ]
}
```

Perfect for:
- Setting up project documentation libraries
- Onboarding new team members with curated knowledge bases
- Creating topic-specific research notebooks in bulk

### `manage_sources` — Dynamic Source Management

Add or remove sources from existing notebooks:

```json
{
  "notebook_id": "abc123",
  "action": "add",
  "sources": [{ "type": "url", "value": "https://new-documentation.com" }]
}
```

### `generate_audio` — Audio Overview Creation

Generate NotebookLM's famous "Audio Overview" podcasts programmatically:

```
"Generate an audio overview for my Security Research notebook"
```

### `sync_notebook` — Keep Sources Updated

Sync notebook sources from a local directory:

```json
{
  "notebook_id": "abc123",
  "directory": "/path/to/docs",
  "patterns": ["*.md", "*.pdf"]
}
```

### Why This Matters

| Traditional Workflow | With This MCP |
|---------------------|---------------|
| Manually create notebook in browser | `create_notebook` → done |
| Click "Add source" for each document | Batch add in single command |
| Navigate UI to generate audio | `generate_audio` → podcast ready |
| Update sources by hand | `sync_notebook` from local files |

**Your agent can now build entire knowledge bases autonomously.**

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
| 🖥️ | **Cross-Platform** | Native support for Linux, macOS, Windows |

### Post-Quantum Ready

Traditional encryption (RSA, ECDH) will be broken by quantum computers. This fork uses **hybrid encryption**:

```
ML-KEM-768 (Kyber) + ChaCha20-Poly1305
```

- **ML-KEM-768**: NIST-standardized post-quantum key encapsulation
- **ChaCha20-Poly1305**: Modern stream cipher (immune to timing attacks)

Even if one algorithm is broken, the other remains secure.

### Cross-Platform Support

Full native support for all major operating systems:

| Platform | File Permissions | Data Directory |
|----------|-----------------|----------------|
| **Linux** | Unix chmod (0o600/0o700) | `~/.local/share/notebooklm-mcp/` |
| **macOS** | Unix chmod (0o600/0o700) | `~/Library/Application Support/notebooklm-mcp/` |
| **Windows** | ACLs via icacls (current user only) | `%LOCALAPPDATA%\notebooklm-mcp\` |

All sensitive files (encryption keys, auth tokens, audit logs) are automatically protected with owner-only permissions on every platform.

### Enterprise Compliance (v1.6.0+)

Full compliance support for regulated industries:

| Regulation | Features |
|------------|----------|
| **GDPR** | Consent management, DSAR handling, right to erasure, data portability |
| **SOC2 Type II** | Hash-chained audit logs, incident response, availability monitoring |
| **CSSF** | 7-year retention, SIEM integration, policy documentation |

#### Compliance Tools (16 MCP tools)
```
compliance_dashboard    - Real-time compliance status
compliance_report       - Generate audit reports (JSON/CSV/HTML)
compliance_evidence     - Collect evidence packages
grant_consent          - Record user consent
submit_dsar            - Handle data subject requests
request_erasure        - Right to be forgotten
export_user_data       - Data portability export
create_incident        - Security incident management
...and 8 more
```

See [COMPLIANCE-SPEC.md](./docs/COMPLIANCE-SPEC.md) for full documentation.

---

## Installation

### Claude Code
```bash
claude mcp add notebooklm -- npx @pan-sec/notebooklm-mcp@latest
```

### With Authentication + Gemini (Recommended)
```bash
claude mcp add notebooklm \
  --env NLMCP_AUTH_ENABLED=true \
  --env NLMCP_AUTH_TOKEN=$(openssl rand -base64 32) \
  --env GEMINI_API_KEY=your-gemini-api-key \
  -- npx @pan-sec/notebooklm-mcp@latest
```

### Codex
```bash
codex mcp add notebooklm -- npx @pan-sec/notebooklm-mcp@latest
```

<details>
<summary>Cursor</summary>

Add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "notebooklm": {
      "command": "npx",
      "args": ["-y", "@pan-sec/notebooklm-mcp@latest"],
      "env": {
        "NLMCP_AUTH_ENABLED": "true",
        "NLMCP_AUTH_TOKEN": "your-secure-token",
        "GEMINI_API_KEY": "your-gemini-api-key"
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
      "args": ["-y", "@pan-sec/notebooklm-mcp@latest"],
      "env": {
        "NLMCP_AUTH_ENABLED": "true",
        "NLMCP_AUTH_TOKEN": "your-secure-token",
        "GEMINI_API_KEY": "your-gemini-api-key"
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

### 5. Try Deep Research (NEW!)
```
"Use deep research to investigate [complex topic]"
```

---

## Complete Tool Reference

### Research Tools
| Tool | Description | Backend |
|------|-------------|---------|
| `ask_question` | Query your NotebookLM notebooks | Browser |
| `deep_research` | Comprehensive research with citations | Gemini API |
| `gemini_query` | Fast queries with grounding tools | Gemini API |
| `get_research_status` | Check background research progress | Gemini API |

### Notebook Management
| Tool | Description |
|------|-------------|
| `add_notebook` | Add notebook to library |
| `list_notebooks` | List all notebooks |
| `get_notebook` | Get notebook details |
| `update_notebook` | Update notebook metadata |
| `remove_notebook` | Remove from library |
| `select_notebook` | Set active notebook |
| `search_notebooks` | Search by query |

### Source Management (v1.7.0+)
| Tool | Description |
|------|-------------|
| `manage_sources` | Add/remove/list sources |
| `generate_audio` | Create Audio Overview |
| `sync_notebook` | Sync sources from local files |

### Session & System
| Tool | Description |
|------|-------------|
| `list_sessions` | View active sessions |
| `close_session` | Close a session |
| `reset_session` | Reset session chat |
| `get_health` | Server health check |
| `setup_auth` | Initial authentication |
| `re_auth` | Re-authenticate |
| `cleanup_data` | Deep cleanup utility |
| `get_library_stats` | Library statistics |

### Compliance (v1.6.0+)
16 compliance tools for GDPR, SOC2, and CSSF requirements.

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
| Gemini API key | Secure memory handling |

---

## Configuration

All security features are **enabled by default**. Override via environment variables:

```bash
# Authentication
NLMCP_AUTH_ENABLED=true
NLMCP_AUTH_TOKEN=your-secret-token

# Gemini API (v1.8.0+)
GEMINI_API_KEY=your-api-key
GEMINI_DEFAULT_MODEL=gemini-2.5-flash
GEMINI_DEEP_RESEARCH_ENABLED=true
GEMINI_TIMEOUT_MS=30000

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
  run: npx @pan-sec/notebooklm-mcp && npm run security-scan
```

---

## Comparison

| Feature | Original | This Fork |
|---------|----------|-----------|
| Zero-hallucination Q&A | ✅ | ✅ |
| Library management | ✅ | ✅ |
| Multi-client support | ✅ | ✅ |
| **Create Notebooks Programmatically** | ❌ | ✅ **UNIQUE** |
| **Batch Create (10 notebooks at once)** | ❌ | ✅ **UNIQUE** |
| **Gemini Deep Research** | ❌ | ✅ **NEW** |
| **Gemini Query with Grounding** | ❌ | ✅ **NEW** |
| **Source Management (add/remove)** | ❌ | ✅ |
| **Audio Overview Generation** | ❌ | ✅ |
| **Sync from Local Directories** | ❌ | ✅ |
| **Cross-platform (Linux/macOS/Windows)** | ⚠️ | ✅ |
| **Post-quantum encryption** | ❌ | ✅ |
| **Secrets scanning** | ❌ | ✅ |
| **Certificate pinning** | ❌ | ✅ |
| **Memory scrubbing** | ❌ | ✅ |
| **Audit logging** | ❌ | ✅ |
| **MCP authentication** | ❌ | ✅ |
| **Prompt injection detection** | ❌ | ✅ |
| **Enterprise Compliance (GDPR/SOC2/CSSF)** | ❌ | ✅ |

---

## Version History

| Version | Highlights |
|---------|------------|
| **v1.8.0** | Gemini Interactions API: Deep Research, Query with Grounding, Background Tasks |
| **v1.7.0** | Source management, batch operations, audio generation, webhooks |
| **v1.6.0** | Enterprise compliance: GDPR, SOC2 Type II, CSSF |
| **v1.5.0** | Cross-platform support (Windows ACLs, macOS, Linux) |
| **v1.4.0** | Post-quantum encryption, secrets scanning |
| **v1.3.0** | Certificate pinning, audit logging |

---

## Reporting Vulnerabilities

Found a security issue? **Do not open a public GitHub issue.**

Email: support@pantheonsecurity.io

---

## Credits

- **Original MCP Server**: [Gérôme Dexheimer](https://github.com/PleasePrompto) — [notebooklm-mcp](https://github.com/PleasePrompto/notebooklm-mcp)
- **Security Hardening**: [Pantheon Security](https://pantheonsecurity.io)
- **Post-Quantum Crypto**: [@noble/post-quantum](https://www.npmjs.com/package/@noble/post-quantum)
- **Gemini API**: [Google AI](https://ai.google.dev/)

## License

MIT — Same as original.

---

<div align="center">

**Security hardened with 🔒 by [Pantheon Security](https://pantheonsecurity.io)**

**Powered by Google Gemini 🚀**

[Full Security Documentation](./SECURITY.md) • [Compliance Guide](./docs/COMPLIANCE-SPEC.md) • [Report Vulnerability](mailto:support@pantheonsecurity.io)

</div>
