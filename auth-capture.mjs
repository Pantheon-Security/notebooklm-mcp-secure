/**
 * Capture an already-authenticated session straight out of the persistent
 * Chrome profile.
 *
 * auth-now.mjs waits for a tab to REACH notebooklm.google.com before saving.
 * That detection is fragile — the sign-in flow lands in whichever tab it likes,
 * and a consent/challenge interstitial keeps the URL on accounts.google.com —
 * so a perfectly good login can sit there undetected until the script times
 * out. The cookies are in the profile either way, so read them from there.
 *
 * Prints a diagnostic of every open tab and of which auth cookies were found,
 * so a FAILED capture is obvious rather than saved as a useless state file.
 */
import { chromium } from 'patchright';
import { mkdir, writeFile, stat } from 'fs/promises';
import path from 'path';
import os from 'os';

const BROWSER_STATE_DIR = path.join(os.homedir(), '.local/share/notebooklm-mcp/browser_state');
const CHROME_PROFILE_DIR = path.join(os.homedir(), '.local/share/notebooklm-mcp/chrome_profile');
const STATE_PATH = path.join(BROWSER_STATE_DIR, 'state.json');

await mkdir(BROWSER_STATE_DIR, { recursive: true });

console.log('=== Capture session from existing Chrome profile ===');

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

console.log('Navigating to NotebookLM to refresh the session...');
try {
  await page.goto('https://notebooklm.google.com/', { timeout: 45000, waitUntil: 'domcontentloaded' });
} catch (e) {
  console.warn('   Navigation warning:', e.message.split('\n')[0]);
}

await page.waitForTimeout(6000);

console.log('');
console.log('--- open tabs ---');
for (const p of context.pages()) {
  let u = '(unreadable)';
  try { u = p.url(); } catch { /* ignore */ }
  console.log('   ', u);
}
console.log('');

const storageState = await context.storageState();
const cookies = storageState.cookies ?? [];
console.log(`Total cookies in profile: ${cookies.length}`);

const domains = [...new Set(cookies.map(c => c.domain))];
const googleAuth = cookies.filter(c => ['SID', 'SSID', 'HSID', 'APISID', 'SAPISID', '__Secure-1PSID'].includes(c.name));
const nlmDomain = domains.filter(d => d.includes('notebooklm') || d.includes('google'));

console.log(`Google auth cookies found: ${googleAuth.length ? googleAuth.map(c => c.name).join(', ') : 'NONE'}`);
console.log(`Google/NotebookLM domains: ${nlmDomain.slice(0, 8).join(', ') || 'none'}`);
console.log('');

if (googleAuth.length === 0) {
  console.log('❌ No Google session cookies in this profile — you are NOT logged in.');
  console.log('   Nothing saved. Log in in the Chrome window that just opened, then re-run.');
  console.log('   (leaving the window open for 5 minutes so you can log in)');
  await page.waitForTimeout(300000);
  await context.close().catch(() => {});
  process.exit(1);
}

let encSaved = false;
try {
  const { getSecureStorage } = await import('./dist/utils/crypto.js');
  const secureStorage = getSecureStorage();
  await secureStorage.save(STATE_PATH, storageState);
  encSaved = true;
  console.log('✅ Saved encrypted state.json.pqenc');
} catch (e) {
  console.warn('   Encrypted save failed:', e.message);
}

if (!encSaved) {
  console.error('❌ Encrypted save failed and NO plaintext fallback was written.');
  console.error('   A Google session on disk in the clear is not an acceptable default —');
  console.error('   fix the crypto path (is dist/ built?) and re-run.');
  await context.close().catch(() => {});
  process.exit(2);
}

try {
  const s = await stat(STATE_PATH + '.pqenc');
  console.log(`✅ Verified on disk: state.json.pqenc (${Math.round(s.size / 1024)}KB)`);
} catch {
  console.warn('   Could not stat the saved file — check manually.');
}

console.log('');
console.log('✅ Capture complete. Closing Chrome.');
await context.close().catch(() => {});
