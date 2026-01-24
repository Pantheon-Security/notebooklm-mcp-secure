# MCP Directory Listings Tracker

Track where `@pan-sec/notebooklm-mcp` is listed and submission progress.

**Last Updated:** 2026-01-24

---

## Current Listings

| Directory | Status | URL | Notes |
|-----------|--------|-----|-------|
| [Glama.ai](https://glama.ai/mcp/servers) | ✅ Listed | [View Listing](https://glama.ai/mcp/servers/@Pantheon-Security/notebooklm-mcp-secure) | Auto-indexed from GitHub |
| [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | ⚠️ Partial | chrome-mcp-secure only | Need to add notebooklm-mcp-secure |

---

## Pending Submissions

### Priority 1: High Impact

#### Official MCP Registry
- **URL:** https://registry.modelcontextprotocol.io/
- **Submit via:** PR to https://github.com/modelcontextprotocol/registry
- **Status:** ⏳ Not submitted
- **Notes:** Official registry backed by Anthropic, GitHub, Microsoft. High visibility.
- **Submission Guide:** https://registry.modelcontextprotocol.io/docs

#### awesome-mcp-servers (Add notebooklm)
- **URL:** https://github.com/punkpeye/awesome-mcp-servers
- **Submit via:** Pull Request
- **Status:** ⏳ Not submitted
- **Notes:** Already have chrome-mcp-secure listed. Add notebooklm under "Knowledge & Memory" section.
- **Entry to add:**
```markdown
- [notebooklm-mcp-secure](https://github.com/Pantheon-Security/notebooklm-mcp-secure) - Security-hardened NotebookLM MCP with post-quantum encryption, GDPR/SOC2 compliance, and 14 security layers. Query Google's Gemini-grounded research from Claude/AI agents.
```

#### PulseMCP
- **URL:** https://www.pulsemcp.com/servers
- **Size:** 7,900+ servers (largest directory)
- **Submit via:** Auto-indexed from npm/GitHub or manual submission
- **Status:** ⏳ Not submitted
- **Notes:** Check if auto-indexed. If not, contact for listing.

### Priority 2: Good Visibility

#### MCP.so
- **URL:** https://mcp.so/
- **Submit via:** https://github.com/chatmcp/mcpso
- **Status:** ⏳ Not submitted
- **Notes:** Popular directory with call ranking leaderboard.

#### MCPServers.org
- **URL:** https://mcpservers.org/
- **Submit via:** Unknown - check site
- **Status:** ⏳ Not submitted
- **Notes:** Has original notebooklm-mcp, not secure fork.

#### Smithery.ai
- **URL:** https://smithery.ai/
- **Submit via:** Smithery CLI or web submission
- **Status:** ⏳ Not submitted
- **CLI:** `npx @anthropic-ai/mcp-registry add`

#### mcp-get.com
- **URL:** https://mcp-get.com/
- **Submit via:** Package registry submission
- **Status:** ⏳ Not submitted
- **Notes:** Package manager style directory.

### Priority 3: Niche/Emerging

#### Azure API Center
- **URL:** https://learn.microsoft.com/en-us/azure/api-center/register-discover-mcp-server
- **Submit via:** Azure portal
- **Status:** ⏳ Not applicable yet
- **Notes:** Enterprise Azure integration. Consider for enterprise customers.

#### awesome-devops-mcp-servers
- **URL:** https://github.com/rohitg00/awesome-devops-mcp-servers
- **Submit via:** Pull Request
- **Status:** ⏳ Not submitted
- **Notes:** DevOps focused list. May not be relevant.

---

## Submission Templates

### GitHub PR Template (awesome lists)

```markdown
## Add notebooklm-mcp-secure

### Description
Adding security-hardened NotebookLM MCP server to the Knowledge & Memory section.

### Server Details
- **Name:** notebooklm-mcp-secure
- **GitHub:** https://github.com/Pantheon-Security/notebooklm-mcp-secure
- **npm:** @pan-sec/notebooklm-mcp
- **Category:** Knowledge & Memory / Research

### Features
- Query Google NotebookLM from Claude/AI agents
- Post-quantum encryption (ML-KEM-768 + ChaCha20-Poly1305)
- GDPR, SOC2, CSSF compliance tools
- 14 security hardening layers
- Gemini Deep Research API integration

### Checklist
- [x] Server is open source
- [x] Server is actively maintained
- [x] Server has documentation
- [x] Server is published on npm
```

### Registry JSON Template

```json
{
  "name": "@pan-sec/notebooklm-mcp",
  "description": "Security-hardened MCP server for NotebookLM with post-quantum encryption and enterprise compliance",
  "repository": "https://github.com/Pantheon-Security/notebooklm-mcp-secure",
  "homepage": "https://github.com/Pantheon-Security/notebooklm-mcp-secure#readme",
  "keywords": [
    "mcp",
    "notebooklm",
    "gemini",
    "security",
    "post-quantum",
    "gdpr",
    "soc2",
    "compliance",
    "claude"
  ],
  "categories": ["research", "knowledge", "security"],
  "author": "Pantheon Security",
  "license": "MIT"
}
```

---

## Tracking Progress

### Completed
- [x] Glama.ai - Auto-listed

### In Progress
- [ ] awesome-mcp-servers PR
- [ ] Official MCP Registry submission
- [ ] PulseMCP check/submission

### Backlog
- [ ] MCP.so
- [ ] MCPServers.org
- [ ] Smithery.ai
- [ ] mcp-get.com

---

## Tips for Submissions

1. **Timing:** Submit after a notable release (like security updates)
2. **Description:** Lead with security angle - differentiator from original
3. **Keywords:** Include "security", "enterprise", "compliance", "post-quantum"
4. **Screenshots:** Consider adding demo GIFs to README for visual directories
5. **Stars:** 14 stars shows traction - mention in submissions

---

## Related Projects to Cross-List

Also submit these Pantheon Security MCP servers:

| Project | Directories Listed |
|---------|-------------------|
| [chrome-mcp-secure](https://github.com/Pantheon-Security/chrome-mcp-secure) | awesome-mcp-servers ✅ |
| [notebooklm-mcp-secure](https://github.com/Pantheon-Security/notebooklm-mcp-secure) | Glama ✅ |

---

*This document tracks MCP directory listings for visibility and discoverability.*
