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
    var fetchRetried = false;

    // Step 1: Ensure client is ready, then get a fresh token
    function startAskAI() {
      var client = getSupabaseClient();
      if (!client) {
        console.log('[VIDAVA bg] Client not ready, reinitializing...');
        initSupabaseClient(function() { getFreshToken(false); });
      } else {
        getFreshToken(false);
      }
    }

    // Step 2: Always refresh the session to get a guaranteed fresh access_token
    // Never fall back to a potentially expired token from getSession()
    function getFreshToken(isRetry) {
      var client = getSupabaseClient();
      if (!client) {
        clearTimeout(timeoutId);
        sendResponse({ error: 'Service not ready. Please try again.' });
        return;
      }

      // First read session from storage to get the refresh_token
      client.auth.getSession().then(function(sessionResult) {
        var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

        if (!session && !isRetry) {
          // Session not in memory — reinitialize storage cache and retry once
          console.log('[VIDAVA bg] Session not found, reloading storage cache...');
          initSupabaseClient(function() { getFreshToken(true); });
          return;
        }

        if (!session) {
          clearTimeout(timeoutId);
          sendResponse({ error: 'Please sign in to use VIDAVA. Open the extension popup to create an account.' });
          return;
        }

        // Refresh to get a fresh access_token — this is the critical step
        client.auth.refreshSession({ refresh_token: session.refresh_token }).then(function(refreshResult) {
          var freshSession = refreshResult && refreshResult.data ? refreshResult.data.session : null;

          if (freshSession) {
            console.log('[VIDAVA bg] Token refreshed successfully');
            callEdgeFunction(freshSession.access_token);
            return;
          }

          // Refresh returned no session — try reinitializing client once
          if (!isRetry) {
            console.log('[VIDAVA bg] Token refresh returned no session, reinitializing...');
            initSupabaseClient(function() { getFreshToken(true); });
          } else {
            clearTimeout(timeoutId);
            sendResponse({ error: 'Session expired. Please sign in again via the VIDAVA popup.' });
          }
        }).catch(function(refreshErr) {
          console.error('[VIDAVA bg] refreshSession error:', refreshErr.message);
          // Don't fall back to expired token — try reinitializing once
          if (!isRetry) {
            console.log('[VIDAVA bg] Refresh failed, reinitializing client...');
            initSupabaseClient(function() { getFreshToken(true); });
          } else {
            clearTimeout(timeoutId);
            sendResponse({ error: 'Session expired. Please sign in again via the VIDAVA popup.' });
          }
        });
      }).catch(function(err) {
        clearTimeout(timeoutId);
        console.error('[VIDAVA bg] getSession error:', err.message);
        sendResponse({ error: 'Auth check failed: ' + err.message });
      });
    }

    // Step 3: Call the Edge Function with a fresh token
    // If it returns 401, refresh token and retry once automatically
    function callEdgeFunction(accessToken) {
      console.log('[VIDAVA bg] Calling Edge Function');

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
        // Auto-retry on 401/403 — token may have expired between refresh and fetch
        if ((r.status === 401 || r.status === 403) && !fetchRetried) {
          fetchRetried = true;
          console.log('[VIDAVA bg] Got ' + r.status + ', refreshing token and retrying...');
          getFreshToken(false);
          return null; // Skip body processing
        }
        return r.text();
      })
      .then(function(rawBody) {
        if (rawBody === null) return; // Retry in progress
        clearTimeout(timeoutId);
        try {
          var data = JSON.parse(rawBody);
        } catch (parseErr) {
          console.error('[VIDAVA bg] Failed to parse response as JSON:', rawBody.substring(0, 200));
          sendResponse({ error: 'Server returned invalid response: ' + rawBody.substring(0, 100) });
          return;
        }
        if (data.text) {
          sendResponse({ text: data.text });
        } else if (data.error) {
          // If auth error and haven't retried fetch yet, retry silently
          if (/invalid.*credential|invalid.*token|jwt.*expired|not.*authorized/i.test(data.error) && !fetchRetried) {
            fetchRetried = true;
            console.log('[VIDAVA bg] Auth error in response, refreshing and retrying...');
            getFreshToken(false);
          } else {
            sendResponse({ error: data.error });
          }
        } else if (data.message) {
          // Supabase gateway error: {"code":NNN,"message":"..."}
          if (/invalid.*credential|invalid.*token|jwt.*expired|not.*authorized/i.test(data.message) && !fetchRetried) {
            fetchRetried = true;
            console.log('[VIDAVA bg] Gateway auth error, refreshing and retrying...');
            getFreshToken(false);
          } else {
            sendResponse({ error: data.message });
          }
        } else {
          console.error('[VIDAVA bg] Unexpected response:', rawBody.substring(0, 200));
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

    startAskAI();
    return true; // Keep message channel open for async sendResponse
  }
});
