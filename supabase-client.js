// VIDAVA — Supabase Auth & Cloud Sync
// Runs in the background page context (loaded before background.js)

if (typeof browser === 'undefined') { var browser = chrome; }

var SUPABASE_URL = 'https://payjfhkpnsmyawugymfl.supabase.co';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBheWpmaGtwbnNteWF3dWd5bWZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMzg0NjQsImV4cCI6MjA4ODkxNDQ2NH0.75cRLaGn-GbYTjq0m7fp0lFOekpdE1tJcgYjVkGFBbI';

// Custom storage adapter that uses browser.storage.local for token persistence
// This ensures auth tokens survive background page restarts
var supabaseStorageAdapter = {
  _cache: {},
  getItem: function(key) {
    return supabaseStorageAdapter._cache[key] || null;
  },
  setItem: function(key, value) {
    supabaseStorageAdapter._cache[key] = value;
    var obj = {};
    obj['sb_' + key] = value;
    browser.storage.local.set(obj);
  },
  removeItem: function(key) {
    delete supabaseStorageAdapter._cache[key];
    browser.storage.local.remove('sb_' + key);
  }
};

// Preload cached tokens from browser.storage.local before creating client
var _supabaseClient = null;

function getSupabaseClient() {
  return _supabaseClient;
}

function initSupabaseClient(callback) {
  // Load all sb_ prefixed keys from storage to populate the cache
  browser.storage.local.get(null, function(allData) {
    if (allData) {
      Object.keys(allData).forEach(function(key) {
        if (key.indexOf('sb_') === 0) {
          supabaseStorageAdapter._cache[key.substring(3)] = allData[key];
        }
      });
    }

    _supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: supabaseStorageAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: 'implicit'
      }
    });

    // Listen for auth state changes and broadcast to popup/tabs
    _supabaseClient.auth.onAuthStateChange(function(event, session) {
      console.log('[VIDAVA] Auth state changed:', event);
      var user = session ? session.user : null;
      try {
        browser.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', user: user });
      } catch(e) { /* popup may not be open */ }
    });

    console.log('[VIDAVA] Supabase client initialized');
    if (callback) callback();
  });
}

// ── Auth Functions ──────────────────────────────────────────────────────

function supabaseSignUp(email, password, callback) {
  var client = getSupabaseClient();
  if (!client) return callback({ error: 'Supabase not initialized' });

  client.auth.signUp({ email: email, password: password })
    .then(function(result) {
      if (result.error) {
        console.error('[VIDAVA] Sign up error:', result.error.message);
        callback({ error: result.error.message });
      } else {
        // After signup, sync any existing local cards to cloud
        syncLocalCardsToCloud(function() {
          callback({ user: { id: result.data.user.id, email: result.data.user.email } });
        });
      }
    });
}

function supabaseSignIn(email, password, callback) {
  var client = getSupabaseClient();
  if (!client) return callback({ error: 'Supabase not initialized' });

  client.auth.signInWithPassword({ email: email, password: password })
    .then(function(result) {
      if (result.error) {
        console.error('[VIDAVA] Sign in error:', result.error.message);
        callback({ error: result.error.message });
      } else {
        // After login, merge cloud cards with local cards
        mergeCardsOnLogin(function(mergedCards) {
          callback({ user: { id: result.data.user.id, email: result.data.user.email }, cards: mergedCards });
        });
      }
    });
}

function supabaseSignOut(callback) {
  var client = getSupabaseClient();
  if (!client) return callback({ error: 'Supabase not initialized' });

  client.auth.signOut()
    .then(function(result) {
      if (result.error) {
        callback({ error: result.error.message });
      } else {
        console.log('[VIDAVA] Signed out');
        callback({ ok: true });
      }
    });
}

function supabaseResetPassword(email, callback) {
  var client = getSupabaseClient();
  if (!client) return callback({ error: 'Supabase not initialized' });

  client.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://vidava.app/reset-password'
    })
    .then(function(result) {
      if (result.error) {
        callback({ error: result.error.message });
      } else {
        callback({ ok: true });
      }
    });
}

function supabaseGetSession(callback) {
  var client = getSupabaseClient();
  if (!client) return callback({ user: null });

  client.auth.getSession()
    .then(function(result) {
      if (result.error || !result.data.session) {
        callback({ user: null });
      } else {
        var u = result.data.session.user;
        callback({ user: { id: u.id, email: u.email } });
      }
    });
}

// ── Card Sync Functions ─────────────────────────────────────────────────

// Convert local card format to DB row
function cardToRow(card, userId) {
  return {
    user_id: userId,
    name: card.name,
    bank: card.bank,
    rewards: card.rewards || '',
    best_for: card.bestFor || '',
    apr: card.apr || null,
    due_day: card.dueDay || null,
    credit_limit: card.creditLimit || null,
    details_asked: card.detailsAsked || false
  };
}

// Convert DB row to local card format
function rowToCard(row) {
  var card = {
    name: row.name,
    bank: row.bank,
    rewards: row.rewards,
    bestFor: row.best_for
  };
  if (row.apr) card.apr = row.apr;
  if (row.due_day) card.dueDay = row.due_day;
  if (row.credit_limit) card.creditLimit = row.credit_limit;
  if (row.details_asked) card.detailsAsked = row.details_asked;
  return card;
}

// Pull cards from Supabase for the current user
function pullCardsFromCloud(callback) {
  var client = getSupabaseClient();
  if (!client) return callback([]);

  client.auth.getSession().then(function(sessionResult) {
    if (!sessionResult.data.session) return callback([]);

    client.from('cards')
      .select('*')
      .eq('user_id', sessionResult.data.session.user.id)
      .order('created_at', { ascending: true })
      .then(function(result) {
        if (result.error) {
          console.error('[VIDAVA] Pull cards error:', result.error.message);
          callback([]);
        } else {
          var cards = result.data.map(rowToCard);
          callback(cards);
        }
      });
  });
}

// Push cards to Supabase — replaces all cards for the user
function pushCardsToCloud(cards, callback) {
  var client = getSupabaseClient();
  if (!client) return callback && callback({ error: 'Not initialized' });

  client.auth.getSession().then(function(sessionResult) {
    if (!sessionResult.data.session) return callback && callback({ error: 'Not authenticated' });

    var userId = sessionResult.data.session.user.id;

    // Delete all existing cards for this user, then insert new ones
    client.from('cards')
      .delete()
      .eq('user_id', userId)
      .then(function(delResult) {
        if (delResult.error) {
          console.error('[VIDAVA] Delete old cards error:', delResult.error.message);
          return callback && callback({ error: delResult.error.message });
        }

        if (!cards || cards.length === 0) {
          return callback && callback({ ok: true });
        }

        var rows = cards.map(function(c) { return cardToRow(c, userId); });

        client.from('cards')
          .insert(rows)
          .then(function(insResult) {
            if (insResult.error) {
              console.error('[VIDAVA] Insert cards error:', insResult.error.message);
              callback && callback({ error: insResult.error.message });
            } else {
              callback && callback({ ok: true });
            }
          });
      });
  });
}

// Sync: push local cards to cloud (used after signup with existing local cards)
function syncLocalCardsToCloud(callback) {
  browser.storage.local.get('vidava_cards', function(data) {
    var localCards = data.vidava_cards || [];
    if (localCards.length === 0) return callback && callback();
    pushCardsToCloud(localCards, function() {
      callback && callback();
    });
  });
}

// Merge: on login, combine cloud cards with any local cards
function mergeCardsOnLogin(callback) {
  browser.storage.local.get('vidava_cards', function(localData) {
    var localCards = localData.vidava_cards || [];

    pullCardsFromCloud(function(cloudCards) {
      // Build a map by card name for deduplication
      var merged = {};

      // Cloud cards first (authoritative)
      cloudCards.forEach(function(c) { merged[c.name] = c; });

      // Local cards — add only if not already in cloud
      localCards.forEach(function(c) {
        if (!merged[c.name]) {
          merged[c.name] = c;
        } else {
          // Merge: keep whichever has more detail
          var existing = merged[c.name];
          if (c.apr && !existing.apr) existing.apr = c.apr;
          if (c.dueDay && !existing.dueDay) existing.dueDay = c.dueDay;
          if (c.creditLimit && !existing.creditLimit) existing.creditLimit = c.creditLimit;
          if (c.detailsAsked) existing.detailsAsked = true;
        }
      });

      var mergedArray = Object.keys(merged).map(function(k) { return merged[k]; });

      // Write merged cards to both local and cloud
      browser.storage.local.set({ vidava_cards: mergedArray });
      pushCardsToCloud(mergedArray, function() {
        callback(mergedArray);
      });
    });
  });
}

// ── Recommendation History ──────────────────────────────────────────────

function saveRecommendation(data, callback) {
  var client = getSupabaseClient();
  if (!client) return callback && callback({ error: 'Not initialized' });

  client.auth.getSession().then(function(sessionResult) {
    if (!sessionResult.data.session) return callback && callback({ error: 'Not authenticated' });

    var row = {
      user_id: sessionResult.data.session.user.id,
      store_name: data.store_name,
      purchase_amount: data.purchase_amount || null,
      recommended_card_name: data.recommended_card_name,
      recommended_card_bank: data.recommended_card_bank,
      reason: data.reason || null,
      estimated_rewards: data.estimated_rewards || null
    };

    client.from('recommendations')
      .insert([row])
      .then(function(result) {
        if (result.error) {
          console.error('[VIDAVA] Save recommendation error:', result.error.message);
          callback && callback({ error: result.error.message });
        } else {
          console.log('[VIDAVA] Recommendation saved');
          callback && callback({ ok: true });
        }
      });
  });
}

// ── Background Message Handler for Auth/Sync ────────────────────────────

browser.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'SUPABASE_AUTH') {
    if (message.action === 'signup') {
      supabaseSignUp(message.email, message.password, sendResponse);
      return true; // async
    }
    if (message.action === 'login') {
      supabaseSignIn(message.email, message.password, sendResponse);
      return true;
    }
    if (message.action === 'logout') {
      supabaseSignOut(sendResponse);
      return true;
    }
    if (message.action === 'get_session') {
      supabaseGetSession(sendResponse);
      return true;
    }
    if (message.action === 'reset_password') {
      supabaseResetPassword(message.email, sendResponse);
      return true;
    }
  }

  if (message.type === 'SUPABASE_SYNC_CARDS') {
    // Push cards to cloud if user is authenticated
    var client = getSupabaseClient();
    if (!client) { sendResponse({ ok: false }); return false; }

    client.auth.getSession().then(function(sessionResult) {
      if (sessionResult.data.session) {
        pushCardsToCloud(message.cards, function(result) {
          sendResponse(result || { ok: true });
        });
      } else {
        // Not logged in — no sync needed, local storage is enough
        sendResponse({ ok: true, offline: true });
      }
    });
    return true; // async
  }

  if (message.type === 'SAVE_RECOMMENDATION') {
    saveRecommendation(message.data, function(result) {
      sendResponse(result || { ok: true });
    });
    return true;
  }

  if (message.type === 'SUPABASE_PULL_CARDS') {
    pullCardsFromCloud(function(cards) {
      sendResponse({ cards: cards });
    });
    return true;
  }
});

// Initialize on load
initSupabaseClient();
