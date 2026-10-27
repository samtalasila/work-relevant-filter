const $ = (id) => document.getElementById(id);
const status = (msg) => { $('status').textContent = msg; };

function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function renderList(el, items, render) {
  el.replaceChildren();
  if (!items || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None yet';
    el.append(li);
    return;
  }
  for (const item of items.slice(0, 20)) el.append(render(item));
}

function verdictItem(v) {
  const li = document.createElement('li');
  const tag = document.createElement('span');
  tag.className = `tag ${v.decision}`;
  tag.textContent = v.decision;
  const title = document.createElement('span');
  title.textContent = v.title;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${v.reason} · ${v.source} · ${timeAgo(v.ts)}${v.error ? ` · ${v.error}` : ''}`;
  li.append(tag, title, meta);
  return li;
}

function overrideItem(o) {
  const li = document.createElement('li');
  li.textContent = `“${o.reason}”`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${o.key} · ${timeAgo(o.ts)}`;
  li.append(meta);
  return li;
}

const CUSTOM = 'custom';

function syncPersona() {
  const match = WF.matchPersona($('workDescription').value, WF.normalizeKeywords($('keywords').value));
  $('persona').value = match ? match.id : CUSTOM;
  return match;
}

function initPersonas() {
  const options = [...WF.PERSONAS.map((p) => [p.id, p.label]), [CUSTOM, 'Custom']];
  $('persona').replaceChildren(...options.map(([value, text]) => Object.assign(document.createElement('option'), { value, textContent: text })));
}

$('persona').addEventListener('change', () => {
  const persona = WF.PERSONAS.find((p) => p.id === $('persona').value);
  if (!persona) return;
  $('workDescription').value = persona.workDescription;
  $('keywords').value = persona.keywords.join('\n');
});
$('workDescription').addEventListener('input', syncPersona);
$('keywords').addEventListener('input', syncPersona);

async function load() {
  const data = await chrome.storage.local.get([...Object.keys(WF.DEFAULTS), 'verdictLog', 'overrideLog']);
  const settings = { ...WF.DEFAULTS, ...data };
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('workDescription').value = settings.workDescription;
  $('keywords').value = settings.keywords.join('\n');
  syncPersona();
  $('allowSubs').value = settings.allowSubs.join('\n');
  $('blockSubs').value = settings.blockSubs.join('\n');
  renderList($('verdicts'), data.verdictLog, verdictItem);
  renderList($('overrides'), data.overrideLog, overrideItem);
}

$('save').addEventListener('click', async () => {
  const { workDescription: oldDescription } = await chrome.storage.local.get('workDescription');
  const workDescription = $('workDescription').value.trim() || WF.DEFAULTS.workDescription;
  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || WF.DEFAULTS.model,
    workDescription,
    keywords: WF.normalizeKeywords($('keywords').value),
    allowSubs: WF.normalizeSubs($('allowSubs').value),
    blockSubs: WF.normalizeSubs($('blockSubs').value),
  });
  // Cached verdicts were judged against the old description.
  if ((oldDescription || WF.DEFAULTS.workDescription) !== workDescription) await chrome.storage.local.remove('cache');
  status('Saved');
  load();
});

$('test').addEventListener('click', async () => {
  status('Testing…');
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${$('apiKey').value.trim()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ids = (await res.json()).data.map((m) => m.id).sort();
    $('models').replaceChildren(...ids.map((id) => Object.assign(document.createElement('option'), { value: id })));
    let model = $('model').value.trim() || WF.DEFAULTS.model;
    if (!ids.includes(model)) {
      if (!ids.includes(WF.DEFAULTS.model)) {
        status(`Key works, but ${model} isn't listed. Pick a model from the list.`);
        return;
      }
      model = WF.DEFAULTS.model;
      $('model').value = model;
    }

    status(`Key works · testing ${model}…`);
    const persona = syncPersona();
    const test = await chrome.runtime.sendMessage({
      type: 'test',
      personaId: persona ? persona.id : null,
      settings: { apiKey: $('apiKey').value.trim(), model, workDescription: $('workDescription').value.trim() || WF.DEFAULTS.workDescription },
    });
    if (!test.ok) throw new Error(test.error);
    const correct = test.results.filter((r) => r.relevant === r.expected).length;
    const slowest = Math.max(...test.results.map((r) => r.ms));
    status(`${model}: ${correct}/${test.results.length} samples judged right, slowest ${slowest} ms. Click Save to keep it.`);
  } catch (err) {
    status(`Test failed: ${err.message}`);
  }
});

$('clearCache').addEventListener('click', async () => {
  await chrome.storage.local.remove('cache');
  status('Cache cleared');
});

initPersonas();
load();
