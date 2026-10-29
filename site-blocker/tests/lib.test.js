const test = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../lib.js');

const NOW = 1_000_000;

test('on blocks and off allows', () => {
  assert.equal(SB.isBlocking({ mode: 'on' }, NOW), true);
  assert.equal(SB.isBlocking({ mode: 'off' }, NOW), false);
});

test('a pause allows until its deadline, then blocks', () => {
  const paused = { mode: 'paused', until: NOW + 1000 };
  assert.equal(SB.isBlocking(paused, NOW), false);
  assert.equal(SB.isBlocking(paused, NOW + 999), false);
  assert.equal(SB.isBlocking(paused, NOW + 1000), true);
  assert.equal(SB.isBlocking(paused, NOW + 5000), true);
});

test('pauseFrom lasts five minutes', () => {
  const state = SB.pauseFrom(NOW);
  assert.equal(state.mode, 'paused');
  assert.equal(state.until - NOW, 5 * 60 * 1000);
  assert.equal(SB.isBlocking(state, NOW + 5 * 60 * 1000 - 1), false);
  assert.equal(SB.isBlocking(state, NOW + 5 * 60 * 1000), true);
});

test('missing or malformed stored state means blocking on', () => {
  for (const raw of [undefined, null, {}, { mode: 'bogus' }, { mode: 'paused' }, { mode: 'paused', until: 'soon' }]) {
    assert.deepEqual(SB.parseState(raw), { mode: 'on' });
  }
  assert.deepEqual(SB.parseState({ mode: 'off' }), { mode: 'off' });
  assert.deepEqual(SB.parseState({ mode: 'paused', until: 5 }), { mode: 'paused', until: 5 });
});

test('the blocked list covers x.com, twitter.com and linkedin.com with subdomains', () => {
  assert.deepEqual(SB.BLOCKED_DOMAINS, ['x.com', 'twitter.com', 'linkedin.com']);
  assert.deepEqual(SB.MATCH_PATTERNS, ['*://*.x.com/*', '*://*.twitter.com/*', '*://*.linkedin.com/*']);
});

test('formatRemaining shows minutes and zero-padded seconds', () => {
  assert.equal(SB.formatRemaining(252_000), '4:12');
  assert.equal(SB.formatRemaining(300_000), '5:00');
  assert.equal(SB.formatRemaining(61_001), '1:02');
  assert.equal(SB.formatRemaining(-5), '0:00');
});
