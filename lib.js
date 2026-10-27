// Shared logic for the content script, the service worker, the popup, and the tests.
// Everything here is pure: no chrome.* calls and no DOM access.

const WF = (() => {
  const PERSONAS = [
    {
      id: 'software-engineer',
      label: 'Software engineer',
      workDescription:
        'Software engineering: designing, building, testing and operating backend and frontend systems; ' +
        'programming languages, architecture, databases, distributed systems, DevOps and developer tooling; ' +
        'code review, engineering practices, and engineering careers and teams.',
      keywords: [
        'software engineering', 'software architecture', 'system design', 'code review', 'unit test',
        'refactoring', 'technical debt', 'microservices', 'distributed systems', 'database',
        'open source', 'programming language', 'backend', 'frontend', 'full stack',
        'DevOps', 'CI/CD', 'API', 'SQL', 'AWS', 'Git', 'GitHub', 'Docker', 'Kubernetes',
        'PostgreSQL', 'TypeScript', 'JavaScript', 'Python', 'Rust', 'Golang',
        'r/programming', 'r/ExperiencedDevs', 'r/softwarearchitecture', 'r/webdev', 'r/devops',
        'r/cscareerquestions', 'r/rust', 'r/golang', 'r/node', 'r/reactjs',
      ],
      sample: {
        subreddit: 'ExperiencedDevs',
        title: 'How we migrated a monolith to microservices without downtime',
        body: 'Lessons on database cutovers, API versioning and rollback plans from a two-year migration.',
      },
    },
    {
      id: 'ai-consultant',
      label: 'AI consultant',
      workDescription:
        'Applied AI and the business around it: building LLM apps, agents, RAG, evals and AI tooling; ' +
        'AI consulting and selling AI to enterprises; AI startups; AI governance and regulation, ' +
        'especially in financial services.',
      keywords: [
        'AI', 'ML', 'LLM', 'GPT', 'RAG', 'NLP', 'MLOps', 'genAI',
        'machine learning', 'artificial intelligence', 'deep learning', 'neural network',
        'language model', 'transformer', 'fine tuning', 'embedding', 'inference',
        'prompt engineering', 'vector database', 'AI agent', 'agentic',
        'OpenAI', 'Anthropic', 'Claude', 'ChatGPT', 'Gemini', 'Llama', 'Mistral', 'Hugging Face',
        'LangChain', 'PyTorch', 'TensorFlow', 'AI governance', 'AI regulation', 'EU AI Act',
        'r/machinelearning', 'r/localllama', 'r/artificial', 'r/openai', 'r/claudeai', 'r/chatgptpro',
        'r/learnmachinelearning', 'r/datascience', 'r/mlops', 'r/langchain', 'r/ollama', 'r/llmdevs',
        'r/deeplearning', 'r/mlquestions', 'r/promptengineering', 'r/aiagents', 'r/singularity',
      ],
      sample: {
        subreddit: 'LocalLLaMA',
        title: 'How we cut RAG eval costs 60% with a small judge model',
        body: 'Benchmarks and prompts inside.',
      },
    },
    {
      id: 'corporate-lawyer',
      label: 'Corporate lawyer',
      workDescription:
        'Corporate law: mergers and acquisitions, securities and capital markets, commercial contracts, ' +
        'corporate governance and regulatory compliance; running a law practice or in-house legal team; ' +
        'legal technology, and developments in case law and regulation that affect businesses.',
      keywords: [
        'corporate law', 'mergers and acquisitions', 'M&A', 'due diligence', 'securities law',
        'securities regulation', 'capital markets', 'private equity', 'term sheet',
        'purchase agreement', 'commercial contract', 'contract drafting', 'indemnification',
        'corporate governance', 'fiduciary duty', 'board of directors', 'shareholder',
        'compliance', 'SEC', 'antitrust', 'general counsel', 'in-house counsel', 'law firm',
        'legal tech', 'billable hours', 'associate', 'partner track', 'paralegal', 'litigation',
        'r/law', 'r/LawFirm', 'r/Lawyertalk', 'r/biglaw', 'r/legaladvice', 'r/inhouse',
      ],
      sample: {
        subreddit: 'biglaw',
        title: 'Negotiating indemnification caps in an M&A purchase agreement',
        body: 'Our due diligence turned up regulatory exposure. How do you structure the escrow and survival period?',
      },
    },
    {
      id: 'science-teacher',
      label: 'Science teacher',
      workDescription:
        'Teaching high-school science: biology, chemistry and physics; lesson plans, labs and demonstrations; ' +
        'pedagogy, assessment and classroom management; curriculum standards, lab safety, ' +
        'and the teaching profession.',
      keywords: [
        'lesson plan', 'lab safety', 'lab activity', 'classroom management', 'pedagogy',
        'formative assessment', 'curriculum', 'NGSS', 'AP Biology', 'AP Chemistry', 'AP Physics',
        'high school science', 'science teacher', 'science fair', 'inquiry-based', 'rubric',
        'differentiation', 'stoichiometry', 'periodic table', 'photosynthesis', 'cell biology',
        'genetics', 'Newton', 'kinematics', 'titration', 'dissection', 'chemistry', 'biology', 'physics',
        'r/ScienceTeachers', 'r/Teachers', 'r/chemistry', 'r/biology', 'r/physics',
        'r/ChemistryTeachers', 'r/HighSchoolTeachers', 'r/APBiology',
      ],
      sample: {
        subreddit: 'ScienceTeachers',
        title: 'Lab activity ideas for teaching stoichiometry to sophomores',
        body: 'Looking for a titration lab with low prep and good lab safety. What rubric do you use?',
      },
    },
  ];

  const DEFAULT_PERSONA = PERSONAS[0];

  const DEFAULTS = {
    apiKey: '',
    model: 'openai/gpt-oss-20b',
    workDescription: DEFAULT_PERSONA.workDescription,
    keywords: DEFAULT_PERSONA.keywords,
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

  function safeDecode(segment) {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  // Maps a Reddit URL to the unit that gets judged. Pages with the same key share one verdict.
  function routeFor(href) {
    const url = new URL(href);
    const parts = url.pathname.split('/').filter(Boolean).map(safeDecode);
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

  function normalizeKeywords(text) {
    return [...new Set(
      String(text || '')
        .split(/[\n,]+/)
        .map((entry) => entry.trim().replace(/^\/?r\/(.*)$/i, (_, sub) => `r/${sub.trim().toLowerCase()}`))
        .filter((entry) => entry && entry !== 'r/'),
    )];
  }

  // Returns the persona whose description and keywords both match exactly, or null for custom text.
  function matchPersona(workDescription, keywords) {
    const description = String(workDescription || '').trim();
    const list = normalizeKeywords((keywords || []).join('\n'));
    return PERSONAS.find((p) =>
      p.workDescription === description &&
      JSON.stringify(normalizeKeywords(p.keywords.join('\n'))) === JSON.stringify(list)) || null;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Short all-caps acronyms match case-sensitively so "ai" or "Ml" in ordinary words don't count.
  function compileKeywords(keywords) {
    const subs = new Set();
    const patterns = [];
    for (const entry of normalizeKeywords((keywords || []).join('\n'))) {
      if (entry.startsWith('r/')) {
        subs.add(entry.slice(2));
        continue;
      }
      const caseSensitive = entry.length <= 5 && entry === entry.toUpperCase();
      const body = escapeRegex(entry).replace(/ /g, '[\\s-]');
      patterns.push(new RegExp(`(?<![\\w])${body}s?(?![\\w])`, caseSensitive ? 'g' : 'gi'));
    }
    return { subs, patterns };
  }

  const NEGATION = /\b(not|no|non|without|zero)[\s-]+$/i;

  function countHits(str, patterns) {
    let hits = 0;
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(str))) {
        if (!NEGATION.test(str.slice(Math.max(0, m.index - 12), m.index))) hits++;
      }
    }
    return hits;
  }

  // Counts keyword hits, skipping negated ones like "NOT AI" or "no AI-generated".
  function keywordHits(text, keywords) {
    return countHits(String(text || ''), compileKeywords(keywords).patterns);
  }

  function keywordVerdict(route, page, keywords) {
    const { subs, patterns } = compileKeywords(keywords);
    const hits = (text) => countHits(String(text || ''), patterns);
    const sub = route.subreddit || page.subreddit || '';
    if (subs.has(sub)) return { relevant: true, reason: `r/${sub} is on your keyword list` };

    if (route.kind === 'post') {
      return hits(page.title) + hits(page.body) > 0
        ? { relevant: true, reason: 'Post mentions your keywords' }
        : { relevant: false, reason: 'No keywords from your list in the post' };
    }

    const titles = page.titles || [];
    const matching = titles.filter((t) => hits(t) > 0).length;
    const queryHit = route.query && hits(route.query) > 0;
    if (queryHit || (titles.length > 0 && matching / titles.length >= 0.5)) {
      return { relevant: true, reason: `${matching} of ${titles.length} posts mention your keywords` };
    }
    return { relevant: false, reason: `Only ${matching} of ${titles.length} posts mention your keywords` };
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
    DEFAULTS, PERSONAS, OVERRIDE_MINUTES,
    routeFor, quickDecision, normalizeSubs, normalizeKeywords, matchPersona,
    buildMessages, groqRequestBody, parseModelReply,
    keywordHits, keywordVerdict,
    cacheGet, cachePut, pushLog,
  };
})();

if (typeof module !== 'undefined') module.exports = WF;
