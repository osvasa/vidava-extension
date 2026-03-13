if (typeof browser === 'undefined') { var browser = chrome; }

// SUPABASE_URL and SUPABASE_ANON_KEY are defined in supabase-client.js (loaded first)
var EDGE_FUNCTION_URL = SUPABASE_URL + '/functions/v1/ask-ai';

browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {

  if (message.type === 'OPEN_POPUP') {
    browser.browserAction.openPopup();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'CHECK_SESSION') {
    // Content scripts use this to verify session via background instead of reading storage directly
    var client = getSupabaseClient();
    if (!client) {
      initSupabaseClient(function() {
        var c = getSupabaseClient();
        if (!c) { sendResponse({ hasSession: false }); return; }
        c.auth.getSession().then(function(r) {
          sendResponse({ hasSession: !!(r && r.data && r.data.session) });
        }).catch(function() { sendResponse({ hasSession: false }); });
      });
    } else {
      client.auth.getSession().then(function(r) {
        sendResponse({ hasSession: !!(r && r.data && r.data.session) });
      }).catch(function() { sendResponse({ hasSession: false }); });
    }
    return true;
  }

  if (message.type === 'ASK_AI') {
    var controller = new AbortController();
    var timeoutId = setTimeout(function() {
      controller.abort();
    }, 30000);

    // Ensure Supabase client is initialized (handles background page restarts)
    function proceedWithSession() {
      var client = getSupabaseClient();
      if (!client) {
        clearTimeout(timeoutId);
        sendResponse({ error: 'Service not ready. Please try again.' });
        return;
      }
      client.auth.getSession().then(function(sessionResult) {
        handleSession(sessionResult);
      }).catch(function(err) {
        clearTimeout(timeoutId);
        console.error('[VIDAVA bg] getSession error:', err.message);
        sendResponse({ error: 'Auth check failed: ' + err.message });
      });
    }

    var client = getSupabaseClient();
    if (!client) {
      // Client not ready — reinitialize and retry
      console.log('[VIDAVA bg] Client not ready, reinitializing...');
      initSupabaseClient(function() { proceedWithSession(); });
    } else {
      proceedWithSession();
    }

    var sessionRetried = false;

    function handleSession(sessionResult) {
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

      if (!session && !sessionRetried) {
        // Session may be stale in memory — reinitialize storage cache and retry once
        sessionRetried = true;
        console.log('[VIDAVA bg] Session not found, reloading storage cache...');
        initSupabaseClient(function() {
          var client2 = getSupabaseClient();
          if (!client2) {
            clearTimeout(timeoutId);
            sendResponse({ error: 'Please sign in to use VIDAVA. Open the extension popup to create an account.' });
            return;
          }
          client2.auth.getSession().then(function(retryResult) {
            handleSession(retryResult);
          }).catch(function(err) {
            clearTimeout(timeoutId);
            sendResponse({ error: 'Auth check failed: ' + err.message });
          });
        });
        return;
      }

      if (!session) {
        clearTimeout(timeoutId);
        console.error('[VIDAVA bg] No session found — user not logged in');
        sendResponse({ error: 'Please sign in to use VIDAVA. Open the extension popup to create an account.' });
        return;
      }

      // Always refresh the session to get a fresh access_token
      // getSession() only reads from storage and may return an expired token
      var client = getSupabaseClient();
      console.log('[VIDAVA bg] Refreshing session to ensure fresh token...');
      client.auth.refreshSession({ refresh_token: session.refresh_token }).then(function(refreshResult) {
        var freshSession = refreshResult && refreshResult.data ? refreshResult.data.session : null;
        if (!freshSession) {
          console.error('[VIDAVA bg] Token refresh failed, using original token');
          proceedWithToken(session.access_token);
        } else {
          console.log('[VIDAVA bg] Token refreshed successfully');
          proceedWithToken(freshSession.access_token);
        }
      }).catch(function(refreshErr) {
        console.error('[VIDAVA bg] refreshSession error:', refreshErr.message, '— using original token');
        proceedWithToken(session.access_token);
      });
    }

    function proceedWithToken(accessToken) {
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
    }

    return true; // Keep message channel open for async sendResponse
  }
});
