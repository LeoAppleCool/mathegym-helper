// Tests the Gemini client without a browser and without a real key: fetch is simulated.
process.env.TZ = 'Europe/Berlin';
const path = require('node:path');
const assert = require('node:assert/strict');
require(path.join(__dirname, '..', 'src', 'gemini.js'));
const gemini = globalThis.MathegymGemini;

const KEY = 'AIzaTestKey_1234567890abcdef';
const payload = { instruction: 'Calculate.', task: '12 · 7 = [FIELD_1]', fields: [{ field: 'FIELD_1', type: 'text', label: '' }] };
const solved = value => ({ status: 'solved', answers: [{ field: 'FIELD_1', value }], explanation: '12 · 7 = 84' });
const answer = (text, finishReason = 'STOP') => [200, { candidates: [{ content: { parts: [{ text: 'Reasoning', thought: true }, { text }] }, finishReason }] }];
const apiError = (status, error) => [status, { error }];
const quota = (perDay, retry = '0.01s') => apiError(429, {
  code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota.',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: perDay ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }
  ]
});
const catalog = ['gemma-4-31b-it', 'gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it'];

let calls = [];
let handler;
globalThis.fetch = async (url, options = {}) => {
  const call = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
  calls.push(call);
  const result = await handler(call);
  if (result instanceof Error) throw result;
  const [status, body] = result;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const memoryStore = (initial = {}) => {
  let state = structuredClone(initial);
  return { get: async () => structuredClone(state), set: async next => { state = structuredClone(next); }, peek: () => state };
};
const modelOf = call => (/models\/([^:]+):generateContent/.exec(call.url) || [])[1];
const generateCalls = () => calls.filter(modelOf);
// Replies per model; by default the model catalog returns three free models.
function api(replies, models = catalog) {
  const counters = {};
  handler = call => {
    if (call.url.includes('/models?')) return [200, { models: models.map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) }];
    const model = modelOf(call);
    const list = replies[model] || replies['*'];
    if (!list) return apiError(404, { code: 404, status: 'NOT_FOUND', message: 'not found' });
    const index = counters[model] = (counters[model] ?? -1) + 1;
    return typeof list === 'function' ? list(call, index) : list[Math.min(index, list.length - 1)];
  };
}
async function run(name, test) {
  calls = [];
  await test();
  console.log('OK: ' + name);
  checks++;
}
let checks = 0;

(async () => {
  await run('Model names and ranking of the free models', () => {
    assert.equal(gemini.modelName('gemma-4-31b-it'), 'Gemma 4 31B');
    assert.equal(gemini.modelName('gemma-4-26b-a4b-it'), 'Gemma 4 26B');
    assert.equal(gemini.modelName('gemini-3.5-flash-lite'), 'Gemini 3.5 Flash-Lite');
    assert.equal(gemini.modelName('gemini-3.8-flash'), 'Gemini 3.8 Flash');
    assert.equal(gemini.modelName('something-else'), 'something-else');
    assert.deepEqual(gemini.rank([
      'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it', 'gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemini-3.1-pro-preview',
      'gemini-3.8-flash-image', 'gemini-2.5-pro', 'gemma-3-27b-it', 'gemini-3.8-live', 'text-embedding-004', 'gemini-3.10-flash'
    ]), ['gemma-4-31b-it', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it', 'gemini-3.10-flash', 'gemini-3.8-flash', 'gemma-3-27b-it']);
  });

  await run('Quota day follows Pacific time, reset time is shown in local time', () => {
    assert.equal(gemini.quotaDay(new Date('2026-10-06T06:30:00Z')), '2026-10-05');
    assert.equal(gemini.quotaDay(new Date('2026-10-06T07:30:00Z')), '2026-10-06');
    assert.equal(gemini.resetTime(new Date('2026-10-06T10:00:00Z'), 'en-GB'), '09:00');
    assert.equal(gemini.resetTime(new Date('2026-12-01T10:00:00Z'), 'en-GB'), '09:00');
  });

  await run('Key format', () => {
    assert(gemini.validKey(KEY));
    assert(!gemini.validKey(''));
    assert(!gemini.validKey('short'));
    assert(!gemini.validKey('AIza with spaces 1234567890'));
  });

  await run('JSON is also read from Markdown, reasoning text and several objects', () => {
    const data = solved('84');
    assert.deepEqual(gemini.parseAnswer(JSON.stringify(data)), data);
    assert.deepEqual(gemini.parseAnswer('```json\n' + JSON.stringify(data) + '\n```'), data);
    assert.deepEqual(gemini.parseAnswer(`I calculate {12 · 7}. Draft: ${JSON.stringify(solved('80'))} Correction: ${JSON.stringify(data)} Done.`), data);
    const braces = { status: 'solved', answers: [{ field: 'FIELD_1', value: '{1; 2}' }], explanation: 'Set "{" and }' };
    assert.deepEqual(gemini.parseAnswer(`Answer: ${JSON.stringify(braces)}`), braces);
    assert.equal(gemini.parseAnswer('No JSON answer'), null);
    assert.equal(gemini.parseAnswer('{"status":"done","answers":[],"explanation":""}'), null);
    assert.equal(gemini.parseAnswer('{"status":"solved","answers":[]'), null);
  });

  await run('Successful Gemma request: key in header, system instruction, reasoning, image', async () => {
    api({ 'gemma-4-31b-it': [answer(JSON.stringify(solved('84')))] });
    const store = memoryStore();
    const result = await gemini.solve({ key: KEY, store, payload, image: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.deepEqual(result.data, solved('84'));
    assert.equal(result.model, 'gemma-4-31b-it');
    assert.equal(result.name, 'Gemma 4 31B');
    assert.equal(result.used, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1000$/);
    const request = calls[1];
    assert.equal(request.headers['x-goog-api-key'], KEY);
    assert(!request.url.includes(KEY), 'The key must not appear in the URL.');
    assert.equal(request.body.systemInstruction.parts[0].text, gemini.SYSTEM);
    assert.deepEqual(request.body.generationConfig.thinkingConfig, { thinkingLevel: 'high' });
    assert.equal(request.body.generationConfig.responseMimeType, undefined);
    assert.equal(request.body.contents[0].parts[0].text, `TASK DATA:\n${JSON.stringify(payload)}`);
    assert.deepEqual(request.body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } });
    await gemini.solve({ key: KEY, store, payload });
    assert.equal(calls.filter(call => call.url.includes('/models?')).length, 1, 'The model catalog is loaded only once per day.');
    assert.deepEqual(gemini.overview(store.peek()).map(model => [model.id, model.used, model.exhausted]), [
      ['gemma-4-31b-it', 2, false], ['gemini-3.5-flash-lite', 0, false], ['gemma-4-26b-a4b-it', 0, false]
    ]);
  });

  await run('Gemini models get JSON mode instead of a thinking level', async () => {
    api({ 'gemini-3.5-flash-lite': [answer(JSON.stringify(solved('84')))] });
    await gemini.solve({ key: KEY, store: memoryStore(), payload, model: 'gemini-3.5-flash-lite' });
    const config = generateCalls()[0].body.generationConfig;
    assert.equal(config.responseMimeType, 'application/json');
    assert.equal(config.thinkingConfig, undefined);
  });

  await run('Daily limit: the next model takes over and the exhausted one is skipped afterwards', async () => {
    api({ 'gemma-4-31b-it': [quota(true)], 'gemini-3.5-flash-lite': [answer(JSON.stringify(solved('84')))] });
    const store = memoryStore();
    const result = await gemini.solve({ key: KEY, store, payload });
    assert.equal(result.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(result.skipped, [{ model: 'gemma-4-31b-it', name: 'Gemma 4 31B', reason: 'quota-day' }]);
    assert.equal(store.peek().exhausted['gemma-4-31b-it'], gemini.quotaDay());
    calls = [];
    await gemini.solve({ key: KEY, store, payload });
    assert.deepEqual(generateCalls().map(modelOf), ['gemini-3.5-flash-lite']);
    assert(gemini.overview(store.peek()).find(model => model.id === 'gemma-4-31b-it').exhausted);
  });

  await run('Per-minute limit, overload, cut-off, blocked and invalid answers switch the model right away', async () => {
    for (const failure of [quota(false), apiError(503, { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' }),
      answer('{"status":"solved"', 'MAX_TOKENS'), answer('', 'SAFETY'), answer('I do not know.')]) {
      calls = [];
      api({ 'gemma-4-31b-it': [failure], 'gemini-3.5-flash-lite': [answer(JSON.stringify(solved('84')))] });
      const result = await gemini.solve({ key: KEY, store: memoryStore(), payload });
      assert.equal(result.model, 'gemini-3.5-flash-lite');
      assert.deepEqual(generateCalls().map(modelOf), ['gemma-4-31b-it', 'gemini-3.5-flash-lite']);
    }
  });

  await run('Per-minute limit on the last model: wait briefly and retry', async () => {
    api({ 'gemma-4-31b-it': [quota(false, '0.05s'), answer(JSON.stringify(solved('84')))] }, ['gemma-4-31b-it']);
    const started = Date.now();
    const result = await gemini.solve({ key: KEY, store: memoryStore(), payload });
    assert.equal(result.model, 'gemma-4-31b-it');
    assert.equal(generateCalls().length, 2);
    assert(Date.now() - started >= 45);
  });

  await run('Rejected extra options: plain mode is tried and remembered', async () => {
    api({ 'gemma-4-31b-it': (call) => call.body.generationConfig.thinkingConfig
      ? apiError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'Thinking level is not supported for this model.' })
      : answer(JSON.stringify(solved('84'))) });
    const store = memoryStore();
    await gemini.solve({ key: KEY, store, payload });
    const [first, second] = generateCalls();
    assert(first.body.systemInstruction);
    assert.equal(second.body.systemInstruction, undefined);
    assert.deepEqual(second.body.generationConfig, {});
    assert(second.body.contents[0].parts[0].text.startsWith(gemini.SYSTEM));
    assert.equal(store.peek().plain['gemma-4-31b-it'], true);
    calls = [];
    await gemini.solve({ key: KEY, store, payload });
    assert.equal(generateCalls().length, 1, 'Next time plain mode is used directly.');
  });

  await run('Invalid key and missing permission stop without switching models', async () => {
    const invalid = apiError(400, { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] });
    handler = () => invalid;
    await assert.rejects(gemini.solve({ key: KEY, store: memoryStore(), payload }), error => error.reason === 'key' && /invalid/.test(error.message));
    await assert.rejects(gemini.listModels(KEY), error => error.reason === 'key');
    api({ '*': [apiError(403, { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied.' })] });
    await assert.rejects(gemini.solve({ key: KEY, store: memoryStore(), payload }), error => error.reason === 'permission');
    assert.equal(generateCalls().length, 1);
    await assert.rejects(gemini.solve({ key: '', store: memoryStore(), payload }), error => error.reason === 'nokey');
  });

  await run('All daily quotas used up: message with reset time', async () => {
    api({ '*': [quota(true)] });
    const store = memoryStore();
    await assert.rejects(gemini.solve({ key: KEY, store, payload }), /All free models have reached their daily limit\. The quota resets at .*\d\d/);
    assert.equal(generateCalls().length, 3);
    calls = [];
    await assert.rejects(gemini.solve({ key: KEY, store, payload }), /daily limit/);
    assert.equal(generateCalls().length, 0, 'Exhausted models are not requested again until the quota day changes.');
  });

  await run('Network error: one more attempt, then a clear message', async () => {
    handler = () => new TypeError('Failed to fetch');
    await assert.rejects(gemini.solve({ key: KEY, store: memoryStore({ models: { day: gemini.quotaDay(), ids: catalog } }), payload }),
      error => error.reason === 'network' && /internet connection/.test(error.message));
    assert.equal(calls.length, 2);
  });

  await run('Catalog unreachable: the default models are used', async () => {
    handler = call => call.url.includes('/models?') ? [500, {}] : answer(JSON.stringify(solved('84')));
    const result = await gemini.solve({ key: KEY, store: memoryStore(), payload });
    assert.equal(result.model, gemini.DEFAULT_MODELS[0]);
  });

  console.log(`${checks} Gemini client checks passed (API simulated, no real key).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
