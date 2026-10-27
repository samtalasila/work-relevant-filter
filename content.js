// Content script: covers each Reddit page until the service worker says it is work-relevant.
// Runs at document_start so nothing distracting renders before the cover is up.

const POLL_MS = 250;
const EXTRACT_TIMEOUT_MS = 4000;
const LISTING_SETTLE_MS = 1200;
const MIN_REASON_CHARS = 10;

let currentKey = null;
let checkSeq = 0;
let relockTimer = null;
let state = 'idle'; // 'checking' | 'blocked' | 'allowed' | 'idle'

// ---- Overlay ----

const host = document.createElement('div');
host.id = 'work-filter-overlay';
host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;';
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `
  <style>
    :host { all: initial; }
    .screen {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: #0f1115; color: #e8eaed; padding: 16px;
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card { max-width: 480px; width: 100%; }
    h1 { font-size: 22px; margin: 0 0 8px; font-weight: 600; }
    .reason { color: #b8bcc4; margin: 0 0 4px; }
    .source { color: #7d828c; font-size: 13px; margin: 0 0 24px; }
    label { display: block; font-size: 13px; color: #b8bcc4; margin-bottom: 6px; }
    textarea {
      width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical; padding: 10px;
      background: #1a1d23; color: #e8eaed; border: 1px solid #2f343d; border-radius: 8px; font: inherit;
    }
    .row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    button {
      font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid #2f343d;
      background: #1a1d23; color: #e8eaed; cursor: pointer;
    }
    button.primary { background: #3b6fd8; border-color: #3b6fd8; }
    button:disabled { opacity: 0.4; cursor: default; }
    .spinner {
      width: 28px; height: 28px; border: 3px solid #2f343d; border-top-color: #7d9ff0;
      border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .checking { text-align: center; color: #7d828c; }
  </style>
  <div class="screen">
    <div class="card checking" id="checking"><div class="spinner"></div>Checking whether this is work…</div>
    <div class="card" id="blocked" hidden>
      <h1>Not work-relevant</h1>
      <p class="reason" id="reason"></p>
      <p class="source" id="source"></p>
      <label for="why">Need it anyway? Say why to unlock this page for 5 minutes.</label>
      <textarea id="why" placeholder="e.g. Comparing RAG eval approaches for the client demo"></textarea>
      <div class="row">
        <button class="primary" id="unlock" disabled>Unlock for 5 minutes</button>
        <button id="back">Go back</button>
      </div>
    </div>
  </div>`;

const $ = (id) => shadow.getElementById(id);
const SOURCE_LABELS = {
  groq: 'Judged by Groq',
  cache: 'Judged earlier by Groq',
  keywords: 'Judged by keyword backup (Groq unavailable)',
  list: 'From your subreddit lists',
  rule: 'Built-in rule',
  error: '',
};

// Keep Reddit's own keyboard shortcuts from firing while typing in the overlay.
for (const type of ['keydown', 'keyup', 'keypress']) {
  host.addEventListener(type, (e) => e.stopPropagation());
}

$('why').addEventListener('input', () => {
  $('unlock').disabled = $('why').value.trim().length < MIN_REASON_CHARS;
});
$('back').addEventListener('click', () => history.back());
$('unlock').addEventListener('click', async () => {
  const route = WF.routeFor(location.href);
  await chrome.runtime.sendMessage({ type: 'unlock', route, url: location.href, reason: $('why').value.trim() });
  $('why').value = '';
  $('unlock').disabled = true;
  recheck();
});

function show(next, verdict) {
  state = next;
  if (next === 'allowed' || next === 'idle') {
    host.style.display = 'none';
    document.documentElement.style.removeProperty('overflow');
    return;
  }
  host.style.display = 'block';
  document.documentElement.style.setProperty('overflow', 'hidden', 'important');
  $('checking').hidden = next !== 'checking';
  $('blocked').hidden = next !== 'blocked';
  if (next === 'blocked') {
    $('reason').textContent = verdict.reason;
    $('source').textContent = SOURCE_LABELS[verdict.source] ?? '';
  }
}

// ---- Page extraction ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// Organic post titles only: shreddit-ad-post and old Reddit's .promoted are never read.
function listingTitles(subreddit) {
  const titles = [];
  for (const post of document.querySelectorAll('shreddit-post')) {
    if (subreddit && (post.getAttribute('subreddit-name') || '').toLowerCase() !== subreddit) continue;
    const title = post.getAttribute('post-title');
    if (title) titles.push(title);
  }
  for (const a of document.querySelectorAll('#siteTable .thing.link:not(.promoted) a.title')) titles.push(text(a));
  return titles;
}

function findPost(postId) {
  const post = document.querySelector(`shreddit-post[id="t3_${postId}"]`);
  if (post) {
    return {
      title: post.getAttribute('post-title') || '',
      body: text(post.querySelector('[slot="text-body"]')),
      subreddit: (post.getAttribute('subreddit-name') || '').toLowerCase(),
    };
  }
  const old = document.querySelector(`.thing.link[data-fullname="t3_${postId}"]`);
  if (old) {
    return {
      title: text(old.querySelector('a.title')),
      body: text(old.querySelector('.expando .md')),
      subreddit: (old.getAttribute('data-subreddit') || '').toLowerCase(),
    };
  }
  return null;
}

// Waits for the new page's content, since Reddit renders it after the URL changes.
async function extract(route, seq) {
  const start = Date.now();
  while (Date.now() - start < EXTRACT_TIMEOUT_MS) {
    if (seq !== checkSeq) return null;
    if (route.kind === 'post') {
      const post = findPost(route.postId);
      if (post && post.title) return post;
    } else if (Date.now() - start >= LISTING_SETTLE_MS) {
      const titles = listingTitles(route.kind === 'subreddit' ? route.subreddit : '');
      if (titles.length >= 8) return { titles };
    }
    await sleep(150);
  }
  if (route.kind === 'post') return { title: document.title.replace(/ : r\/\w+$/i, '') };
  return { titles: listingTitles(route.kind === 'subreddit' ? route.subreddit : '') };
}

// ---- Checking ----

async function recheck() {
  const seq = ++checkSeq;
  const route = WF.routeFor(location.href);
  currentKey = route.key;
  clearTimeout(relockTimer);

  if (route.kind === 'utility') return show('idle');
  show('checking');

  let verdict;
  try {
    // Only wait for page content when the decision actually needs it.
    verdict = await chrome.runtime.sendMessage({ type: 'precheck', route });
    if (seq !== checkSeq) return;
    if (!verdict) {
      const page = await extract(route, seq);
      if (seq !== checkSeq || !page) return;
      verdict = await chrome.runtime.sendMessage({ type: 'classify', route, page });
    }
  } catch (err) {
    verdict = { decision: 'block', reason: `Filter error: ${err.message}`, source: 'error' };
  }
  if (seq !== checkSeq) return;
  show(verdict.decision === 'allow' ? 'allowed' : 'blocked', verdict);
  if (verdict.until) relockTimer = setTimeout(recheck, verdict.until - Date.now() + 500);
}

function tick() {
  if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  if (WF.routeFor(location.href).key !== currentKey) recheck();
  if (state === 'blocked' || state === 'checking') {
    for (const media of document.querySelectorAll('video, audio')) if (!media.paused) media.pause();
  }
}

if (window.navigation) window.navigation.addEventListener('navigatesuccess', tick);
setInterval(tick, POLL_MS);
tick();
