// Background script of the extension. The API key stays here and on the settings page;
// Mathegym and the content script never see it.
importScripts('gemini.js');
const gemini = self.MathegymGemini;
const store = {
  get: async () => (await chrome.storage.local.get('gemini')).gemini || {},
  set: state => chrome.storage.local.set({ gemini: state })
};

// Messages come from the content script on mathegym.de; only pass on the expected data.
function checked({ payload, image, model }) {
  const valid = payload && typeof payload === 'object' && typeof payload.instruction === 'string' && typeof payload.task === 'string' &&
    Array.isArray(payload.fields) && payload.fields.length <= 100 && JSON.stringify(payload).length <= 100000;
  if (!valid) throw new Error('The task data is invalid or too large.');
  if (image != null && (typeof image !== 'string' || image.length > 8000000 || !/^data:image\/(?:png|jpeg|webp);base64,/.test(image))) {
    throw new Error('The task image is invalid or too large.');
  }
  if (model && (typeof model !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,80}$/.test(model))) throw new Error('Unknown model.');
  const { instruction, task, fields } = payload;
  return { payload: { instruction, task, fields }, image: image || undefined, model: model || '' };
}

async function handle(message) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  switch (message?.type) {
    case 'status':
      return { hasKey: !!apiKey, models: gemini.overview(await store.get()) };
    case 'settings':
      await chrome.runtime.openOptionsPage();
      return {};
    case 'solve': {
      const request = checked(message);
      // Long reasoning must not let the service worker go to sleep.
      const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 25000);
      try { return await gemini.solve({ ...request, key: apiKey, store }); }
      finally { clearInterval(keepAlive); }
    }
    default:
      throw new Error('Unknown request.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(message).then(reply, error => reply({ error: error?.message || 'Unknown error.', reason: error?.reason || '' }));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (!['install', 'update'].includes(reason)) return;
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) chrome.runtime.openOptionsPage();
});
