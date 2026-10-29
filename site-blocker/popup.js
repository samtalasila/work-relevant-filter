const $ = (id) => document.getElementById(id);

let state = { mode: 'on' };

const save = (next) => chrome.storage.local.set({ [SB.STORAGE_KEY]: next });

function button(label, next, primary) {
  const el = document.createElement('button');
  el.textContent = label;
  if (primary) el.className = 'primary';
  el.addEventListener('click', () => save(next()));
  return el;
}

function render() {
  const now = Date.now();
  const blocking = SB.isBlocking(state, now);
  const actions = $('actions');
  actions.replaceChildren();
  if (state.mode === 'off') {
    $('status').textContent = 'Off';
    actions.append(button('Turn on', () => ({ mode: 'on' }), true));
  } else if (!blocking) {
    $('status').textContent = `Paused, resumes in ${SB.formatRemaining(state.until - now)}`;
    actions.append(button('Resume now', () => ({ mode: 'on' }), true), button('Turn off', () => ({ mode: 'off' })));
  } else {
    $('status').textContent = 'Blocking';
    actions.append(button('Pause 5 min', () => SB.pauseFrom(Date.now()), true), button('Turn off', () => ({ mode: 'off' })));
  }
}

chrome.storage.local.get(SB.STORAGE_KEY).then((stored) => {
  state = SB.parseState(stored[SB.STORAGE_KEY]);
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(SB.STORAGE_KEY in changes)) return;
  state = SB.parseState(changes[SB.STORAGE_KEY].newValue);
  render();
});
setInterval(render, 1000);
