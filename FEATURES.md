# NotebookLM MCP Server - Feature List

**Version:** 2026.3.0
**Last Updated:** 2026-04-25

---

## Overview

Security-hardened MCP server for NotebookLM API with enterprise compliance (GDPR, SOC2, CSSF). Provides conversational research capabilities through Gemini 2.5 grounded on your notebook sources.

---

## MCP Tools (19 Total)

### Research & Conversation

| Tool | Description |
|------|-------------|
| `ask_question` | Conversational research with Gemini 2.5, session-based context, source-cited responses |

### Notebook Management

| Tool | Description |
|------|-------------|
| `create_notebook` | Programmatically create notebooks with URL/text/file sources |
| `add_notebook` | Add existing notebook to local library |
| `list_notebooks` | List all library notebooks with metadata |
| `get_notebook` | Get detailed notebook information by ID |
| `select_notebook` | Set active notebook for queries |
| `update_notebook` | Update notebook metadata (topics, description, etc.) |
| `remove_notebook` | Remove notebook from library |
| `search_notebooks` | Search library by query |
| `get_library_stats` | Get library statistics |
| `sync_library` | Sync local library with actual NotebookLM notebooks |

### Session Management

| Tool | Description |
|------|-------------|
| `list_sessions` | List active browser sessions with stats |
| `close_session` | Close a specific session |
| `reset_session` | Reset session chat history |

### System & Authentication

| Tool | Description |
|------|-------------|
| `get_health` | Server health, auth state, configuration |
| `setup_auth` | Initial Google authentication |
| `re_auth` | Switch accounts or re-authenticate |
| `cleanup_data` | Deep cleanup across 8 data categories |
| `get_quota` | View license tier, usage, and limits |

---

## Quota Management

### Supported License Tiers

| Tier | Notebooks | Sources/Notebook | Queries/Day | Price |
|------|-----------|------------------|-------------|-------|
| Free | 100 | 50 | 50 | $0 |
| Pro | 500 | 300 | 500 | ~$20/mo |
| Ultra | 500 | 600 | 5,000 | $249.99/mo |

### Features
- Auto-detection of license tier from NotebookLM UI
- Pre-creation limit checks (notebooks, sources, queries)
- Daily query counter with automatic midnight reset
- Persistent settings in `~/.config/notebooklm-mcp/quota.json`

---

## Security Hardening

### Input/Output Protection
| Feature | Description |
|---------|-------------|
| Input Validation | Zod schemas, type checking, injection prevention |
| URL Whitelisting | Only `notebooklm.google.com` allowed |
| Response Validation | Prompt injection detection, content sanitization |
| Log Sanitization | PII/secrets removed from logs |
| Credential Masking | Passwords never logged or exposed |

### Cryptography
| Feature | Description |
|---------|-------------|
| Post-Quantum Encryption | ML-KEM-768 + AES-256-GCM for credential vault |
| Secure Memory | Memory scrubbing after sensitive operations |
| Certificate Pinning | Google certificate validation |

### Access Control
| Feature | Description |
|---------|-------------|
| Rate Limiting | Per-session request limits |
| Session Timeout | Configurable inactivity/max lifetime |
| MCP Authentication | Optional API key authentication |
| Secrets Scanning | Detect accidental credential exposure |

### Integration
| Feature | Description |
|---------|-------------|
| MEDUSA Scanner | Security vulnerability scanning (`npm run security-scan`) |
| Audit Logging | All tool calls logged with timestamps |

---

## Enterprise Compliance

### GDPR (EU Data Protection)

| Feature | Module | Description |
|---------|--------|-------------|
| Consent Management | `ConsentManager` | Track user consent with timestamps |
| Privacy Notice | `PrivacyNoticeManager` | Data collection transparency |
| Data Subject Rights | `DSARHandler` | Access, rectification, portability requests |
| Right to Erasure | `DataErasureManager` | Complete data deletion |
| Data Portability | `DataExport` | Export in standard formats |

### SOC2 (Security & Operations)

| Feature | Module | Description |
|---------|--------|-------------|
| Hash-Chained Audit Logs | `AuditLogger` | Tamper-evident log chain |
| Change Management | `ChangeLog` | Track all system changes |
| Incident Response | `IncidentManager` | Security incident handling |
| Availability Monitoring | `HealthMonitor` | Service health checks |
| Evidence Collection | `EvidenceCollector` | Audit evidence gathering |

### CSSF (Luxembourg Financial Regulation)

| Feature | Module | Description |
|---------|--------|-------------|
| 7-Year Retention | `RetentionEngine` | Configurable data retention |
| SIEM Integration | `SiemExporter` | Export to security platforms |
| Policy Documentation | `PolicyDocManager` | Automated policy generation |
| Breach Detection | `BreachDetection` | Security breach monitoring |
| Alert Management | `AlertManager` | Compliance alert system |

### Compliance Dashboard

| Feature | Module | Description |
|---------|--------|-------------|
| Data Inventory | `DataInventory` | Track all data assets |
| Data Classification | `DataClassification` | Sensitivity labeling |
| Report Generation | `ReportGenerator` | Compliance reports |
| Dashboard | `ComplianceDashboard` | Real-time compliance status |

---

## Browser Automation

### Core Engine
- **Patchright** - Undetectable Playwright fork
- **Persistent Chrome Profile** - Consistent fingerprint across restarts
- **Stealth Mode** - Human-like behavior patterns

### Stealth Features
| Feature | Description |
|---------|-------------|
| Human Typing | Variable WPM (160-240), natural patterns |
| Mouse Movements | Realistic cursor trajectories |
| Random Delays | Variable timing between actions |
| Fingerprint Persistence | Same browser identity across sessions |

### Session Management
| Feature | Description |
|---------|-------------|
| Multi-Session Support | Up to 10 concurrent sessions |
| Session Timeout | Configurable inactivity limits |
| Session Recovery | Automatic page/auth recovery |
| Shared Context | Single browser context for efficiency |

---

## Library Management

### Features
- Local notebook library with metadata
- Active notebook selection
- Use count tracking
- Topic and tag organization
- Search by name, description, topics
- Sync with actual NotebookLM notebooks

### Storage
- Location: `~/.local/share/notebooklm-mcp/library.json`
- Backup on modifications
- Secure file permissions (0600)

---

## Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `NOTEBOOKLM_HEADLESS` | Run browser headless | `true` |
| `NOTEBOOKLM_STEALTH` | Enable stealth features | `true` |
| `NOTEBOOKLM_MAX_SESSIONS` | Max concurrent sessions | `10` |
| `NOTEBOOKLM_SESSION_TIMEOUT` | Session timeout (seconds) | `900` |
| `MCP_AUTH_ENABLED` | Enable MCP authentication | `false` |

### Directories
| Purpose | Linux/macOS | Windows |
|---------|-------------|---------|
| Config | `~/.config/notebooklm-mcp/` | `%APPDATA%\notebooklm-mcp\` |
| Data | `~/.local/share/notebooklm-mcp/` | `%LOCALAPPDATA%\notebooklm-mcp\` |
| Cache | `~/.cache/notebooklm-mcp/` | `%TEMP%\notebooklm-mcp\` |

---

## Architecture

### Core Modules

```
src/
├── index.ts                 # MCP server entry point
├── config.ts                # Configuration management
├── errors.ts                # Custom error types
│
├── auth/
│   ├── auth-manager.ts      # Google authentication
│   └── mcp-auth.ts          # MCP API key auth
│
├── session/
│   ├── browser-session.ts   # Individual browser sessions
│   ├── session-manager.ts   # Session pool management
│   ├── session-timeout.ts   # Timeout handling
│   └── shared-context-manager.ts  # Browser context
│
├── library/
│   ├── notebook-library.ts  # Library CRUD operations
│   └── types.ts             # Library types
│
├── quota/
│   ├── quota-manager.ts     # License tier & limits
│   └── index.ts             # Module exports
│
├── notebook-creation/
│   ├── notebook-creator.ts  # Create notebooks
│   ├── notebook-sync.ts     # Sync with NotebookLM
│   ├── selector-discovery.ts # UI selector detection
│   └── selectors.ts         # Known UI selectors
│
├── tools/
│   ├── handlers.ts          # Tool implementations
│   ├── definitions/         # Tool schemas
│   └── index.ts             # Tool exports
│
├── compliance/
│   ├── consent-manager.ts   # GDPR consent
│   ├── dsar-handler.ts      # Data subject requests
│   ├── retention-engine.ts  # Data retention
│   ├── siem-exporter.ts     # SIEM integration
│   └── ...                  # Other compliance modules
│
└── utils/
    ├── security.ts          # Security utilities
    ├── crypto.ts            # Cryptographic functions
    ├── audit-logger.ts      # Audit logging
    ├── stealth-utils.ts     # Human-like behavior
    └── ...                  # Other utilities
```

---

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Linux | Full | Primary development platform |
| macOS | Full | Tested on Intel & Apple Silicon |
| Windows | Full | Requires Windows 10+ |

---

## Dependencies

### Runtime
- `@modelcontextprotocol/sdk` - MCP protocol
- `patchright` - Browser automation
- `@noble/post-quantum` - Post-quantum cryptography
- `zod` - Schema validation

### Development
- `typescript` - Type checking
- `tsx` - TypeScript execution
- `vitest` - Testing

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 1.6.0 | 2025-12 | Quota management, create_notebook, sync_library |
| 1.5.0 | 2025-12 | Enterprise compliance (GDPR, SOC2, CSSF) |
| 1.4.0 | 2025-12 | Cross-platform support, secure permissions |
| 1.3.0 | 2025-12 | Post-quantum encryption, credential vault |
| 1.2.0 | 2025-12 | Secrets scanning, certificate pinning |
| 1.1.0 | 2025-12 | Response validation, audit logging |
| 1.0.0 | 2025-12 | Initial security-hardened release |
