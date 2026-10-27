// Shared logic for the content script, the service worker, the popup, and the tests.
// Everything here is pure: no chrome.* calls and no DOM access.

const WF = (() => {
  const DEFAULTS = {
    apiKey: '',
    model: 'openai/gpt-oss-20b',
    workDescription:
      'Applied AI and the business around it: building LLM apps, agents, RAG, evals and AI tooling; ' +
      'AI consulting and selling AI to enterprises; AI startups; AI governance and regulation, ' +
      'especially in financial services.',
    allowSubs: [],
    blockSubs: [],
  };

  const OVERRIDE_MINUTES = 5;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX = 500;
  const LOG_MAX = 50;

  const FEED_SEGMENTS = new Set(['best', 'hot', 'new', 'top', 'rising', 'controversial']);
  const FEED_SUBS = new Set(['popular', 'all', 'mod', 'friends']);
  const UTILITY_SEGMENTS = new Set([
    'settings', 'message', 'messages', 'chat', 'submit', 'notifications', 'prefs',
    'login', 'register', 'account', 'password', 'premium', 'coins', 'policies', 'help',
  ]);

  // Maps a Reddit URL to the unit that gets judged. Pages with the same key share one verdict.
  function routeFor(href) {
    const url = new URL(href);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const first = (parts[0] || '').toLowerCase();

    if (parts.length === 0 || FEED_SEGMENTS.has(first)) return { kind: 'feed', key: 'feed:home' };
    if (UTILITY_SEGMENTS.has(first)) return { kind: 'utility', key: `utility:${first}` };

    if (first === 'r' && parts[1]) {
      const sub = parts[1].toLowerCase();
      if (FEED_SUBS.has(sub)) return { kind: 'feed', key: `feed:${sub}` };
      if (sub.includes('+')) return { kind: 'feed', key: 'feed:multi' };
      if ((parts[2] || '').toLowerCase() === 'comments' && parts[3]) {
        const postId = parts[3].toLowerCase();
        return { kind: 'post', key: `post:${postId}`, subreddit: sub, postId };
      }
      return { kind: 'subreddit', key: `sub:${sub}`, subreddit: sub };
    }

    if (first === 'comments' && parts[1]) {
      const postId = parts[1].toLowerCase();
      return { kind: 'post', key: `post:${postId}`, subreddit: '', postId };
    }

    if ((first === 'user' || first === 'u') && parts[1]) {
      return { kind: 'listing', key: `user:${parts[1].toLowerCase()}` };
    }

    if (first === 'search') {
      const query = (url.searchParams.get('q') || '').trim();
      return { kind: 'listing', key: `search:${query.toLowerCase()}`, query };
    }

    return { kind: 'listing', key: `path:${url.pathname.toLowerCase()}` };
  }

  // Decisions that need no model: feeds, the user's subreddit lists, and earlier overrides.
  function quickDecision(route, settings) {
    if (route.kind === 'utility') return { decision: 'allow', reason: 'Reddit settings or messages', source: 'rule' };
    if (route.kind === 'feed') return { decision: 'block', reason: 'Feeds are always blocked', source: 'rule' };
    const sub = route.subreddit;
    if (sub && settings.blockSubs.includes(sub)) {
      return { decision: 'block', reason: `r/${sub} is on your block list`, source: 'list' };
    }
    if (sub && settings.allowSubs.includes(sub)) {
      return { decision: 'allow', reason: `r/${sub} is on your allow list`, source: 'list' };
    }
    return null;
  }

  function normalizeSubs(text) {
    return [...new Set(
      String(text || '')
        .split(/[\s,]+/)
        .map((s) => s.replace(/^\/?r\//i, '').trim().toLowerCase())
        .filter(Boolean),
    )];
  }

  // ---- Groq prompt ----

  function truncate(text, max) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  function buildMessages(route, page, workDescription) {
    const system =
      'You are a strict focus filter for someone who is at work. Their work: ' + workDescription + '\n\n' +
      'Decide whether the Reddit page below is substantively useful for that work. ' +
      'Relevant: technical, business or industry content a professional in that field would read on the job. ' +
      'Not relevant: memes, entertainment, general news, politics, personal stories, pets, sports, gaming, ' +
      'unrelated hobbies, and posts that only mention AI in passing. ' +
      'For a listing of posts, judge whether the listing as a whole is mostly work-relevant.\n\n' +
      'Reply with JSON only: {"relevant": true or false, "reason": "<at most 15 words>"}';

    const input = { pageType: route.kind };
    if (route.subreddit || page.subreddit) input.subreddit = `r/${route.subreddit || page.subreddit}`;
    if (route.query) input.searchQuery = route.query;
    if (page.title) input.title = truncate(page.title, 300);
    if (page.body) input.body = truncate(page.body, 1500);
    if (page.titles && page.titles.length) input.postTitles = page.titles.slice(0, 15).map((t) => truncate(t, 200));

    return [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(input) },
    ];
  }

  // gpt-oss models reason before answering: keep that short and out of the reply.
  function groqRequestBody(route, page, settings) {
    const body = {
      model: settings.model,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages: buildMessages(route, page, settings.workDescription),
    };
    if (settings.model.startsWith('openai/gpt-oss')) {
      Object.assign(body, { max_tokens: 600, reasoning_effort: 'low', include_reasoning: false });
    }
    return body;
  }

  function parseModelReply(text) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.relevant !== 'boolean') return null;
      return { relevant: parsed.relevant, reason: truncate(parsed.reason || '', 160) };
    } catch {
      return null;
    }
  }

  // ---- Keyword backup, used when Groq is unavailable ----

  const KEYWORDS = [
    'AI', 'ML', 'LLM', 'GPT', 'RAG', 'NLP', 'MLOps', 'genAI',
    'machine learning', 'artificial intelligence', 'deep learning', 'neural network',
    'language model', 'transformer', 'fine tuning', 'embedding', 'inference',
    'prompt engineering', 'vector database', 'AI agent', 'agentic',
    'OpenAI', 'Anthropic', 'Claude', 'ChatGPT', 'Gemini', 'Llama', 'Mistral', 'Hugging Face',
    'LangChain', 'PyTorch', 'TensorFlow', 'AI governance', 'AI regulation', 'EU AI Act',
  ];

  const KEYWORD_SUBS = new Set([
    'machinelearning', 'localllama', 'artificial', 'openai', 'claudeai', 'chatgptpro',
    'learnmachinelearning', 'datascience', 'mlops', 'langchain', 'ollama', 'llmdevs',
    'deeplearning', 'mlquestions', 'promptengineering', 'aiagents', 'singularity',
  ]);

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Short all-caps acronyms match case-sensitively so "ai" or "Ml" in ordinary words don't count.
  const KEYWORD_PATTERNS = KEYWORDS.map((kw) => {
    const caseSensitive = kw.length <= 5 && kw === kw.toUpperCase();
    const body = escapeRegex(kw).replace(/ /g, '[\\s-]');
    return new RegExp(`(?<![\\w])${body}s?(?![\\w])`, caseSensitive ? 'g' : 'gi');
  });

  const NEGATION = /\b(not|no|non|without|zero)[\s-]+$/i;

  // Counts keyword hits, skipping negated ones like "NOT AI" or "no AI-generated".
  function keywordHits(text) {
    const str = String(text || '');
    let hits = 0;
    for (const pattern of KEYWORD_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(str))) {
        if (!NEGATION.test(str.slice(Math.max(0, m.index - 12), m.index))) hits++;
      }
    }
    return hits;
  }

  function keywordVerdict(route, page) {
    const sub = route.subreddit || page.subreddit || '';
    if (KEYWORD_SUBS.has(sub)) return { relevant: true, reason: `r/${sub} is an AI subreddit` };

    if (route.kind === 'post') {
      const hits = keywordHits(page.title) + keywordHits(page.body);
      return hits > 0
        ? { relevant: true, reason: 'Post mentions AI topics' }
        : { relevant: false, reason: 'No AI topics in the post' };
    }

    const titles = page.titles || [];
    const matching = titles.filter((t) => keywordHits(t) > 0).length;
    const queryHit = route.query && keywordHits(route.query) > 0;
    if (queryHit || (titles.length > 0 && matching / titles.length >= 0.5)) {
      return { relevant: true, reason: `${matching} of ${titles.length} posts mention AI topics` };
    }
    return { relevant: false, reason: `Only ${matching} of ${titles.length} posts mention AI topics` };
  }

  // ---- Cache ----

  function cacheGet(cache, key, now) {
    const entry = cache[key];
    return entry && now - entry.ts < CACHE_TTL_MS ? entry : null;
  }

  function cachePut(cache, key, value, now) {
    cache[key] = { ...value, ts: now };
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => cache[a].ts - cache[b].ts);
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    return cache;
  }

  function pushLog(log, entry) {
    return [entry, ...(log || [])].slice(0, LOG_MAX);
  }

  return {
    DEFAULTS, OVERRIDE_MINUTES,
    routeFor, quickDecision, normalizeSubs,
    buildMessages, groqRequestBody, parseModelReply,
    keywordHits, keywordVerdict,
    cacheGet, cachePut, pushLog,
  };
})();

if (typeof module !== 'undefined') module.exports = WF;
