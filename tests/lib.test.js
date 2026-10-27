const test = require('node:test');
const assert = require('node:assert/strict');
const WF = require('../lib.js');

const settings = { ...WF.DEFAULTS, allowSubs: ['localllama'], blockSubs: ['aww'] };

test('routeFor maps Reddit URLs to judged units', () => {
  const cases = [
    ['https://www.reddit.com/', 'feed', 'feed:home'],
    ['https://www.reddit.com/best/?feed=home', 'feed', 'feed:home'],
    ['https://www.reddit.com/r/popular/', 'feed', 'feed:popular'],
    ['https://www.reddit.com/r/All/top/', 'feed', 'feed:all'],
    ['https://www.reddit.com/r/aww+pics/', 'feed', 'feed:multi'],
    ['https://www.reddit.com/r/MachineLearning/', 'subreddit', 'sub:machinelearning'],
    ['https://www.reddit.com/r/MachineLearning/top/?t=week', 'subreddit', 'sub:machinelearning'],
    ['https://www.reddit.com/r/LocalLLaMA/comments/1abcde/some_title/', 'post', 'post:1abcde'],
    ['https://www.reddit.com/r/LocalLLaMA/comments/1abcde/comment/xyz/', 'post', 'post:1abcde'],
    ['https://www.reddit.com/comments/1abcde', 'post', 'post:1abcde'],
    ['https://www.reddit.com/user/someone/', 'listing', 'user:someone'],
    ['https://www.reddit.com/search/?q=RAG%20evals', 'listing', 'search:rag evals'],
    ['https://www.reddit.com/settings/account', 'utility', 'utility:settings'],
    ['https://old.reddit.com/r/aww/', 'subreddit', 'sub:aww'],
  ];
  for (const [url, kind, key] of cases) {
    const route = WF.routeFor(url);
    assert.equal(route.kind, kind, url);
    assert.equal(route.key, key, url);
  }
  assert.equal(WF.routeFor('https://www.reddit.com/r/LocalLLaMA/comments/1abcde/x/').subreddit, 'localllama');
});

test('quickDecision blocks feeds and applies subreddit lists', () => {
  assert.equal(WF.quickDecision(WF.routeFor('https://www.reddit.com/'), settings).decision, 'block');
  assert.equal(WF.quickDecision(WF.routeFor('https://www.reddit.com/settings'), settings).decision, 'allow');
  assert.equal(WF.quickDecision(WF.routeFor('https://www.reddit.com/r/aww/comments/abc/x'), settings).decision, 'block');
  assert.equal(WF.quickDecision(WF.routeFor('https://www.reddit.com/r/LocalLLaMA/'), settings).decision, 'allow');
  assert.equal(WF.quickDecision(WF.routeFor('https://www.reddit.com/r/startups/'), settings), null);
});

test('normalizeSubs accepts r/ prefixes, commas and newlines', () => {
  assert.deepEqual(WF.normalizeSubs('r/LocalLLaMA\n/r/MachineLearning, aww\n\naww'), ['localllama', 'machinelearning', 'aww']);
});

const AI = WF.PERSONAS.find((p) => p.id === 'ai-consultant').keywords;

test('keyword backup ignores negated mentions like "NOT AI"', () => {
  assert.equal(WF.keywordHits('My cat, NOT AI generated', AI), 0);
  assert.equal(WF.keywordHits('no AI-generated content', AI), 0);
  assert.equal(WF.keywordHits('Said the waiter to the chair', AI), 0);
  assert.equal(WF.keywordHits('Fine-tuning LLMs for RAG', AI), 3);
  assert.equal(WF.keywordHits('Our machine learning pipeline', AI), 1);
});

test('short all-caps keywords match case-sensitively, longer ones do not', () => {
  assert.equal(WF.keywordHits('the SEC filed', ['SEC']), 1);
  assert.equal(WF.keywordHits('a second sec of video', ['SEC']), 0);
  assert.equal(WF.keywordHits('Due DILIGENCE', ['due diligence']), 1);
});

test('keywordVerdict judges posts and listings', () => {
  const post = WF.routeFor('https://www.reddit.com/r/aww/comments/abc/x');
  assert.equal(WF.keywordVerdict(post, { title: 'Look at my dog, NOT AI' }, AI).relevant, false);
  assert.equal(WF.keywordVerdict(post, { title: 'Evaluating LLM agents' }, AI).relevant, true);

  const sub = WF.routeFor('https://www.reddit.com/r/startups/');
  assert.equal(WF.keywordVerdict(sub, { titles: ['AI agents for sales', 'Raising a seed', 'LLM costs'] }, AI).relevant, true);
  assert.equal(WF.keywordVerdict(sub, { titles: ['Burnout', 'Raising a seed', 'LLM costs'] }, AI).relevant, false);
});

test('keywordVerdict treats r/ entries as relevant subreddits', () => {
  const keywords = ['contract', 'r/Lawyertalk'];
  const inList = WF.routeFor('https://www.reddit.com/r/LawyerTalk/');
  assert.equal(WF.keywordVerdict(inList, { titles: [] }, keywords).relevant, true);
  assert.match(WF.keywordVerdict(inList, { titles: [] }, keywords).reason, /your keyword list/);
  const other = WF.routeFor('https://www.reddit.com/r/aww/');
  assert.equal(WF.keywordVerdict(other, { titles: [] }, keywords).relevant, false);
  assert.equal(WF.keywordHits('r/lawyertalk', keywords), 0);
});

test('normalizeKeywords splits on newlines and commas, keeps phrases and case', () => {
  assert.deepEqual(
    WF.normalizeKeywords('Hugging Face, RAG\n  /r/LocalLLaMA\nr/LocalLLaMA\n\nR/Aww, RAG'),
    ['Hugging Face', 'RAG', 'r/localllama', 'r/aww'],
  );
  assert.deepEqual(WF.normalizeKeywords(' , \n'), []);
});

test('every persona is complete and its sample is relevant under its own keywords', () => {
  assert.equal(WF.PERSONAS[0].id, 'software-engineer');
  assert.deepEqual(WF.DEFAULTS.keywords, WF.PERSONAS[0].keywords);
  assert.equal(WF.DEFAULTS.workDescription, WF.PERSONAS[0].workDescription);
  for (const p of WF.PERSONAS) {
    assert.ok(p.id && p.label && p.workDescription, p.id);
    assert.ok(p.keywords.length >= 20, p.id);
    assert.ok(p.keywords.some((k) => k.startsWith('r/')), p.id);
    const { title, body } = p.sample;
    assert.ok(p.sample.subreddit && title && body, p.id);
    const route = WF.routeFor(`https://www.reddit.com/r/aww/comments/abc/x`);
    assert.equal(WF.keywordVerdict(route, { title, body }, p.keywords).relevant, true, p.id);
    assert.equal(WF.keywordVerdict(route, { title: 'My cat learned to open the fridge' }, p.keywords).relevant, false, p.id);
  }
});

test('matchPersona finds a preset only when description and keywords both match', () => {
  const p = WF.PERSONAS[2];
  assert.equal(WF.matchPersona(p.workDescription, p.keywords), p);
  assert.equal(WF.matchPersona(`${p.workDescription} `, WF.normalizeKeywords(p.keywords.join('\n'))), p);
  assert.equal(WF.matchPersona(p.workDescription, [...p.keywords, 'extra']), null);
  assert.equal(WF.matchPersona('something else', p.keywords), null);
});

test('routeFor survives malformed percent escapes', () => {
  const route = WF.routeFor('https://www.reddit.com/r/%E0%A4/');
  assert.equal(route.kind, 'subreddit');
  assert.equal(route.subreddit, '%e0%a4');
  assert.equal(WF.routeFor('https://www.reddit.com/search/?q=%E0%A4').kind, 'listing');
});

test('buildMessages includes the work description and truncates long bodies', () => {
  const route = WF.routeFor('https://www.reddit.com/r/LocalLLaMA/comments/abc/x');
  const [system, user] = WF.buildMessages(route, { title: 'T', body: 'x'.repeat(5000) }, 'MY WORK');
  assert.match(system.content, /MY WORK/);
  const input = JSON.parse(user.content);
  assert.equal(input.subreddit, 'r/localllama');
  assert.equal(input.body.length, 1501);
});

test('parseModelReply accepts JSON, tolerates fences, rejects junk', () => {
  assert.deepEqual(WF.parseModelReply('{"relevant": true, "reason": "RAG evals"}'), { relevant: true, reason: 'RAG evals' });
  assert.deepEqual(WF.parseModelReply('```json\n{"relevant": false, "reason": "pets"}\n```'), { relevant: false, reason: 'pets' });
  assert.equal(WF.parseModelReply('{"relevant": "yes"}'), null);
  assert.equal(WF.parseModelReply('not json'), null);
});

test('cache expires entries and stays bounded', () => {
  const cache = {};
  WF.cachePut(cache, 'a', { relevant: true, reason: '' }, 1000);
  assert.ok(WF.cacheGet(cache, 'a', 2000));
  assert.equal(WF.cacheGet(cache, 'a', 1000 + 8 * 24 * 3600 * 1000), null);
  for (let i = 0; i < 520; i++) WF.cachePut(cache, `k${i}`, { relevant: false, reason: '' }, 2000 + i);
  assert.equal(Object.keys(cache).length, 500);
  assert.equal(cache.a, undefined);
});

test('groqRequestBody keeps gpt-oss reasoning short and out of the reply', () => {
  const route = WF.routeFor('https://www.reddit.com/r/LocalLLaMA/comments/abc/x');
  const oss = WF.groqRequestBody(route, { title: 'T' }, { ...WF.DEFAULTS, model: 'openai/gpt-oss-20b' });
  assert.equal(oss.reasoning_effort, 'low');
  assert.equal(oss.include_reasoning, false);
  assert.equal(oss.max_tokens, 600);
  const llama = WF.groqRequestBody(route, { title: 'T' }, { ...WF.DEFAULTS, model: 'llama-3.3-70b-versatile' });
  assert.equal(llama.reasoning_effort, undefined);
  assert.deepEqual(llama.response_format, { type: 'json_object' });
});
