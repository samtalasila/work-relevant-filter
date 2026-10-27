// Service worker: decides allow/block for each page, calling Groq and falling back to keywords.
importScripts('lib.js');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 6000;

async function getSettings() {
  return { ...WF.DEFAULTS, ...(await chrome.storage.local.get(Object.keys(WF.DEFAULTS))) };
}

async function askGroq(route, page, settings) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(WF.groqRequestBody(route, page, settings)),
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const verdict = WF.parseModelReply(data.choices?.[0]?.message?.content);
    if (!verdict) throw new Error('Groq reply was not valid JSON');
    return verdict;
  } finally {
    clearTimeout(timer);
  }
}

// Decisions that need no page content: unlocks, rules, subreddit lists, and cached verdicts.
// Returns null when the page has to be judged.
async function precheck(route) {
  const settings = await getSettings();
  const now = Date.now();
  const { overrides = {}, cache = {} } = await chrome.storage.local.get(['overrides', 'cache']);
  if (overrides[route.key] > now) {
    return { decision: 'allow', reason: 'You unlocked this page', source: 'override', until: overrides[route.key] };
  }

  const quick = WF.quickDecision(route, settings);
  if (quick) return quick;

  const cached = WF.cacheGet(cache, route.key, now);
  if (cached) return { decision: cached.relevant ? 'allow' : 'block', reason: cached.reason, source: 'cache' };
  return null;
}

async function classify(route, page) {
  // Short /comments/<id> links only reveal the subreddit once the post has loaded.
  if (!route.subreddit && page.subreddit) {
    route = { ...route, subreddit: page.subreddit };
    const known = await precheck(route);
    if (known) return known;
  }

  const settings = await getSettings();
  const now = Date.now();
  const { cache = {} } = await chrome.storage.local.get('cache');
  let verdict;
  let source = 'groq';
  let error = '';
  if (settings.apiKey) {
    try {
      verdict = await askGroq(route, page, settings);
      await chrome.storage.local.set({ cache: WF.cachePut(cache, route.key, verdict, now) });
    } catch (err) {
      error = String(err.message || err);
    }
  } else {
    error = 'No Groq API key set';
  }
  if (!verdict) {
    // Keyword verdicts are not cached, so the page is re-judged by Groq once it is reachable.
    verdict = WF.keywordVerdict(route, page);
    source = 'keywords';
  }

  const result = { decision: verdict.relevant ? 'allow' : 'block', reason: verdict.reason, source };
  const { verdictLog } = await chrome.storage.local.get('verdictLog');
  await chrome.storage.local.set({
    verdictLog: WF.pushLog(verdictLog, {
      ts: now, key: route.key, title: page.title || route.query || route.key, ...result, error,
    }),
  });
  return result;
}

async function unlock(route, url, reason) {
  const now = Date.now();
  const { overrides = {}, overrideLog } = await chrome.storage.local.get(['overrides', 'overrideLog']);
  for (const [key, until] of Object.entries(overrides)) if (until <= now) delete overrides[key];
  overrides[route.key] = now + WF.OVERRIDE_MINUTES * 60 * 1000;
  await chrome.storage.local.set({
    overrides,
    overrideLog: WF.pushLog(overrideLog, { ts: now, key: route.key, url, reason }),
  });
}

// Runs one relevant and one irrelevant sample through Groq with the popup's unsaved settings.
async function testModel(settings) {
  const samples = [
    [WF.routeFor('https://www.reddit.com/r/LocalLLaMA/comments/test1/x/'),
      { title: 'How we cut RAG eval costs 60% with a small judge model', body: 'Benchmarks and prompts inside.' }, true],
    [WF.routeFor('https://www.reddit.com/r/aww/comments/test2/x/'),
      { title: 'My cat learned to open the fridge', body: '' }, false],
  ];
  const results = [];
  for (const [route, page, expected] of samples) {
    const start = Date.now();
    const verdict = await askGroq(route, page, { ...WF.DEFAULTS, ...settings });
    results.push({ title: page.title, ...verdict, expected, ms: Date.now() - start });
  }
  return { ok: true, results };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'precheck') {
    precheck(msg.route).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === 'classify') {
    classify(msg.route, msg.page).then(sendResponse, (err) =>
      sendResponse({ decision: 'block', reason: `Filter error: ${err.message}`, source: 'error' }));
    return true;
  }
  if (msg.type === 'test') {
    testModel(msg.settings).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'unlock') {
    unlock(msg.route, msg.url, msg.reason).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
