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

test('keyword backup ignores negated mentions like "NOT AI"', () => {
  assert.equal(WF.keywordHits('My cat, NOT AI generated'), 0);
  assert.equal(WF.keywordHits('no AI-generated content'), 0);
  assert.equal(WF.keywordHits('Said the waiter to the chair'), 0);
  assert.equal(WF.keywordHits('Fine-tuning LLMs for RAG'), 3);
  assert.equal(WF.keywordHits('Our machine learning pipeline'), 1);
});

test('keywordVerdict judges posts and listings', () => {
  const post = WF.routeFor('https://www.reddit.com/r/aww/comments/abc/x');
  assert.equal(WF.keywordVerdict(post, { title: 'Look at my dog, NOT AI' }).relevant, false);
  assert.equal(WF.keywordVerdict(post, { title: 'Evaluating LLM agents' }).relevant, true);

  const sub = WF.routeFor('https://www.reddit.com/r/startups/');
  assert.equal(WF.keywordVerdict(sub, { titles: ['AI agents for sales', 'Raising a seed', 'LLM costs'] }).relevant, true);
  assert.equal(WF.keywordVerdict(sub, { titles: ['Burnout', 'Raising a seed', 'LLM costs'] }).relevant, false);
  assert.equal(WF.keywordVerdict(WF.routeFor('https://www.reddit.com/r/LocalLLaMA/'), { titles: [] }).relevant, true);
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
