/**
 * Standalone auth script — bypasses MCP protocol entirely.
 * Opens Chrome visibly, waits for login, saves state.json.pqenc.
 */
import { chromium } from 'patchright';
import { mkdir, writeFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

const BROWSER_STATE_DIR = path.join(os.homedir(), '.local/share/notebooklm-mcp/browser_state');
const CHROME_PROFILE_DIR = path.join(os.homedir(), '.local/share/notebooklm-mcp/chrome_profile');
const STATE_PATH = path.join(BROWSER_STATE_DIR, 'state.json');
const AUTH_URL = 'https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fnotebooklm.google.com%2F';

await mkdir(BROWSER_STATE_DIR, { recursive: true });
await mkdir(CHROME_PROFILE_DIR, { recursive: true });

console.log('');
console.log('=== NotebookLM Auth Setup ===');
console.log('Opening Chrome...');
console.log('');

const context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
  headless: false,
  channel: 'chrome',
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--ozone-platform=x11',
  ],
});

const page = context.pages()[0] ?? await context.newPage();
await page.goto(AUTH_URL, { timeout: 60000 });

console.log('Waiting for you to reach NotebookLM... (up to 10 minutes)');

let saved = false;

for (let i = 0; i < 600; i++) {
  await new Promise(r => setTimeout(r, 1000));

  let url = '';
  try { url = page.url(); } catch { continue; }

  // Match with or without trailing slash
  if (url.startsWith('https://notebooklm.google.com')) {
    console.log(`✅ NotebookLM detected (${url})`);
    console.log('   Waiting 3s for page to settle...');
    await page.waitForTimeout(3000);

    // --- Extract storage state ---
    console.log('   Extracting cookies and storage...');
    let storageState;
    try {
      storageState = await context.storageState();
      console.log(`   Got ${storageState.cookies?.length ?? 0} cookies`);
    } catch (e) {
      console.error('❌ Failed to extract storage state:', e.message);
      break;
    }

    // --- Try encrypted save first ---
    let encSaved = false;
    try {
      const { getSecureStorage } = await import('./dist/utils/crypto.js');
      const secureStorage = getSecureStorage();
      await secureStorage.save(STATE_PATH, storageState);
      encSaved = true;
      console.log('✅ Saved encrypted state.json.pqenc');
    } catch (e) {
      console.warn('   Encrypted save failed:', e.message);
      console.warn('   Falling back to plain JSON...');
    }

    // --- Plain JSON fallback (MCP server accepts this too) ---
    if (!encSaved) {
      try {
        await writeFile(STATE_PATH, JSON.stringify(storageState, null, 2));
        console.log('✅ Saved state.json (unencrypted)');
        encSaved = true;
      } catch (e) {
        console.error('❌ Plain JSON save also failed:', e.message);
        console.error('   State dir:', BROWSER_STATE_DIR);
        break;
      }
    }

    // --- Verify file exists ---
    try {
      const s = await stat(STATE_PATH + '.pqenc').catch(() => stat(STATE_PATH));
      console.log(`✅ Verified file on disk (${Math.round(s.size / 1024)}KB)`);
    } catch {
      console.warn('   Could not verify file — check directory manually');
    }

    saved = true;
    console.log('');
    console.log('✅ Auth complete! Open your node1/node2/node3 sessions now.');
    console.log('   (This window will stay open — close it with Ctrl+C when ready)');

    // Keep alive so user can see it worked
    await new Promise(r => setTimeout(r, 60000));
    break;
  }
}

if (!saved) {
  console.log('❌ Timed out or save failed.');
}

await context.close().catch(() => {});
