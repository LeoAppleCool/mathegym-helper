(() => {
  'use strict';
  const gemini = globalThis.MathegymGemini;
  const $ = id => document.getElementById(id);
  const store = {
    get: async () => (await chrome.storage.local.get('gemini')).gemini || {},
    set: state => chrome.storage.local.set({ gemini: state })
  };
  let busy = false;

  function status(text, kind = '') {
    $('status').textContent = text;
    $('status').className = `status ${kind}`;
  }

  function lock(value) {
    busy = value;
    for (const id of ['save', 'test', 'remove']) $(id).disabled = value;
  }

  async function render() {
    const { apiKey, gemini: state } = await chrome.storage.local.get(['apiKey', 'gemini']);
    $('saved').textContent = apiKey ? `A key ending in …${apiKey.slice(-4)} is saved. To change it, just enter a new one.` : 'No key saved yet.';
    $('test').hidden = $('remove').hidden = !apiKey;
    $('reset').textContent = gemini.resetTime();
    const rows = gemini.overview(state).map(model => {
      const row = document.createElement('tr');
      for (const text of [model.name, String(model.used), model.exhausted ? 'daily limit reached' : 'available']) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      return row;
    });
    $('models').replaceChildren(...rows);
  }

  $('toggle').onclick = () => {
    const show = $('key').type === 'password';
    $('key').type = show ? 'text' : 'password';
    $('toggle').textContent = show ? 'Hide' : 'Show';
    $('toggle').setAttribute('aria-pressed', String(show));
  };

  $('form').onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const key = $('key').value.trim();
    if (!gemini.validKey(key)) return status('That does not look like an API key. Copy the complete key from Google AI Studio.', 'bad');
    lock(true);
    status('Checking the key with Google …');
    try {
      const ids = await gemini.listModels(key);
      if (!ids.length) throw new Error('No suitable free models are available for this key.');
      const state = await store.get();
      state.models = { day: gemini.quotaDay(), ids };
      await chrome.storage.local.set({ apiKey: key, gemini: state });
      $('key').value = '';
      status(`Saved. ${ids.length} free models available, starting with ${gemini.modelName(ids[0])}. Reload open Mathegym pages if they still show a notice.`, 'ok');
    } catch (error) {
      status(error.message, 'bad');
    } finally {
      lock(false);
      render();
    }
  };

  $('test').onclick = async () => {
    if (busy) return;
    const { apiKey } = await chrome.storage.local.get('apiKey');
    lock(true);
    status('The AI is calculating 12 · 7 …');
    try {
      const payload = { instruction: 'Calculate.', task: '12 · 7 = [FIELD_1]', fields: [{ field: 'FIELD_1', type: 'text', label: '' }] };
      const result = await gemini.solve({ key: apiKey, store, payload });
      const value = result.data.answers.find(answer => answer.field === 'FIELD_1')?.value;
      if (String(value).trim() === '84') status(`Test passed: ${result.name} calculated 12 · 7 = 84.`, 'ok');
      else status(`${result.name} answered, but returned "${value ?? result.data.status}" instead of 84.`, 'bad');
    } catch (error) {
      status(error.message, 'bad');
    } finally {
      lock(false);
      render();
    }
  };

  $('remove').onclick = async () => {
    if (busy) return;
    await chrome.storage.local.remove('apiKey');
    status('The key was removed.');
    render();
  };

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') render(); });
  $('version').textContent = chrome.runtime.getManifest().version;
  render();
})();
