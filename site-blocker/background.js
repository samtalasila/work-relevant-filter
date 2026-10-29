importScripts('lib.js');

const RULE_ID = 1;
const RESUME_ALARM = 'resume';

async function readState() {
  const stored = await chrome.storage.local.get(SB.STORAGE_KEY);
  return SB.parseState(stored[SB.STORAGE_KEY]);
}

async function setRule(blocking) {
  const addRules = blocking
    ? [{
        id: RULE_ID,
        priority: 1,
        condition: { requestDomains: SB.BLOCKED_DOMAINS, resourceTypes: ['main_frame'] },
        action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } },
      }]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules });
}

// SPAs never make a new main_frame request, so tabs that are already open need a nudge.
async function redirectOpenTabs() {
  const tabs = await chrome.tabs.query({ url: SB.MATCH_PATTERNS });
  const blocked = chrome.runtime.getURL('blocked.html');
  await Promise.all(tabs.map((tab) => chrome.tabs.update(tab.id, { url: blocked })));
}

async function apply() {
  const state = await readState();
  const blocking = SB.isBlocking(state, Date.now());
  await setRule(blocking);
  if (state.mode === 'paused' && blocking) {
    await chrome.storage.local.set({ [SB.STORAGE_KEY]: { mode: 'on' } });
    return;
  }
  if (state.mode === 'paused') await chrome.alarms.create(RESUME_ALARM, { when: state.until });
  else await chrome.alarms.clear(RESUME_ALARM);
  if (blocking) await redirectOpenTabs();
}

chrome.runtime.onInstalled.addListener(apply);
chrome.runtime.onStartup.addListener(apply);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) apply();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SB.STORAGE_KEY in changes) apply();
});
