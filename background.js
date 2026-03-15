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

    // Step 2: Get a valid access_token — use existing if not expired, refresh only if needed
    function getFreshToken(isRetry) {
      console.log('[VIDAVA bg] getFreshToken called (isRetry=' + isRetry + ')');
      var client = getSupabaseClient();
      if (!client) {
        console.log('[VIDAVA bg] ERROR: client is null');
        clearTimeout(timeoutId);
        sendResponse({ error: 'Service not ready. Please try again.' });
        return;
      }

      client.auth.getSession().then(function(sessionResult) {
        var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
        console.log('[VIDAVA bg] getSession result:', session ? {
          user: session.user ? session.user.email : 'no user',
          access_token_prefix: session.access_token ? session.access_token.substring(0, 20) + '...' : 'NONE',
          expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : 'NONE',
          expired: session.expires_at ? (session.expires_at * 1000 < Date.now()) : 'unknown'
        } : 'NO SESSION');

        if (!session && !isRetry) {
          console.log('[VIDAVA bg] Session not found, reloading storage cache...');
          initSupabaseClient(function() { getFreshToken(true); });
          return;
        }

        if (!session) {
          clearTimeout(timeoutId);
          console.log('[VIDAVA bg] No session after retry — user not logged in');
          sendResponse({ error: 'Please sign in to use VIDAVA. Open the extension popup to create an account.' });
          return;
        }

        // If the access_token is still valid (>60s until expiry), use it directly.
        // Avoids calling refreshSession() which can fail if autoRefreshToken already
        // consumed the refresh_token (refresh token rotation).
        var now = Math.floor(Date.now() / 1000);
        var expiresAt = session.expires_at || 0;
        if (session.access_token && expiresAt > now + 60) {
          console.log('[VIDAVA bg] Access token still valid (expires in ' + (expiresAt - now) + 's), using directly');
          callEdgeFunction(session.access_token);
          return;
        }

        // Token expired or about to expire — must refresh
        console.log('[VIDAVA bg] Token expired or expiring soon, calling refreshSession...');
        client.auth.refreshSession({ refresh_token: session.refresh_token }).then(function(refreshResult) {
          var freshSession = refreshResult && refreshResult.data ? refreshResult.data.session : null;
          var refreshError = refreshResult && refreshResult.error ? refreshResult.error : null;
          console.log('[VIDAVA bg] refreshSession result:', freshSession ? {
            access_token_prefix: freshSession.access_token ? freshSession.access_token.substring(0, 20) + '...' : 'NONE',
            expires_at: freshSession.expires_at ? new Date(freshSession.expires_at * 1000).toISOString() : 'NONE'
          } : 'NO FRESH SESSION', refreshError ? ('error: ' + refreshError.message) : '');

          if (freshSession) {
            callEdgeFunction(freshSession.access_token);
            return;
          }

          // Refresh failed — but we still have the old access_token, try it anyway.
          // The Edge Function will validate it; if truly expired it returns 401
          // and the callEdgeFunction retry logic handles it.
          if (session.access_token) {
            console.log('[VIDAVA bg] Refresh failed but using existing token as fallback');
            callEdgeFunction(session.access_token);
          } else if (!isRetry) {
            console.log('[VIDAVA bg] Token refresh returned no session, reinitializing...');
            initSupabaseClient(function() { getFreshToken(true); });
          } else {
            clearTimeout(timeoutId);
            sendResponse({ error: 'Session expired. Please sign in again via the VIDAVA popup.' });
          }
        }).catch(function(refreshErr) {
          console.error('[VIDAVA bg] refreshSession error:', refreshErr.message);
          // Refresh threw — fall back to existing token if available
          if (session.access_token) {
            console.log('[VIDAVA bg] Refresh threw but using existing token as fallback');
            callEdgeFunction(session.access_token);
          } else if (!isRetry) {
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
      console.log('[VIDAVA bg] Calling Edge Function with token:', accessToken ? accessToken.substring(0, 20) + '...(len=' + accessToken.length + ')' : 'NO TOKEN');
      console.log('[VIDAVA bg] Edge URL:', EDGE_FUNCTION_URL);
      console.log('[VIDAVA bg] apikey prefix:', SUPABASE_ANON_KEY ? SUPABASE_ANON_KEY.substring(0, 20) + '...' : 'MISSING');

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
        console.log('[VIDAVA bg] Edge Function response: status=' + r.status + ' statusText=' + r.statusText);
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
        console.log('[VIDAVA bg] Edge Function raw body:', rawBody.substring(0, 500));
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
