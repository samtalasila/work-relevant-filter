// Shared logic for the service worker, the popup, and the tests.
// Everything here is pure: no chrome.* calls and no DOM access.

const SB = (() => {
  const BLOCKED_DOMAINS = ['x.com', 'twitter.com', 'linkedin.com'];
  const PAUSE_MS = 5 * 60 * 1000;
  const STORAGE_KEY = 'blocking';

  // A pattern of the form *://*.domain/* also matches the bare domain.
  const MATCH_PATTERNS = BLOCKED_DOMAINS.map((d) => `*://*.${d}/*`);

  function parseState(raw) {
    if (raw && raw.mode === 'off') return { mode: 'off' };
    if (raw && raw.mode === 'paused' && Number.isFinite(raw.until)) return { mode: 'paused', until: raw.until };
    return { mode: 'on' };
  }

  function isBlocking(state, now) {
    switch (state.mode) {
      case 'off': return false;
      case 'paused': return now >= state.until;
      default: return true;
    }
  }

  function pauseFrom(now) {
    return { mode: 'paused', until: now + PAUSE_MS };
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const seconds = String(total % 60).padStart(2, '0');
    return `${Math.floor(total / 60)}:${seconds}`;
  }

  return { BLOCKED_DOMAINS, PAUSE_MS, STORAGE_KEY, MATCH_PATTERNS, parseState, isBlocking, pauseFrom, formatRemaining };
})();

if (typeof module !== 'undefined') module.exports = SB;
