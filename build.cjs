// Builds the Chrome/Edge extension (extension/), the release zip, the bookmarklet and the install page from src/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const root = __dirname;
const { version, homepage } = require('./package.json');
const read = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const ZIP_NAME = 'mathegym-helper-extension.zip';
// A fixed asset name makes this link always point to the newest release.
const download = `${homepage}/releases/latest/download/${ZIP_NAME}`;
const contentModules = ['ai-panel.js', 'local-solver.js', 'field-buttons.js'];
// installOnly: only set up the buttons on load, do not solve right away.
const bundle = files => `(()=>{window.mathegymInstallOnly=true;try{\n${files.map(read).join('\n')}\n}finally{delete window.mathegymInstallOnly;}})();`;

// Minimal zip writer (deflate, UTF-8 names, fixed timestamp for reproducible builds).
function zip(entries) {
  const local = [], central = [];
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, compressed);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// The extension ships html2canvas; the bookmarklet loads the same file from the CDN with an integrity hash.
const html2canvasFile = path.join(root, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js');
if (!fs.existsSync(html2canvasFile)) throw new Error('html2canvas is missing. Run "npm install" first.');
const html2canvas = fs.readFileSync(html2canvasFile);
const integrity = 'sha384-' + crypto.createHash('sha384').update(html2canvas).digest('base64');
if (!read('ai-panel.js').includes(integrity)) throw new Error(`The html2canvas hash in src/ai-panel.js must be ${integrity}.`);

const bookmarklet = 'javascript:' + encodeURIComponent(bundle(['gemini.js', ...contentModules]));
fs.writeFileSync(path.join(root, 'bookmarklet.txt'), bookmarklet + '\n', 'utf8');

const manifest = {
  manifest_version: 3,
  name: 'Mathegym Helper',
  version,
  description: 'Solve buttons next to Mathegym result fields: local calculation and free AI (Gemma 4/Gemini via Google AI Studio).',
  homepage_url: homepage,
  permissions: ['storage'],
  host_permissions: ['https://generativelanguage.googleapis.com/*'],
  background: { service_worker: 'background.js' },
  options_ui: { page: 'options.html', open_in_tab: true },
  action: { default_title: 'Mathegym Helper: settings' },
  content_scripts: [{
    matches: ['https://mathegym.de/*', 'https://www.mathegym.de/*'],
    js: ['html2canvas.min.js', 'content.js'], run_at: 'document_idle'
  }]
};
const extensionFiles = {
  'manifest.json': JSON.stringify(manifest, null, 2) + '\n',
  'content.js': bundle(contentModules),
  'html2canvas.min.js': html2canvas,
  ...Object.fromEntries(['gemini.js', 'background.js', 'options.html', 'options.js'].map(file => [file, read(file)]))
};
const extensionDir = path.join(root, 'extension');
fs.mkdirSync(extensionDir, { recursive: true });
for (const [file, data] of Object.entries(extensionFiles)) fs.writeFileSync(path.join(extensionDir, file), data);
fs.mkdirSync(path.join(root, 'release'), { recursive: true });
fs.writeFileSync(path.join(root, 'release', ZIP_NAME), zip(Object.entries(extensionFiles).map(([file, data]) => [file, Buffer.from(data)])));

const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mathegym Helper with free AI</title>
<style>:root{--bg:#edf3f4;--card:#fff;--text:#1d343e;--note:#edf3f4;--link:#15536b;color-scheme:light}@media (prefers-color-scheme:dark){:root{--bg:#11191c;--card:#1a2529;--text:#e3ecee;--note:#24343a;--link:#7cc3dc;color-scheme:dark}}body{font:17px/1.65 system-ui,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:40px 16px}main{max-width:760px;margin:auto;background:var(--card);padding:32px;border-radius:16px}h1{line-height:1.2}h2{margin-top:32px;font-size:21px}a{color:var(--link)}.bookmark{display:inline-block;padding:12px 20px;background:#c85000;color:white;text-decoration:none;border-radius:7px;font-weight:700}textarea{width:100%;box-sizing:border-box;height:120px;font:13px/1.4 monospace;padding:12px}button{padding:10px 16px;margin:10px 0;font:inherit;cursor:pointer}.note{background:var(--note);padding:16px;border-radius:8px}li{margin-bottom:12px}code{overflow-wrap:anywhere}kbd{font:14px monospace;padding:1px 6px;border:1px solid currentColor;border-radius:4px}</style>
<main><h1>A Solve button right next to the field</h1>
<p>Next to every result field there is a <strong>Solve</strong> button, placed after the unit if there is one (for example after “cm”). A click or <kbd>Alt</kbd>+<kbd>L</kbd> solves the current task and fills in the result. Simple tasks are calculated locally, everything else is solved by a free AI from Google (Gemma 4 or Gemini). Nothing is ever submitted automatically; you click “Ergebnis prüfen” yourself.</p>
<h2>1. Install the extension (Chrome or Edge)</h2>
<ol><li>Download <a href="${download}">${ZIP_NAME}</a> and extract it (right-click → <strong>Extract All</strong>).</li><li>Open <strong>chrome://extensions</strong> in Chrome or <strong>edge://extensions</strong> in Edge by pasting the address into the address bar.</li><li>Turn on <strong>Developer mode</strong>.</li><li>Click <strong>Load unpacked</strong> and select the extracted folder <strong>mathegym-helper-extension</strong>. If you build the project yourself, select the <code>extension</code> folder.</li></ol>
<p class="note"><strong>Updating?</strong> Replace the folder with the new version, click <strong>Reload</strong> (↻) for Mathegym Helper on the extensions page and then reload the Mathegym page. The extension only runs on mathegym.de and additionally needs access to the Google Gemini API.</p>
<h2>2. Add a free API key</h2>
<ol><li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a> and click <strong>Create API key</strong>. It is free and needs no credit card; Google requires an account holder aged 18 or older.</li><li>The settings page of the extension opens automatically after installation. Otherwise click the extension icon in the toolbar (or the puzzle icon → Mathegym Helper).</li><li>Paste the key, click <strong>Save and verify</strong> and then <strong>Run test task</strong> to check it.</li></ol>
<p class="note"><strong>Free forever:</strong> Do not enable billing for the Google project. Then it can never cost money: when the daily quota of a model is used up, the helper automatically switches to the next free model (Gemma 4 31B, Gemini Flash-Lite, Gemma 4 26B, Gemini Flash). Together that is several thousand requests per day. The quotas reset at midnight Pacific time. <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noopener noreferrer">Limits at Google</a></p>
<h2>What data is sent?</h2>
<p>Only the current task instruction, the content of the task area and information about its result fields, plus optionally an image of this area or a screenshot you choose. The data goes directly to the Google Gemini API; according to its terms, Google does not use it for training for users in the EEA, Switzerland and the UK. The local solver sends nothing. In the extension the key is kept in extension storage, where Mathegym cannot read it.</p>
<h2>Limitations</h2>
<p>Not every task can be solved, even with AI, and AI results can be wrong. Unclear, incomplete or invalid AI answers are not filled in. The helper supports text fields, number fields, select fields, checkboxes and simple radio groups. Drawing, drag and drop and special formula editors are not operated automatically. Diagram images may be incomplete; in that case you can choose your own screenshot in the AI panel. If a task changes during an AI request, the old results are not filled in.</p>
<details><summary>Alternative: bookmarklet without the extension</summary>
<p><a class="bookmark" href="${bookmarklet}" onclick="event.preventDefault()">Solve Mathegym</a></p>
<ol><li>Show the bookmarks bar with <strong>Ctrl + Shift + B</strong>.</li><li>Drag the orange link <strong>Solve Mathegym</strong> to the bar, or use it to replace your old helper bookmark.</li><li>Open the Mathegym task and click the bookmark once. Then use the buttons next to the fields.</li></ol>
<p>With the bookmarklet you enter the key once in the AI panel. It is stored in the browser for mathegym.de, where scripts of the page can read it. After a full page change you have to click the bookmarklet again. The extension is more convenient and more secure.</p>
<details><summary>Create the bookmark manually</summary><p>Create any bookmark, edit it and replace its URL completely with this code. The leading <strong>javascript:</strong> is part of it.</p><textarea id="code" spellcheck="false" readonly>${bookmarklet}</textarea><button type="button" id="copy">Copy code</button><span id="status" role="status"></span></details>
</details>
<p><small>Version ${version} · Unofficial, not affiliated with Mathegym · Source code and updates: <a href="${homepage}">${homepage.replace('https://', '')}</a></small></p>
</main><script>document.getElementById('copy').onclick=async()=>{const code=document.getElementById('code');try{await navigator.clipboard.writeText(code.value);document.getElementById('status').textContent='Copied.'}catch{code.focus();code.select();document.getElementById('status').textContent='Selected – press Ctrl+C to copy.'}};</script></html>`;
fs.writeFileSync(path.join(root, 'install.html'), html, 'utf8');
console.log(`Built extension ${version}, release/${ZIP_NAME}, bookmarklet (${bookmarklet.length} characters) and install page.`);
