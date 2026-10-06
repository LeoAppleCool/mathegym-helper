// Tests the real extension in Edge, loaded from the release zip: buttons, local solver, settings page
// and background script. The Gemini API is simulated: no real key and no real requests to Google.
// Task texts imitate the German Mathegym pages.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.dirname(__dirname);
const KEY = 'AIzaTestKey_1234567890abcdef';
const CATALOG = ['gemma-4-31b-it', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it'];

(async () => {
  // Extract the release zip with the system tools, exactly as users would get it.
  const zipFile = path.join(root, 'release', 'mathegym-helper-extension.zip');
  const extension = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mathegym-release-')), 'mathegym-helper-extension');
  fs.mkdirSync(extension);
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zipFile, '-C', extension]);
  else execFileSync('unzip', ['-q', zipFile, '-d', extension]);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mathegym-buttons-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  let checks = 0;
  const ok = name => { checks++; console.log('OK: ' + name); };
  const until = async (condition, message) => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 100))) {
      const value = await condition();
      if (value) return value;
    }
    throw new Error(message);
  };
  try {
    const built = path.join(root, 'extension');
    assert.deepEqual(fs.readdirSync(extension).sort(), fs.readdirSync(built).sort());
    for (const file of fs.readdirSync(built)) assert(fs.readFileSync(path.join(extension, file)).equals(fs.readFileSync(path.join(built, file))), file);
    ok('The release zip contains exactly the built extension');

    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    const welcome = await until(() => context.pages().find(p => p.url().startsWith(optionsUrl)), 'The settings page did not open after installation.');
    await welcome.getByRole('heading', { name: 'Set up the free AI' }).waitFor();
    await welcome.close();
    ok('Without a key, the settings page opens after installation');

    const page = await context.newPage();
    const fixture = (amount = '1/2', from = 'dm', to = 'cm') => `<div id="ex-instruction">Berechne den Bruchteil.</div><form id="form"><div id="exBody"><table><tr><td>${amount} ${from} =</td><td><input id="answer" class="ergebniseingabe"></td><td id="unit"><div id="unit-label">${to}</div></td></tr></table></div><button type="submit">Ergebnis prüfen</button></form>`;
    let html = fixture();
    let apiCalls = [];
    await context.route('https://mathegym.de/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await context.route('https://generativelanguage.googleapis.com/**', route => {
      const request = route.request();
      const call = { url: request.url(), headers: request.headers(), body: request.postData() ? JSON.parse(request.postData()) : null };
      apiCalls.push(call);
      if (call.url.includes('/models?')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: CATALOG.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }) });
      }
      const payload = JSON.parse(call.body.contents[0].parts.map(part => part.text || '').join('').split('TASK DATA:\n')[1]);
      const answers = payload.fields.map((field, i) => ({ field: field.field, value: payload.task.startsWith('12 · 7') ? '84' : String(7 + i) }));
      const text = JSON.stringify({ status: 'solved', answers, explanation: 'Simulated AI working.' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) });
    });
    const generateCalls = () => apiCalls.filter(call => call.url.includes(':generateContent'));
    const solveButton = () => page.getByRole('button', { name: 'Solve current task', exact: true });

    await page.goto('https://mathegym.de/mathe/test-one');
    await page.locator('[data-mathegym-action]').waitFor();
    assert.equal(await page.locator('#unit [data-mathegym-action]').count(), 1);
    assert.equal(await page.locator('#unit-label > [data-mathegym-action]').count(), 1);
    assert.equal(await page.locator('#answer').inputValue(), '');
    await page.evaluate(() => { window.submits = 0; document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submits++; }; });
    await solveButton().click();
    assert.equal(await page.locator('#answer').inputValue(), '5');
    assert.equal(await page.evaluate(() => window.submits), 0);
    assert.equal(apiCalls.length, 0);
    ok('The extension adds the button after "cm"; 1/2 dm = 5 cm is solved locally on click, without AI request or submit');

    await page.evaluate(() => {
      document.getElementById('exBody').innerHTML = '<table><tr><td>2 1/4 kg =</td><td><input id="next" class="ergebniseingabe"></td><td id="unit">g</td></tr></table>';
    });
    await page.locator('#unit [data-mathegym-action]').waitFor();
    assert.equal(await page.locator('[data-mathegym-action]').count(), 1);
    await solveButton().click();
    assert.equal(await page.locator('#next').inputValue(), '2250');
    ok('Button after the task content is replaced, without clicking the bookmarklet again');

    await page.evaluate(() => {
      document.getElementById('exBody').outerHTML = '<div id="exBody">3/4 h = <input id="replacement" class="ergebniseingabe"> min</div>';
    });
    await page.waitForFunction(() => document.querySelector('#exBody [data-mathegym-action]'));
    await solveButton().click();
    assert.equal(await page.locator('#replacement').inputValue(), '45');
    ok('Button also after the whole task area is replaced');

    await page.evaluate(() => document.querySelector('[data-mathegym-action]').remove());
    await page.waitForFunction(() => document.querySelector('[data-mathegym-action]'));
    assert.equal(await page.locator('[data-mathegym-action]').count(), 1);
    ok('A button removed by the page is added again');

    await page.evaluate(() => document.getElementById('replacement').readOnly = true);
    await page.waitForFunction(() => !document.querySelector('[data-mathegym-action]'));
    await page.evaluate(() => document.getElementById('replacement').readOnly = false);
    await page.waitForFunction(() => document.querySelector('[data-mathegym-action]'));
    ok('Whether the field is writable is respected');

    await page.evaluate(() => { document.getElementById('replacement').value = ''; });
    await page.locator('#replacement').focus();
    await page.keyboard.press('Alt+KeyL');
    await page.waitForFunction(() => document.getElementById('replacement').value === '45');
    ok('The Alt+L shortcut solves the current task');

    html = fixture('1/4', 'kg', 'g');
    await page.goto('https://mathegym.de/mathe/test-two');
    await page.locator('[data-mathegym-action]').waitFor();
    await solveButton().click();
    assert.equal(await page.locator('#answer').inputValue(), '250');
    await page.reload();
    await page.locator('[data-mathegym-action]').waitFor();
    assert.equal(await page.locator('#answer').inputValue(), '');
    ok('The extension starts automatically after navigation and reload, without solving on its own');

    const bookmark = fs.readFileSync(path.join(root, 'bookmarklet.txt'), 'utf8').trim();
    await page.evaluate(decodeURIComponent(bookmark.slice(11)));
    await page.evaluate(decodeURIComponent(bookmark.slice(11)));
    assert.equal(await page.locator('[data-mathegym-action]').count(), 1);
    assert.equal(await page.locator('#answer').inputValue(), '');
    assert.match(await page.locator('#mathegym-helper-status').innerText(), /already active/);
    ok('The bookmarklet detects the active extension and creates no duplicate buttons');

    html = '<div id="ex-instruction">Löse x + 2 = 9.</div><div id="exBody">x = <input id="ai" class="ergebniseingabe"></div>';
    await page.goto('https://mathegym.de/mathe/ai-task');
    await page.locator('[data-mathegym-action]').waitFor();
    await solveButton().click();
    const panel = page.locator('#mathegym-helper-ai');
    await panel.locator('#setup').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Solve with free AI', exact: true }).isDisabled(), true);
    const [options] = await Promise.all([context.waitForEvent('page'), panel.getByRole('button', { name: 'Open settings', exact: true }).click()]);
    await options.waitForURL(optionsUrl);
    await options.locator('#key').fill('too short');
    await options.getByRole('button', { name: 'Save and verify', exact: true }).click();
    await options.locator('#status.bad').waitFor();
    await options.locator('#key').fill(KEY);
    await options.getByRole('button', { name: 'Save and verify', exact: true }).click();
    await options.locator('#status.ok').waitFor();
    assert.match(await options.locator('#status').innerText(), /3 free models available, starting with Gemma 4 31B/);
    await page.waitForFunction(() => document.getElementById('ai').value === '7');
    assert.equal(generateCalls().length, 1);
    const request = generateCalls()[0];
    assert.equal(request.headers['x-goog-api-key'], KEY);
    const payload = JSON.parse(request.body.contents[0].parts[0].text.split('TASK DATA:\n')[1]);
    assert(!payload.task.includes('Solve'));
    assert(await panel.locator('#setup').isHidden());
    ok('Without a key: open the settings from the panel, verify and save the key, the solution continues automatically');

    const exposed = await page.evaluate(key => [
      typeof chrome !== 'undefined' && !!chrome.storage,
      JSON.stringify(localStorage).includes(key),
      document.documentElement.outerHTML.includes(key),
      document.getElementById('mathegym-helper-ai').shadowRoot.innerHTML.includes(key)
    ], KEY);
    assert.deepEqual(exposed, [false, false, false, false]);
    ok('Mathegym can see the key neither in storage nor in the DOM');

    await page.evaluate(() => {
      document.getElementById('ex-instruction').textContent = 'Löse die neue Aufgabe.';
      document.getElementById('exBody').innerHTML = 'a = <input id="ai-new" class="ergebniseingabe"> und b = <input id="ai-two" class="ergebniseingabe">';
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-mathegym-action]').length === 2);
    await solveButton().first().click();
    await page.waitForFunction(() => document.getElementById('ai-new').value === '7' && document.getElementById('ai-two').value === '8');
    assert.equal(generateCalls().length, 2);
    assert.match(await panel.locator('#usage').innerText(), /Answered by Gemma 4 31B · 2 requests with this model today/);
    ok('An open AI panel solves the new fields with one click after the task changes');

    await options.reload();
    await options.locator('#models tr').first().waitFor();
    assert.deepEqual(await options.locator('#models tr').first().locator('td').allInnerTexts(), ['Gemma 4 31B', '2', 'available']);
    assert.match(await options.locator('#version').innerText(), /^\d+\.\d+\.\d+$/);
    await options.getByRole('button', { name: 'Run test task', exact: true }).click();
    await options.locator('#status.ok').waitFor();
    assert.match(await options.locator('#status').innerText(), /Test passed: Gemma 4 31B calculated 12 · 7 = 84/);
    ok('The settings page shows today\'s usage and the version, and runs a test task');

    let cdnRequests = 0;
    context.on('request', request => { if (!request.url().startsWith('chrome-extension://') && /html2canvas/.test(request.url())) cdnRequests++; });
    html = '<div id="ex-instruction">Berechne die Fläche.</div><div id="exBody"><svg width="120" height="60"><rect width="80" height="40" fill="orange"/></svg> Fläche: <input id="area" class="ergebniseingabe"> cm²</div>';
    await page.goto('https://mathegym.de/mathe/graphic');
    await page.locator('[data-mathegym-action]').waitFor();
    await solveButton().click();
    await page.waitForFunction(() => document.getElementById('area').value === '7');
    const imagePart = generateCalls().at(-1).body.contents[0].parts[1];
    assert.equal(imagePart?.inlineData?.mimeType, 'image/png');
    assert(imagePart.inlineData.data.length > 1000);
    assert.equal(cdnRequests, 0);
    ok('Task with a graphic: the bundled screenshot library creates the task image without a CDN');

    await options.getByRole('button', { name: 'Remove key', exact: true }).click();
    await options.locator('#status').filter({ hasText: 'removed' }).waitFor();
    assert.equal(await worker.evaluate(() => chrome.storage.local.get('apiKey').then(data => data.apiKey ?? null)), null);
    ok('The key can be removed again');

    html = '<h1>Login</h1><input id="username"><input type="password">';
    await page.goto('https://mathegym.de/login');
    await page.waitForFunction(() => document.documentElement.dataset.mathegymHelper === 'extension');
    assert.equal(await page.locator('[data-mathegym-action]').count(), 0);
    assert.equal(await page.locator('#mathegym-helper-ai').count(), 0);
    ok('No buttons or AI requests on login pages');

    const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
    const bundle = files => `(()=>{window.mathegymInstallOnly=true;try{\n${files.map(read).join('\n')}\n}finally{delete window.mathegymInstallOnly;}})();`;
    assert.equal(fs.readFileSync(path.join(built, 'content.js'), 'utf8'), bundle(['ai-panel.js', 'local-solver.js', 'field-buttons.js']));
    for (const file of ['gemini.js', 'background.js', 'options.html', 'options.js']) assert.equal(fs.readFileSync(path.join(built, file), 'utf8'), read(file), file);
    ok('The extension contains the current state of src/');
    console.log(`${checks} extension checks passed (Gemini API simulated, no real key).`);
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
