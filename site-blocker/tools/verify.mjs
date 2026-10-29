// Drives the unpacked extension in a real Chromium over CDP. Run: node tools/verify.mjs
// Set CHROMIUM to a Chromium binary; the default is Playwright's cached build.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  for (const dir of readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
    const bin = join(cache, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(bin)) return bin;
  }
  throw new Error('no Playwright Chromium found; set CHROMIUM');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const profile = mkdtempSync(join(tmpdir(), 'site-blocker-'));
const chrome = spawn(findChromium(), [
  `--user-data-dir=${profile}`,
  `--load-extension=${extensionDir}`,
  `--disable-extensions-except=${extensionDir}`,
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

async function connect() {
  const portFile = join(profile, 'DevToolsActivePort');
  await until(() => existsSync(portFile), 'DevToolsActivePort');
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
    else waiter.resolve(msg.result);
  };
  await new Promise((resolve) => { ws.onopen = resolve; });
}

const targets = async () => (await send('Target.getTargets')).targetInfos;

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function attach(targetId) {
  return (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
}

async function openTab(url) {
  const { targetId } = await send('Target.createTarget', { url });
  return targetId;
}

const tabUrl = async (targetId) => (await targets()).find((t) => t.targetId === targetId)?.url ?? '';

async function main() {
  await connect();

  const worker = await until(async () => {
    for (const t of (await targets()).filter((x) => x.type === 'service_worker' && x.url.endsWith('/background.js'))) {
      const session = await attach(t.targetId);
      const name = await evaluate(session, 'chrome.runtime.getManifest().name').catch(() => null);
      if (name === 'Site Blocker') return t;
    }
    return null;
  }, 'the Site Blocker service worker');
  const extensionId = new URL(worker.url).host;
  const blockedUrl = `chrome-extension://${extensionId}/blocked.html`;
  const sw = await attach(worker.targetId);
  const swEval = (expression) => evaluate(sw, expression);
  const setBlocking = (value) => swEval(`chrome.storage.local.set({ blocking: ${JSON.stringify(value)} })`);
  const ruleCount = () => swEval('chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length)');

  await until(async () => (await ruleCount()) === 1, 'the blocking rule after install');
  check('install adds exactly one dynamic rule', true);

  const rule = (await swEval('chrome.declarativeNetRequest.getDynamicRules()'))[0];
  check(
    'rule redirects main_frame requests for the three domains',
    JSON.stringify(rule.condition.requestDomains) === JSON.stringify(['x.com', 'twitter.com', 'linkedin.com'])
      && JSON.stringify(rule.condition.resourceTypes) === '["main_frame"]'
      && rule.action.redirect.extensionPath === '/blocked.html',
  );

  for (const url of ['https://x.com/', 'https://twitter.com/', 'https://www.linkedin.com/']) {
    const tab = await openTab(url);
    const landed = await until(async () => (await tabUrl(tab)) === blockedUrl && blockedUrl, `${url} to reach blocked.html`);
    check(`${url} lands on blocked.html`, landed === blockedUrl);
    await send('Target.closeTarget', { targetId: tab });
  }

  await setBlocking({ mode: 'off' });
  await until(async () => (await ruleCount()) === 0, 'rule removal after off');
  check('off removes the dynamic rule', true);

  const offTab = await openTab('https://x.com/');
  await sleep(4000);
  const offUrl = await tabUrl(offTab);
  check('x.com is not redirected while off', offUrl !== blockedUrl && offUrl !== 'about:blank', offUrl);

  await setBlocking({ mode: 'on' });
  const redirected = await until(async () => (await tabUrl(offTab)) === blockedUrl, 'open tab redirect after turning on', 20000);
  check('turning on redirects the already-open x.com tab', redirected);

  await setBlocking({ mode: 'off' });
  await until(async () => (await ruleCount()) === 0, 'rule removal before pause test');
  await send('Target.closeTarget', { targetId: offTab });
  const pauseTab = await openTab('https://x.com/');
  await sleep(3000);
  const pausedStart = await tabUrl(pauseTab);
  assert.notEqual(pausedStart, blockedUrl, 'x.com loads before the pause starts');

  const until3s = Date.now() + 3000;
  await setBlocking({ mode: 'paused', until: until3s });
  await until(async () => (await ruleCount()) === 0, 'rule removal while paused');
  const midPause = await tabUrl(pauseTab);
  check('x.com tab is left alone while the pause runs', midPause !== blockedUrl, midPause);

  await until(async () => (await tabUrl(pauseTab)) === blockedUrl, 'pause expiry to redirect the open tab', 90000);
  const lateMs = Date.now() - until3s;
  check('pause expiry redirects the already-open x.com tab', true, `${lateMs} ms after the deadline`);
  const afterState = await swEval('chrome.storage.local.get("blocking").then((r) => r.blocking)');
  check('expired pause is written back as {mode:"on"}', afterState?.mode === 'on', JSON.stringify(afterState));
  check('rule is back after the pause', (await ruleCount()) === 1);

  const popup = await openTab(`chrome-extension://${extensionId}/popup.html`);
  const popupSession = await attach(popup);
  const popupText = () => evaluate(popupSession, `document.getElementById('status').textContent + ' | ' + [...document.querySelectorAll('button')].map((b) => b.textContent).join(', ')`).catch(() => '');
  await until(async () => (await popupText()).startsWith('Blocking'), 'popup to render the on state');
  check('popup renders on', true, await popupText());

  await setBlocking({ mode: 'off' });
  await until(async () => (await popupText()).startsWith('Off'), 'popup to render the off state');
  check('popup renders off', true, await popupText());

  await setBlocking({ mode: 'paused', until: Date.now() + 252_000 });
  const pausedText = await until(async () => {
    const text = await popupText();
    return text.startsWith('Paused, resumes in 4:') && text;
  }, 'popup to render the paused state');
  check('popup renders paused with a countdown', true, pausedText);

  await evaluate(popupSession, `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Resume now').click()`);
  await until(async () => (await popupText()).startsWith('Blocking'), 'resume now to restore blocking');
  check('Resume now returns to blocking', true, await popupText());

  await evaluate(popupSession, `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Pause 5 min').click()`);
  const pausedByClick = await until(async () => (await popupText()).startsWith('Paused, resumes in') && (await popupText()), 'Pause 5 min to pause');
  const alarm = await until(() => swEval('chrome.alarms.get("resume").then((a) => a && a.scheduledTime)'), 'resume alarm');
  check('Pause 5 min pauses and schedules the resume alarm', alarm - Date.now() > 290_000, pausedByClick);

  await evaluate(popupSession, `[...document.querySelectorAll('button')].find((b) => b.textContent === 'Turn off').click()`);
  await until(async () => (await popupText()).startsWith('Off'), 'Turn off to switch off');
  await until(async () => !(await swEval('chrome.alarms.get("resume")')), 'resume alarm to clear');
  check('Turn off clears the resume alarm', true);
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  console.log(`FAIL  ${error.message}`);
} finally {
  ws?.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

const failed = failure !== undefined || results.includes(false);
console.log(failed ? '\nVERIFY FAILED' : `\nVERIFY OK (${results.length} checks)`);
process.exit(failed ? 1 : 0);
