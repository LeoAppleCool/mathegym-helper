// Tests the AI panel in bookmarklet mode. The Gemini API is simulated in the browser:
// no real key and no real requests to Google. Task texts imitate the German Mathegym pages.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(__dirname);
const bookmarklet = fs.readFileSync(path.join(root, 'bookmarklet.txt'), 'utf8').trim();
const source = decodeURIComponent(bookmarklet.slice('javascript:'.length));
const KEY = 'AIzaTestKey_1234567890abcdef';
const CATALOG = ['gemma-4-31b-it', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it'];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-goog-api-key', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

const catalog = [200, { models: CATALOG.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }];
const reply = data => [200, { candidates: [{ content: { parts: [{ text: typeof data === 'string' ? data : JSON.stringify(data) }] }, finishReason: 'STOP' }] }];
const dayLimit = () => [429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }];
const modelOf = call => (/models\/([^:]+):generateContent/.exec(call.url) || [])[1];
const promptOf = call => call.body.contents[0].parts[0].text;
// Catalog plus the same answer for every model; single models can be overridden.
const fixed = (data, overrides = {}) => call => call.url.includes('/models?') ? catalog : (overrides[modelOf(call)] || (() => reply(data)))(call);
const solved = answers => ({ status: 'solved', answers, explanation: 'Short, verifiable working.' });
const field = value => `<input id="one" class="ergebniseingabe" value="${value}">`;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let checks = 0;
  const ok = name => { checks++; console.log('OK: ' + name); };
  try {
    const page = await browser.newPage();
    let html = '';
    let api;
    let calls = [];
    let visit = 0;
    await page.route('https://mathegym.de/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.route('https://generativelanguage.googleapis.com/**', async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const call = { url: request.url(), headers: request.headers(), body: request.postData() ? JSON.parse(request.postData()) : null };
      calls.push(call);
      const [status, body] = await api(call);
      return route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    });

    async function setup(task, handler, { key = KEY, autoSolve = false } = {}) {
      html = `<html><head></head><body><div id="secret">Username, progress and token outside the task</div><div id="ex-instruction">Berechne.</div><form id="form"><div id="exBody">${task}</div><button type="submit">Ergebnis prüfen</button></form></body></html>`;
      api = handler;
      calls = [];
      await page.goto(`https://mathegym.de/mathe/test-${++visit}`);
      await page.evaluate(key => {
        localStorage.clear();
        if (key) localStorage.setItem('mathegym-helper-key', key);
        window.submits = 0; window.changes = [];
        document.getElementById('form').onsubmit = event => { event.preventDefault(); window.submits++; };
        const body = document.getElementById('exBody');
        body.addEventListener('input', event => window.changes.push(['input', event.target.id]));
        body.addEventListener('change', event => window.changes.push(['change', event.target.id]));
      }, key);
      await page.evaluate(source);
      await page.evaluate(autoSolve => window.mathegymOpenAI({ autoSolve }), autoSolve);
      await page.getByRole('button', { name: 'Solve with free AI', exact: true }).waitFor();
    }
    const panel = () => page.locator('#mathegym-helper-ai');
    const status = () => panel().locator('#status').innerText();
    const solve = async () => {
      await page.getByRole('button', { name: 'Solve with free AI', exact: true }).click();
      await page.waitForFunction(() => !window.mathegymAIRequestPending);
    };
    const shadowText = (selector, text) => page.waitForFunction(([selector, text]) =>
      document.getElementById('mathegym-helper-ai')?.shadowRoot.querySelector(selector)?.textContent.includes(text), [selector, text]);

    await setup(`Ein Lehrer hat 48 Bücher. Drei Viertel sind Schulbücher: ${field('')}`, fixed(solved([{ field: 'FIELD_1', value: '36' }])));
    await solve();
    assert.equal(await page.locator('#one').inputValue(), '36');
    assert.equal(await page.evaluate(() => window.submits), 0);
    const request = calls.find(modelOf);
    assert.equal(modelOf(request), 'gemma-4-31b-it');
    assert.equal(request.headers['x-goog-api-key'], KEY);
    assert(!request.url.includes(KEY));
    assert(promptOf(request).includes('[FIELD_1]'));
    assert(!promptOf(request).includes('Username, progress'));
    assert(!promptOf(request).includes('Solve'));
    assert.deepEqual(await page.evaluate(() => window.changes), [['input', 'one'], ['change', 'one']]);
    assert.match(await panel().locator('#usage').innerText(), /Answered by Gemma 4 31B · 1 request with this model today/);
    ok('Text task: field mapping, Gemma 4 31B, key only in the header, events, no submit, no unrelated page data');

    await setup('Zähler: <input id="top" class="ergebniseingabe"> Nenner: <input id="bottom" class="ergebniseingabe">', fixed(solved([{ field: 'FIELD_2', value: '4' }, { field: 'FIELD_1', value: '3' }])));
    await solve();
    assert.equal(await page.locator('#top').inputValue(), '3');
    assert.equal(await page.locator('#bottom').inputValue(), '4');
    ok('Several fields are mapped by their field IDs');

    await setup('a) <input id="one" type="number"> b) <input id="two" type="text"> c) <input id="three">', fixed(solved([{ field: 'FIELD_1', value: '2,5' }, { field: 'FIELD_2', value: '2.5' }, { field: 'FIELD_3', value: 0.75 }])));
    await solve();
    assert.equal(await page.locator('#one').inputValue(), '2.5');
    assert.equal(await page.locator('#two').inputValue(), '2,5');
    assert.equal(await page.locator('#three').inputValue(), '0,75');
    ok('Decimal format for number and text fields, even when the AI returns a JSON number');

    await setup('Antwort: <select id="choice"><option value="a">Ein Halb</option><option value="b">Ein Viertel</option></select> Erklärung: <textarea id="explain"></textarea>', fixed(solved([{ field: 'FIELD_1', value: 'Ein Viertel' }, { field: 'FIELD_2', value: '1/4' }])));
    await solve();
    assert.equal(await page.locator('#choice').inputValue(), 'b');
    assert.equal(await page.locator('#explain').inputValue(), '1/4');
    ok('Select field and textarea');

    const choices = '<label><input id="a" type="radio" name="group" value="a">A</label><label><input id="b" type="radio" name="group" value="b">B</label><label><input id="c" type="checkbox">C</label>';
    await setup(choices, fixed(solved([{ field: 'FIELD_1', value: 'false' }, { field: 'FIELD_2', value: true }, { field: 'FIELD_3', value: 'true' }])));
    await solve();
    assert.equal(await page.locator('#a').isChecked(), false);
    assert.equal(await page.locator('#b').isChecked(), true);
    assert.equal(await page.locator('#c').isChecked(), true);
    ok('Radio group and checkbox, also with "true"/"false" as text');

    const invalidKey = () => [400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }];
    for (const [name, handler, expected] of [
      ['Uncertainty', fixed({ status: 'uncertain', answers: [], explanation: 'Unclear.' }), /not sure/],
      ['Unknown field', fixed(solved([{ field: 'FIELD_999', value: '36' }])), /unknown or duplicate field/],
      ['Missing field', fixed(solved([])), /did not answer every field/],
      ['Invalid JSON from every model', fixed('No JSON answer'), /not in a valid result format/],
      ['All daily limits reached', call => call.url.includes('/models?') ? catalog : dayLimit(), /reached their daily limit/],
      ['Invalid key', invalidKey, /API key is invalid/]
    ]) {
      await setup(`Textaufgabe: ${field('bestehend')}`, handler);
      await solve();
      assert.equal(await page.locator('#one').inputValue(), 'bestehend', name);
      assert.equal(await page.evaluate(() => window.submits), 0);
      assert.match(await status(), expected, name);
      if (name === 'Invalid key') assert(await panel().locator('#setup').isVisible(), 'With an invalid key the setup is shown again.');
      ok(name + ': existing input is kept, clear message');
    }

    await setup('Antwort: <input id="one"> und <input id="two">', fixed(solved([{ field: 'FIELD_1', value: '36' }, { field: 'FIELD_1', value: '37' }])));
    await solve();
    assert.equal(await page.locator('#one').inputValue(), '');
    assert.equal(await page.locator('#two').inputValue(), '');
    ok('A duplicate field mapping prevents all writes');

    await setup(`Textaufgabe: ${field('')}`, fixed(solved([{ field: 'FIELD_1', value: '36' }])));
    await panel().locator('#auto').uncheck();
    await solve();
    assert.equal(await page.locator('#one').inputValue(), '');
    await page.getByRole('button', { name: 'Fill in results', exact: true }).click();
    assert.equal(await page.locator('#one').inputValue(), '36');
    ok('Optional manual filling of the results');

    for (const mutation of ['task', 'input', 'close']) {
      let release, reached;
      const gate = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { reached = resolve; });
      await setup(`Textaufgabe: ${field('')}`, async call => {
        if (call.url.includes('/models?')) return catalog;
        reached();
        await gate;
        return reply(solved([{ field: 'FIELD_1', value: '36' }]));
      });
      await page.getByRole('button', { name: 'Solve with free AI', exact: true }).click();
      await started;
      await page.evaluate(mutation => {
        if (mutation === 'task') document.getElementById('ex-instruction').textContent = 'Neue Aufgabe';
        if (mutation === 'input') document.getElementById('one').value = 'my input';
        if (mutation === 'close') document.getElementById('mathegym-helper-ai').remove();
      }, mutation);
      release();
      await page.waitForFunction(() => !window.mathegymAIRequestPending);
      assert.equal(await page.locator('#one').inputValue(), mutation === 'input' ? 'my input' : '');
      ok('A late answer after ' + mutation + ' is not filled in');
    }

    await setup(`Textaufgabe: ${field('')}`, fixed(solved([{ field: 'FIELD_1', value: '36' }])), { key: '', autoSolve: true });
    await panel().locator('#setup').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Solve with free AI', exact: true }).isDisabled(), true);
    assert.match(await status(), /API key/);
    await panel().locator('#key').fill('wrong');
    await panel().getByRole('button', { name: 'Save key', exact: true }).click();
    await shadowText('#status', 'does not look like an API key');
    assert.equal(calls.length, 0);
    await panel().locator('#key').fill(KEY);
    await panel().getByRole('button', { name: 'Save key', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('one').value === '36');
    assert.equal(await page.evaluate(() => localStorage.getItem('mathegym-helper-key')), KEY);
    assert(calls[0].url.includes('/models?'), 'The key is checked with Google before it is saved.');
    assert(await panel().locator('#setup').isHidden());
    ok('Bookmarklet without a key: verify and save the key in the panel, the requested solution continues');

    await setup(`<svg width="120" height="120"><circle cx="60" cy="60" r="40" fill="orange"/></svg> Fläche: ${field('')}`, fixed(solved([{ field: 'FIELD_1', value: '16' }])));
    await page.evaluate(() => {
      window.html2canvas = async element => { window.capturedArea = element.id; const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100; canvas.getContext('2d').fillRect(0, 0, 100, 100); return canvas; };
    });
    assert.equal(await panel().locator('#image').isChecked(), true);
    await solve();
    assert.equal(await page.evaluate(() => window.capturedArea), 'exBody');
    const imagePart = calls.find(modelOf).body.contents[0].parts[1];
    assert.equal(imagePart.inlineData.mimeType, 'image/png');
    assert.match(imagePart.inlineData.data, /^[A-Za-z0-9+/=]{20,}$/);
    assert.equal(await page.locator('#one').inputValue(), '16');
    ok('Task with a graphic: an image of only the task area is sent as inlineData');

    await setup(`Textaufgabe: ${field('')}`, fixed(solved([{ field: 'FIELD_1', value: '36' }]), { 'gemma-4-31b-it': dayLimit }));
    await solve();
    assert.equal(await page.locator('#one').inputValue(), '36');
    assert.deepEqual(calls.filter(modelOf).map(modelOf), ['gemma-4-31b-it', 'gemini-3.5-flash-lite']);
    assert.match(await panel().locator('#usage').innerText(), /Answered by Gemini 3\.5 Flash-Lite.*skipped: Gemma 4 31B \(daily limit\)/);
    await shadowText('#model', 'Gemma 4 31B – daily limit reached');
    ok('Daily limit: automatic switch to the next free model, shown in the panel');

    await setup(`Textaufgabe: ${field('')}`, fixed(solved([{ field: 'FIELD_1', value: '36' }])));
    await solve();
    await panel().locator('#model').selectOption('gemma-4-26b-a4b-it');
    await page.evaluate(() => { document.getElementById('one').value = ''; });
    calls = [];
    await solve();
    assert.deepEqual(calls.filter(modelOf).map(modelOf), ['gemma-4-26b-a4b-it']);
    ok('The chosen model is asked first');

    const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
    const bundle = files => `(()=>{window.mathegymInstallOnly=true;try{\n${files.map(read).join('\n')}\n}finally{delete window.mathegymInstallOnly;}})();`;
    assert.equal(source, bundle(['gemini.js', 'ai-panel.js', 'local-solver.js', 'field-buttons.js']));
    await page.setContent(fs.readFileSync(path.join(root, 'install.html'), 'utf8'));
    assert.equal(await page.locator('a.bookmark').getAttribute('href'), bookmarklet);
    assert.equal(await page.locator('#code').inputValue(), bookmarklet);
    ok('Shipped bookmarklet, source code and copyable code match');
    console.log(`${checks} AI panel checks passed (Gemini API simulated, no real key).`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
