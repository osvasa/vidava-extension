if (typeof browser === 'undefined') { var browser = chrome; }

// SUPABASE_URL and SUPABASE_ANON_KEY are defined in supabase-client.js (loaded first)
var EDGE_FUNCTION_URL = SUPABASE_URL + '/functions/v1/ask-ai';

browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {

  if (message.type === 'OPEN_POPUP') {
    browser.browserAction.openPopup();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'ASK_AI') {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() {
      controller.abort();
    }, 30000);

    // Get the current session token to authenticate with the Edge Function
    var client = getSupabaseClient();
    if (!client) {
      sendResponse({ error: 'Service not ready. Please try again.' });
      return false;
    }

    client.auth.getSession().then(function(sessionResult) {
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

      if (!session) {
        clearTimeout(timeoutId);
        console.error('[VIDAVA bg] No session found — user not logged in');
        sendResponse({ error: 'Please sign in to use VIDAVA. Open the extension popup to create an account.' });
        return;
      }

      var accessToken = session.access_token;
      console.log('[VIDAVA bg] Calling Edge Function with token');

      fetch(EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
          'apikey': SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ prompt: message.prompt }),
        signal: controller.signal
      })
      .then(function(r) {
        console.log('[VIDAVA bg] Edge Function response status:', r.status);
        return r.text();
      })
      .then(function(rawBody) {
        clearTimeout(timeoutId);
        console.log('[VIDAVA bg] Edge Function raw response:', rawBody.substring(0, 500));
        try {
          var data = JSON.parse(rawBody);
        } catch (parseErr) {
          console.error('[VIDAVA bg] Failed to parse response as JSON:', rawBody.substring(0, 200));
          sendResponse({ error: 'Server returned invalid response: ' + rawBody.substring(0, 100) });
          return;
        }
        if (data.error) {
          sendResponse({ error: data.error });
        } else if (data.text) {
          sendResponse({ text: data.text });
        } else if (data.message) {
          // Supabase API gateway wraps errors as {"code":NNN,"message":"..."}
          console.error('[VIDAVA bg] Gateway error:', data.code, data.message);
          sendResponse({ error: data.message });
        } else {
          console.error('[VIDAVA bg] Response has no text or error:', rawBody.substring(0, 200));
          sendResponse({ error: 'Unexpected response from server' });
        }
      })
      .catch(function(err) {
        clearTimeout(timeoutId);
        console.error('[VIDAVA bg] Fetch error:', err.name, err.message);
        if (err.name === 'AbortError') {
          sendResponse({ error: 'Request timed out after 30 seconds. Please try again.' });
        } else {
          sendResponse({ error: err.message });
        }
      });
    }).catch(function(err) {
      clearTimeout(timeoutId);
      console.error('[VIDAVA bg] getSession error:', err.message);
      sendResponse({ error: 'Auth check failed: ' + err.message });
    });

    return true; // Keep message channel open for async sendResponse
  }
});
