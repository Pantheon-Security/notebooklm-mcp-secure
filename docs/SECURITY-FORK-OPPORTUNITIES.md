# Security Fork Opportunities

MCP servers that could benefit from Pantheon Security hardening.

**Last Updated:** 2026-01-24

---

## High Priority (High Traffic + High Risk)

| Rank | Server | Weekly Visitors | Security Gaps | Effort |
|------|--------|-----------------|---------------|--------|
| #4 | **Filesystem** (Anthropic) | 193K | No sandboxing, no path validation, no audit logging | Medium |
| #18 | **PostgreSQL** (Anthropic) | 31.8K | SQL injection risk, no query validation, no audit trails | Medium |
| #17 | **MongoDB** (MongoDB Inc.) | 35.6K | NoSQL injection, data exfiltration, no encryption | Medium |
| #12 | **Git** (Anthropic) | 66.8K | Command execution, credential exposure, repo tampering | Medium |
| #19 | **Supabase** (Supabase) | 40.5K | Database + auth, credential exposure, API key leaks | High |

---

## Medium Priority (Good Traffic + Moderate Risk)

| Rank | Server | Weekly Visitors | Security Gaps | Effort |
|------|--------|-----------------|---------------|--------|
| #3 | **Fetch** (Anthropic) | 249K | URL validation, SSRF risks, data exfiltration | Low |
| #7 | **Claude Flow** (ruvnet) | 163K | Agent orchestration, prompt injection, privilege escalation | High |
| #8 | **Playwriter** (Community) | 129K | Browser automation, credential capture, DOM injection | Medium |
| #20 | **Notion** (Notion) | 26.7K | API key exposure, data access logging | Low |
| #16 | **Zapier** (Zapier) | 48.9K | 8000+ app integrations, credential management | High |

---

## Already Covered

| Server | Pantheon Fork | Status |
|--------|---------------|--------|
| Chrome/Playwright | [chrome-mcp-secure](https://github.com/Pantheon-Security/chrome-mcp-secure) | ✅ Published |
| NotebookLM | [notebooklm-mcp-secure](https://github.com/Pantheon-Security/notebooklm-mcp-secure) | ✅ Published |

---

## Security Layers to Add

Standard Pantheon Security hardening:

1. **Input Validation** - Zod schemas, path traversal prevention
2. **Audit Logging** - Hash-chained logs, SIEM integration
3. **Post-Quantum Encryption** - ML-KEM-768 + ChaCha20-Poly1305
4. **Credential Protection** - Secrets scanning, memory scrubbing
5. **Rate Limiting** - Abuse prevention
6. **Compliance Tools** - GDPR consent, SOC2 evidence, CSSF retention
7. **Session Security** - Timeouts, MCP authentication
8. **Response Validation** - Output sanitization

---

## Recommended First Target

**filesystem-mcp-secure**
- Highest risk (direct file system access)
- Large user base (193K weekly)
- Clear value prop: "Secure file access with sandboxing and audit trails"
- Anthropic's official = credibility for fork

---

## Research Links

| Server | GitHub |
|--------|--------|
| Filesystem | https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem |
| PostgreSQL | https://github.com/modelcontextprotocol/servers/tree/main/src/postgres |
| Git | https://github.com/modelcontextprotocol/servers/tree/main/src/git |
| MongoDB | https://github.com/mongodb/mcp-server |
| Fetch | https://github.com/modelcontextprotocol/servers/tree/main/src/fetch |

---

*Track progress and prioritize based on enterprise customer demand.*
