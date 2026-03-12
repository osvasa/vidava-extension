const ANTHROPIC_KEY = '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';

const api = typeof browser !== 'undefined' ? browser : chrome;

console.log('[VIDAVA] Background script loaded');

browser.runtime.onMessage.addListener((message, sender) => {
  console.log('[VIDAVA] Message received:', JSON.stringify(message).substring(0, 200));

  if (message.type === 'OPEN_POPUP') {
    browser.browserAction.openPopup();
    return Promise.resolve({ ok: true });
  }

  if (message.type === 'ASK_AI') {
    const requestBody = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: message.prompt }]
    };

    console.log('[VIDAVA] Sending fetch to Anthropic API...');
    console.log('[VIDAVA] Request model:', requestBody.model);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.error('[VIDAVA] Fetch timed out after 30 seconds, aborting...');
      controller.abort();
    }, 30000);

    // Return a Promise — required by Firefox's browser.runtime.onMessage for async responses
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    })
    .then(r => {
      console.log('[VIDAVA] Fetch response status:', r.status, r.statusText);
      console.log('[VIDAVA] Response headers:', [...r.headers.entries()].map(h => h[0] + ': ' + h[1]).join(', '));
      return r.text();
    })
    .then(rawBody => {
      clearTimeout(timeoutId);
      console.log('[VIDAVA] Raw response body:', rawBody);
      const data = JSON.parse(rawBody);
      console.log('[VIDAVA] Parsed API response:', JSON.stringify(data).substring(0, 500));
      if (data.error) {
        console.error('[VIDAVA] API returned error:', JSON.stringify(data.error));
        return { error: data.error.message };
      } else {
        const text = data.content[0].text;
        console.log('[VIDAVA] Raw AI text content:', text);
        return { text: text.trim() };
      }
    })
    .catch(err => {
      clearTimeout(timeoutId);
      console.error('[VIDAVA] Fetch failed with error:', err);
      console.error('[VIDAVA] Error name:', err.name);
      console.error('[VIDAVA] Error message:', err.message);
      console.error('[VIDAVA] Error stack:', err.stack);
      if (err.name === 'AbortError') {
        return { error: 'Request timed out after 30 seconds. Please try again.' };
      } else {
        return { error: err.message };
      }
    });
  }
});
