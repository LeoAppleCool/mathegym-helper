// AI panel on the Mathegym page: sends the current task to the free Gemini API and fills
// the validated answers into the fields.
(() => {
  'use strict';
  if (location.hostname !== 'mathegym.de' && !location.hostname.endsWith('.mathegym.de')) return;
  const AI_HOST = 'mathegym-helper-ai';
  const KEY_STORAGE = 'mathegym-helper-key';
  const STATE_STORAGE = 'mathegym-helper-gemini';
  // Only the bookmarklet loads html2canvas from the CDN; the extension ships the file itself.
  const HTML2CANVAS = {
    url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    integrity: 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H'
  };
  const REASONS = {
    'quota-day': 'daily limit', 'quota-minute': 'per-minute limit', busy: 'overloaded', timeout: 'too slow', format: 'invalid answer',
    truncated: 'cut off', blocked: 'blocked', model: 'unavailable', request: 'rejected'
  };
  const extension = !!globalThis.chrome?.runtime?.id;
  const shortcut = !/Mac|iPhone|iPad/.test(navigator.platform);
  let notifyPanel = null;

  // In the extension, the background script calls the API with the key stored there.
  // The bookmarklet calls the API directly and stores the key in the browser for mathegym.de.
  const localStore = {
    get: async () => { try { return JSON.parse(localStorage.getItem(STATE_STORAGE)) || {}; } catch { return {}; } },
    set: async state => { try { localStorage.setItem(STATE_STORAGE, JSON.stringify(state)); } catch {} }
  };
  const readKey = () => { try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; } };

  async function send(message) {
    let response;
    try { response = await chrome.runtime.sendMessage(message); }
    catch { throw new Error('The extension was reloaded. Reload the Mathegym page (F5).'); }
    if (!response) throw new Error('The extension background script is not responding. Reload the page.');
    if (response.error) throw Object.assign(new Error(response.error), { reason: response.reason });
    return response;
  }

  const backend = extension ? {
    solve: request => send({ type: 'solve', ...request }),
    status: () => send({ type: 'status' }),
    settings: () => send({ type: 'settings' })
  } : {
    solve: request => window.MathegymGemini.solve({ ...request, key: readKey(), store: localStore }),
    status: async () => ({ hasKey: !!readKey(), models: window.MathegymGemini.overview(await localStore.get()) }),
    async saveKey(key) {
      const gemini = window.MathegymGemini;
      if (!gemini.validKey(key)) throw new Error('That does not look like an API key. Copy the complete key from Google AI Studio.');
      const ids = await gemini.listModels(key);
      if (!ids.length) throw new Error('No suitable free models are available for this key.');
      const state = await localStore.get();
      state.models = { day: gemini.quotaDay(), ids };
      await localStore.set(state);
      localStorage.setItem(KEY_STORAGE, key);
    }
  };
  if (extension) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.apiKey) notifyPanel?.(); });

  function visible(element) {
    const style = getComputedStyle(element);
    return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function mathText(node) {
    const items = [...node.children];
    const texts = items.map(mathText);
    switch (node.localName?.toLowerCase()) {
      case 'mfrac': return `(${texts[0]})/(${texts[1]})`;
      case 'msup': return `(${texts[0]})^(${texts[1]})`;
      case 'msub': return `${texts[0]}_${texts[1]}`;
      case 'msubsup': return `${texts[0]}_${texts[1]}^(${texts[2]})`;
      case 'msqrt': return `sqrt(${texts.join(' ')})`;
      case 'mroot': return `root(${texts[0]}, ${texts[1]})`;
      case 'mtr': return texts.join(' | ');
      case 'mtable': return texts.join('\n');
      default: return items.length ? texts.join(' ') : node.textContent;
    }
  }

  function snapshot() {
    const body = document.getElementById('exBody');
    if (!body) throw new Error('Open a Mathegym task first.');
    const elements = [...body.querySelectorAll('input, textarea, select')].filter(element =>
      visible(element) && !element.disabled && !element.readOnly &&
      !['hidden', 'submit', 'button', 'image', 'reset', 'password', 'file'].includes(element.type));
    const index = new Map(elements.map((element, i) => [element, `FIELD_${i + 1}`]));
    let graphics = false;
    function text(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node.nodeType !== Node.ELEMENT_NODE || !visible(node)) return '';
      if (index.has(node)) return ` [${index.get(node)}] `;
      const tag = node.localName.toLowerCase();
      if (tag === 'script' && /math\/tex/.test(node.type)) return ` ${node.textContent} `;
      if (['script', 'style', 'template', 'button'].includes(tag)) return '';
      if (tag === 'math') return ` ${mathText(node)} `;
      if (tag === 'mjx-container') {
        const math = node.querySelector('math');
        if (math) return ` ${mathText(math)} `;
        graphics = true;
        return ` [Rendered formula: ${node.getAttribute('aria-label') || node.textContent}] `;
      }
      if (['img', 'canvas', 'svg'].includes(tag)) {
        graphics = true;
        return ` [Graphic${node.getAttribute('alt') ? ': ' + node.getAttribute('alt') : ''}; see task image] `;
      }
      if (tag === 'br') return '\n';
      if (tag === 'sup') return `^(${[...node.childNodes].map(text).join('')})`;
      if (tag === 'sub') return `_(${[...node.childNodes].map(text).join('')})`;
      const children = [...node.children];
      if (tag === 'div' && children.length === 2 && children[0].style.borderBottomStyle === 'solid') {
        return ` ${text(children[0]).trim()}/${text(children[1]).trim()} `;
      }
      const content = [...node.childNodes].map(text).join('');
      return ['p', 'div', 'tr', 'li'].includes(tag) ? `${content}\n` : content;
    }
    const normalize = value => value.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    const fields = elements.map(element => ({
      field: index.get(element),
      type: element.tagName === 'SELECT' ? 'select' : (element.type || 'text'),
      label: normalize([...element.labels || []].map(label => label.textContent).join(' ')),
      ...(element.placeholder ? { placeholder: element.placeholder } : {}),
      ...(element.tagName === 'SELECT' ? { options: [...element.options].filter(option => !option.disabled).map(option => ({ value: option.value, label: option.textContent })) } : {}),
      ...(['radio', 'checkbox'].includes(element.type) ? { choice: element.value, group: element.name } : {})
    }));
    const payload = {
      instruction: normalize(document.getElementById('ex-instruction')?.innerText || ''),
      task: normalize(text(body)),
      fields
    };
    if ((payload.task.length + payload.instruction.length) > 40000 || fields.length > 100) {
      throw new Error('The task is too large for a single request.');
    }
    return { body, elements, payload, graphics, fingerprint: JSON.stringify(payload), values: elements.map(element => [element.value, element.checked]) };
  }

  function loadScript({ url, integrity }, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
      script.async = true;
      const finish = error => {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); reject(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('The screenshot library could not be loaded. Check your connection or script blocker.')), 20000);
      script.onload = () => finish(ready() ? null : new Error('The screenshot library loaded but is not available.'));
      script.onerror = () => finish(new Error('The page or a script blocker is blocking the screenshot library. Use your own screenshot instead.'));
      document.head.append(script);
    });
  }

  async function taskImage(task) {
    await loadScript(HTML2CANVAS, () => typeof window.html2canvas === 'function');
    const rect = task.body.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('The task area is not visible.');
    const canvas = await window.html2canvas(task.body, {
      backgroundColor: '#ffffff', useCORS: true, allowTaint: false,
      logging: false, imageTimeout: 10000, scale: Math.min(2, 2200 / Math.max(rect.width, rect.height)),
      ignoreElements: element => element.id === AI_HOST || element.id === 'mathegym-helper-status' || element.hasAttribute('data-mathegym-action')
    });
    return canvas.toDataURL('image/png');
  }

  function readFile(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      return Promise.reject(new Error('Please choose a PNG, JPEG or WebP image of at most 5 MB.'));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('The image could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  // Checks the answer against the actual fields. Only a completely valid plan is filled in.
  function parseResponse(data, task) {
    if (!data || !['solved', 'uncertain', 'unsupported'].includes(data.status) || typeof data.explanation !== 'string' || !Array.isArray(data.answers)) {
      throw new Error('The AI answer is missing required information.');
    }
    if (data.status !== 'solved') return { data, plan: [] };
    if (data.answers.length !== task.elements.length) throw new Error('The AI did not answer every field. Nothing was filled in.');
    const seen = new Set();
    const plan = data.answers.map(answer => {
      const i = task.payload.fields.findIndex(field => field.field === answer?.field);
      if (i < 0 || seen.has(i)) throw new Error('The AI named an unknown or duplicate field.');
      seen.add(i);
      const element = task.elements[i];
      let value = answer.value;
      if (['radio', 'checkbox'].includes(element.type)) {
        if (value === 'true' || value === 'false') value = value === 'true';
        if (typeof value !== 'boolean') throw new Error('A choice from the AI must be true or false.');
      } else {
        if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
        if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error('A result field has no valid value.');
        value = value.trim();
        if (element.tagName === 'SELECT') {
          const exact = [...element.options].find(option => !option.disabled && option.value === value);
          const labels = [...element.options].filter(option => !option.disabled && option.textContent.trim() === value);
          if (exact) value = exact.value;
          else if (labels.length === 1) value = labels[0].value;
          else throw new Error('The AI suggested an option that does not exist.');
        } else if (/^[+-]?\d+\.\d+$/.test(value) && element.type !== 'number') value = value.replace('.', ',');
        if (element.type === 'number') {
          value = value.replace(',', '.');
          if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error('The number field needs a number.');
        }
        if (element.maxLength > 0 && value.length > element.maxLength) throw new Error('The result is longer than the field allows.');
      }
      return { element, value, field: answer.field };
    });
    const radios = new Map();
    for (const item of plan) if (item.element.type === 'radio' && item.element.name && item.value) {
      const count = (radios.get(item.element.name) || 0) + 1;
      radios.set(item.element.name, count);
      if (count > 1) throw new Error('The AI picked several answers in the same choice group.');
    }
    return { data, plan };
  }

  function applyPlan(task, plan) {
    const current = snapshot();
    if (current.body !== task.body || current.fingerprint !== task.fingerprint || current.elements.some((element, i) => element !== task.elements[i])) {
      throw new Error('The task has changed. Start a new request for the new task.');
    }
    if (current.values.some(([value, checked], i) => value !== task.values[i][0] || checked !== task.values[i][1])) {
      throw new Error('You changed a field during the request. Start again so that your input is kept.');
    }
    // Write only after complete validation; no AI answer is ever executed as code.
    for (const { element, value } of [...plan].sort((a, b) => Number(a.value === true) - Number(b.value === true))) {
      const checkbox = ['radio', 'checkbox'].includes(element.type);
      const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, checkbox ? 'checked' : 'value').set.call(element, value);
    }
    for (const { element } of plan) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    task.values = task.elements.map(element => [element.value, element.checked]);
  }

  const errorText = error => error?.message || 'The request failed. Check your connection and try again later.';
  const notice = text => (window.mathegymMessage ? window.mathegymMessage(text, { ai: false }) : alert(text));

  window.mathegymOpenAI = function ({ autoSolve = false } = {}) {
    const old = document.getElementById(AI_HOST);
    if (old) { old.mathegymRefresh?.(autoSolve); return; }
    if (window.mathegymAIRequestPending) { notice('The previous AI request is still running. Please wait for it to finish.'); return; }
    let initial;
    try { initial = snapshot(); } catch (error) { notice(error.message); return; }
    document.getElementById('mathegym-helper-status')?.remove();
    const host = document.createElement('aside');
    host.mathegymAutoSolve = autoSolve;
    host.id = AI_HOST;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;width:min(430px,calc(100vw - 32px));max-height:85vh;';
    host.setAttribute('data-html2canvas-ignore', 'true');
    const root = host.attachShadow({ mode: 'open' });
    const setup = extension
      ? '<button type="button" id="settings" class="primary">Open settings</button>'
      : '<label>API key<input type="password" id="key" autocomplete="off" spellcheck="false"></label><button type="button" id="save-key" class="primary">Save key</button><p class="small">The key is only stored in this browser for mathegym.de. The extension is more secure.</p>';
    root.innerHTML = `<style>
      :host{font:15px/1.45 system-ui,sans-serif;color:#19323b}*{box-sizing:border-box}.panel{background:#fff;border:2px solid #5c7b85;border-radius:12px;padding:18px;box-shadow:0 8px 32px #0003;max-height:85vh;overflow:auto}h2{font-size:20px;margin:0}p{margin:10px 0}.row{display:flex;gap:8px;align-items:center;justify-content:space-between}button,select{font:inherit;padding:9px 11px;border:1px solid #9daeb4;border-radius:6px;background:#f4f7f8;color:#19323b;cursor:pointer}button:disabled{opacity:.6;cursor:default}.primary{background:#c85000;color:#fff;border-color:#c85000}label{display:block;margin:10px 0}select{width:100%}input[type=checkbox]{margin-right:8px}input[type=file]{max-width:100%}input[type=password]{display:block;width:100%;margin-top:4px;font:14px ui-monospace,monospace;padding:8px;border:1px solid #9daeb4;border-radius:6px}.note{background:#fff4ec;border:1px solid #f0c9ab;border-radius:8px;padding:4px 12px 12px}.small{font-size:12px;color:#536a73}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0;padding:12px;background:#eff4f5;border-radius:6px}.status{white-space:pre-wrap;margin:12px 0}a{color:#245d73}
      </style><section class="panel" aria-label="Mathegym AI Helper">
      <div class="row"><h2>Mathegym AI Helper</h2><button type="button" id="close" aria-label="Close helper">×</button></div>
      <p>The AI solves the current task and maps its answers to the fields.</p>
      <div class="note" id="setup" hidden><p><strong>One-time setup:</strong> The free AI needs an API key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.</p>${setup}</div>
      <label>Model<select id="model"><option value="">Automatic (best free model)</option></select></label>
      <label><input type="checkbox" id="image">Send task image</label>
      <details><summary>Use your own screenshot</summary><p class="small">If graphics are incomplete, you can pick an image of the task area here.</p><input type="file" id="file" accept="image/png,image/jpeg,image/webp"><button type="button" id="clear-file">Remove image</button></details>
      <label><input type="checkbox" id="auto" checked>Fill in results automatically</label>
      <button type="button" id="solve" class="primary" disabled>Solve with free AI</button>
      <div class="status" id="status" role="status"></div>
      <pre id="result" hidden></pre><button type="button" id="apply" hidden>Fill in results</button>
      <p class="small" id="usage"></p>
      <p class="small">AI results can be wrong. You click "Ergebnis prüfen" yourself.${shortcut ? ' Shortcut: Alt+L.' : ''}</p>
      </section>`;
    document.body.append(host);
    const $ = id => root.getElementById(id);
    const status = text => { $('status').textContent = text; };
    const needKey = 'Add your free API key once and you are ready to go.';
    let busy = false, ready = false, loaded = false, keyProblem = false;
    let solvedTask, solvedPlan;

    function buttons() {
      $('solve').disabled = busy || !ready;
      $('model').disabled = busy;
      $('apply').disabled = busy;
      $('setup').hidden = !loaded || (ready && !keyProblem);
      if ($('save-key')) $('save-key').disabled = busy;
    }

    function fillModels(models) {
      const select = $('model');
      const current = select.value;
      select.replaceChildren(new Option('Automatic (best free model)', ''),
        ...models.map(model => new Option(`${model.name}${model.exhausted ? ' – daily limit reached' : ''}`, model.id)));
      select.value = models.some(model => model.id === current) ? current : '';
    }

    async function refresh() {
      try {
        const info = await backend.status();
        ready = !!info.hasKey;
        fillModels(Array.isArray(info.models) ? info.models : []);
      } catch (error) {
        ready = false;
        status(errorText(error));
      }
      loaded = true;
      buttons();
    }

    // Once the key is added, continue the solution that a field button asked for.
    async function keyChanged() {
      if (!host.isConnected) { notifyPanel = null; return; }
      keyProblem = false;
      await refresh();
      if (busy) return;
      if (!ready) { status(needKey); return; }
      if (host.mathegymAutoSolve) $('solve').click();
      else status('Key saved. Ready for the current task.');
    }
    notifyPanel = keyChanged;

    $('image').checked = initial.graphics;
    $('close').onclick = () => { host.remove(); notifyPanel = null; };
    $('clear-file').onclick = () => { $('file').value = ''; };
    if (extension) $('settings').onclick = () => backend.settings().catch(error => status(errorText(error)));
    else $('save-key').onclick = async () => {
      if (busy) return;
      busy = true; buttons();
      status('Checking the key with Google …');
      try {
        await backend.saveKey($('key').value.trim());
        $('key').value = '';
      } catch (error) {
        busy = false; buttons();
        status(errorText(error));
        return;
      }
      // From here on, a continued solution may take over the state.
      busy = false;
      await keyChanged();
    };

    $('apply').onclick = () => {
      try { applyPlan(solvedTask, solvedPlan); $('apply').hidden = true; status('Results filled in. Check the working and click "Ergebnis prüfen" yourself.'); }
      catch (error) { status(errorText(error)); }
    };

    $('solve').onclick = async () => {
      if (busy || !ready || window.mathegymAIRequestPending) return;
      host.mathegymAutoSolve = false;
      busy = true; window.mathegymAIRequestPending = true; buttons();
      $('result').hidden = $('apply').hidden = true;
      try {
        const task = snapshot();
        let image;
        const file = $('file').files[0];
        if (file) image = await readFile(file);
        else if ($('image').checked) {
          status('Capturing the task area …');
          image = await taskImage(task);
        }
        if (!host.isConnected) return;
        status('The free AI is working …');
        const result = await backend.solve({ payload: task.payload, image, model: $('model').value });
        if (!host.isConnected) return;
        const skipped = (result.skipped || []).map(item => `${item.name} (${REASONS[item.reason] || item.reason})`);
        $('usage').textContent = `Answered by ${result.name} · ${result.used} ${result.used === 1 ? 'request' : 'requests'} with this model today${skipped.length ? ` · skipped: ${skipped.join(', ')}` : ''}`;
        const { data, plan } = parseResponse(result.data, task);
        $('result').textContent = data.explanation;
        $('result').hidden = false;
        if (data.status !== 'solved') { status(data.status === 'uncertain' ? 'The AI is not sure. Nothing was filled in.' : 'The AI cannot fill in this task type automatically.'); return; }
        if (!plan.length) { status('Solution shown. This task has no fields that can be filled in automatically.'); return; }
        solvedTask = task; solvedPlan = plan;
        $('result').textContent += '\n\n' + plan.map(item => `${item.field.replace('FIELD_', 'Field ')}: ${item.value === true ? 'selected' : item.value === false ? 'not selected' : item.value}`).join('\n');
        if ($('auto').checked) { applyPlan(task, plan); status('Results filled in. Check the working and click "Ergebnis prüfen" yourself.'); }
        else { $('apply').hidden = false; status('Solution ready. You can fill in the results now.'); }
      } catch (error) {
        if (!host.isConnected) return;
        if (['key', 'nokey', 'permission'].includes(error.reason)) keyProblem = true;
        status(errorText(error));
      } finally {
        busy = false; window.mathegymAIRequestPending = false; buttons();
        if (host.isConnected) refresh();
      }
    };

    host.mathegymRefresh = requestSolve => {
      if (busy) return;
      try {
        const current = snapshot();
        if (current.fingerprint !== initial.fingerprint) {
          initial = current;
          $('image').checked = current.graphics;
          $('result').hidden = $('apply').hidden = true;
          $('usage').textContent = '';
          status('Ready for the new task.');
        }
        if (requestSolve) host.mathegymAutoSolve = true;
        if (requestSolve && ready) $('solve').click();
        else if (requestSolve && loaded) status(needKey);
      } catch (error) { status(errorText(error)); }
    };

    status('Preparing AI …');
    refresh().then(() => {
      if (!host.isConnected || busy) return;
      if (!ready) status(needKey);
      else if (host.mathegymAutoSolve) $('solve').click();
      else status('Ready for the current task.');
    });
  };
})();
