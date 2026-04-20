import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "nlmcp-vitest-"));

process.env.NLMCP_AUDIT_DIR = path.join(TEST_ROOT, "audit");
process.env.NLMCP_COMPLIANCE_DIR = path.join(TEST_ROOT, "compliance");

fs.mkdirSync(process.env.NLMCP_AUDIT_DIR, { recursive: true });
fs.mkdirSync(process.env.NLMCP_COMPLIANCE_DIR, { recursive: true });
