if (typeof browser === 'undefined') { var browser = chrome; }

// Cross-browser sendMessage: Chrome uses callbacks, Firefox uses Promises
function sendMsg(msg, callback) {
  var done = false;
  function respond(resp) {
    if (done) return;
    done = true;
    callback(resp);
  }
  try {
    var result = browser.runtime.sendMessage(msg, respond);
    if (result && typeof result.then === 'function') {
      result.then(respond).catch(function(e) { respond({ error: e.message }); });
    }
  } catch(e) {
    respond({ error: e.message });
  }
}

let addedCards = [];
let previousScreen = null;
let detailsCardIndex = 0; // which card we're currently adding details for
let detailsNewCardsStart = 0; // index of first card that hasn't had details prompt

function toTitleCase(str) {
  return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
}

var currentUser = null; // { id, email } or null

function saveState(screenId) {
  browser.storage.local.set({ vidava_screen: screenId, vidava_cards: addedCards });
  // Sync to cloud if authenticated
  syncCardsToCloud();
}

function syncCardsToCloud() {
  if (!currentUser) return;
  sendMsg({ type: 'SUPABASE_SYNC_CARDS', cards: addedCards }, function(resp) {
    if (resp && resp.error) console.error('[VIDAVA] Cloud sync failed');
  });
}

function updateSettingsAccountUI() {
  var emailEl = document.getElementById('settings-user-email');
  var signOutBtn = document.getElementById('btn-sign-out');
  var accountSection = document.getElementById('settings-account-section');
  if (currentUser) {
    emailEl.textContent = currentUser.email;
    signOutBtn.style.display = '';
    accountSection.style.display = '';
  } else {
    emailEl.textContent = '';
    signOutBtn.style.display = 'none';
    accountSection.style.display = 'none';
  }
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id !== 'screen-checkout' && id !== 'screen-settings' && id !== 'screen-card-details' && id !== 'screen-settings-edit' && id !== 'screen-settings-remove') {
    saveState(id);
  }
}

function showError(msg) {
  document.querySelectorAll('.error-msg').forEach(e => e.remove());
  const active = document.querySelector('.screen.active');
  const div = document.createElement('div');
  div.className = 'error-msg';
  div.textContent = msg;
  active.appendChild(div);
}

function parseAIResponse(text) {
  let rawText = text.trim();
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    rawText = fenceMatch[1].trim();
  }
  return JSON.parse(rawText);
}

// Main AI function — handles both first card and additional cards
function processInput(rawInput) {
  const trimmed = rawInput.trim();
  if (!trimmed) return;

  // Check for completion keywords before sending to AI
  var completionWords = ['done', 'no more', 'no more cards', 'finish', 'stop'];
  if (completionWords.indexOf(trimmed.toLowerCase()) !== -1) {
    var hasNewCards = addedCards.some((c, i) => i >= detailsNewCardsStart && !c.detailsAsked);
    if (hasNewCards) {
      startDetailsFlow();
    } else {
      showDoneScreen();
    }
    return;
  }

  const input = toTitleCase(trimmed);

  showScreen('screen-loading');
  document.getElementById('loading-text').textContent =
    'I am checking "' + input + '"... hang tight.';

  try {
    const prompt = `The user typed: "${input}"

You are a credit card expert. Analyze this input and respond ONLY with a JSON object, no other text, no markdown.

Step 1 — Is this a real bank, card network, or credit card (including misspelled versions)?
- If it looks like a misspelled bank or card (e.g. "chaise sapfire" = "Chase Sapphire", "capital won" = "Capital One", "bank of amercia" = "Bank of America", "amrican expres" = "American Express") treat it as the corrected version.
- If it is clearly not a bank or credit card at all (e.g. "dog card", "card table", "pizza", "hello", random words) go to Case 3.

Case 1 — A bank name or card network only (even if misspelled), after correction:
{"status":"list","bank":"<corrected bank name>","cards":[{"name":"<exact full real card name>","highlight":"<key benefit in 5 words max>"},...]}
Include 6-10 of their most popular real current credit cards.

Case 2 — A specific real card name (even if misspelled), after correction:
{"status":"ok","cardName":"<corrected full proper card name>","bank":"<bank name>","rewards":"<one sentence reward summary>","bestFor":"<one sentence best use case>"}

Case 3 — Not a real bank or credit card at all:
{"status":"invalid","message":"That does not seem to be a real credit card or bank. Please try typing your bank name or the full name of your card."}

Respond ONLY with the JSON. No explanation, no markdown, no code block.`;

    sendMsg({ type: 'ASK_AI', prompt: prompt }, function(response) {
      try {

        if (!response) throw new Error('No response received from background script');
        if (response.error) throw new Error(response.error);
        if (!response.text) throw new Error('Empty response from AI');

        const result = parseAIResponse(response.text);

        if (result.status === 'list') {
          renderCardList(result.bank, result.cards);
        } else if (result.status === 'ok') {
          addedCards.push({ name: result.cardName, bank: result.bank, rewards: result.rewards, bestFor: result.bestFor });
          saveState('screen-card-added');
          renderCardAdded(result.cardName);
        } else if (result.status === 'invalid') {
          showScreen('screen-add-card');
          showError(result.message || 'I do not recognize that as a real card. Please try again.');
        }
      } catch (err) {
        console.error('VIDAVA AI error:', err);
        showScreen('screen-add-card');
        showError('I could not connect right now. Please check your connection and try again.');
      }
    });

  } catch (err) {
    console.error('VIDAVA AI error:', err);
    showScreen('screen-add-card');
    showError('I could not connect right now. Please check your connection and try again.');
  }
}

function renderCardList(bank, cards) {
  document.getElementById('card-list-title').textContent = 'Which ' + bank + ' card do you have?';
  const list = document.getElementById('card-select-list');
  list.innerHTML = '';
  cards.forEach(function(card) {
    const btn = document.createElement('button');
    btn.className = 'card-select-btn';
    btn.innerHTML =
      '<span class="card-select-name">' + card.name + '</span>' +
      '<span class="card-select-highlight">' + card.highlight + '</span>';
    btn.addEventListener('click', function() {
      processInput(card.name);
    });
    list.appendChild(btn);
  });
  document.getElementById('card-input-notlisted').value = '';
  showScreen('screen-card-list');
}

function renderCardAdded(lastCardName) {
  document.getElementById('card-confirmed-title').textContent = 'Your ' + lastCardName + ' is all set up.';
  document.getElementById('cards-list').innerHTML = addedCards.map(c =>
    '<div class="card-item">' + c.name + '</div>'
  ).join('');
  document.getElementById('card-input-more').value = '';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-card-added').classList.add('active');
}

function showDoneScreen() {
  document.getElementById('cards-list-done').innerHTML = addedCards.map(c =>
    '<div class="card-item">' + c.name + '</div>'
  ).join('');
  showScreen('screen-done');
}

// === PERSONAL CARD DETAILS FLOW ===

function startDetailsFlow() {
  // Find cards that don't have details yet (starting from detailsNewCardsStart)
  detailsCardIndex = detailsNewCardsStart;
  showNextDetailsCard();
}

function showNextDetailsCard() {
  // Find next card without details
  while (detailsCardIndex < addedCards.length && addedCards[detailsCardIndex].detailsAsked) {
    detailsCardIndex++;
  }

  if (detailsCardIndex >= addedCards.length) {
    // All cards have been asked — go to done screen
    detailsNewCardsStart = addedCards.length;
    browser.storage.local.set({ vidava_cards: addedCards });
    syncCardsToCloud();
    showDoneScreen();
    return;
  }

  const card = addedCards[detailsCardIndex];
  var badgeEl = document.getElementById('details-card-name');
  badgeEl.textContent = '';
  var chip = document.createElement('div');
  chip.style.cssText = 'width:28px;height:18px;border-radius:6px;background:#FFD932;display:inline-block;vertical-align:middle;flex-shrink:0;';
  badgeEl.appendChild(chip);
  badgeEl.appendChild(document.createTextNode(card.name));
  document.getElementById('details-counter').textContent =
    'CARD ' + (detailsCardIndex + 1) + ' OF ' + addedCards.length;
  document.getElementById('details-apr').value = card.apr || '';
  document.getElementById('details-due-day').value = card.dueDay || '';
  document.getElementById('details-balance').value = card.creditLimit || '';
  showScreen('screen-card-details');
}

function showSaveToast(callback) {
  // Remove any existing toast
  var old = document.getElementById('vidava-save-toast');
  if (old) old.remove();
  var toast = document.createElement('div');
  toast.id = 'vidava-save-toast';
  toast.textContent = '\u2713 Saved!';
  toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#00e5cc;color:#000;font-size:13px;font-weight:700;padding:8px 24px;border-radius:999px;z-index:9999;animation:fadeIn 0.3s ease;';
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(function() {
      toast.remove();
      if (callback) callback();
    }, 300);
  }, 1200);
}

function saveCurrentCardDetails() {
  var currentCardName = addedCards[detailsCardIndex].name;
  var apr = document.getElementById('details-apr').value.trim();
  var dueDay = document.getElementById('details-due-day').value.trim();
  var balance = document.getElementById('details-balance').value.trim();

  // Merge into local array
  if (apr) addedCards[detailsCardIndex].apr = parseFloat(apr);
  if (dueDay) addedCards[detailsCardIndex].dueDay = parseInt(dueDay);
  if (balance) addedCards[detailsCardIndex].creditLimit = parseFloat(balance);
  addedCards[detailsCardIndex].detailsAsked = true;

  // Read-merge-write to storage to ensure nothing is lost
  browser.storage.local.get('vidava_cards', function(result) {
    var cards = result.vidava_cards || [];
    var cardIndex = cards.findIndex(function(c) { return c.name === currentCardName; });
    if (cardIndex !== -1) {
      // Merge all fields from the local card into storage
      Object.assign(cards[cardIndex], addedCards[detailsCardIndex]);
    } else {
      cards = addedCards; // fallback: save entire local array
    }
    browser.storage.local.set({ vidava_cards: cards }, function() {
      syncCardsToCloud();
    });
  });
}

// === CHECKOUT RECOMMENDATION ===

const CHECKOUT_PATTERN = /checkout\/payment|checkout\/billing|order\/payment/i;

function extractStoreName(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '').replace(/\.(com|org|net|co|io|shop|store|uk|ca|de|fr|au|in).*$/, '');
  } catch (e) {
    return url;
  }
}

function runCheckoutRecommendation(currentUrl) {
  const storeName = extractStoreName(currentUrl);

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-checkout').classList.add('active');
  document.getElementById('checkout-title').textContent = 'I found your best card for ' + storeName;
  document.getElementById('checkout-spinner').style.display = 'block';
  document.getElementById('checkout-result').style.display = 'none';
  document.getElementById('checkout-actions').style.display = 'none';

  try {
    const cardDescriptions = addedCards.map((c, i) => {
      let desc = (i+1) + '. ' + c.name + ' (' + c.bank + ') — Rewards: ' + c.rewards + ' | Best for: ' + c.bestFor;
      if (c.apr) desc += ' | APR: ' + c.apr + '%';
      if (c.dueDay) desc += ' | Payment due day: ' + c.dueDay;
      if (c.creditLimit) desc += ' | Credit limit: $' + c.creditLimit;
      return desc;
    }).join('\n');

    var singleCard = addedCards.length === 1;
    var prompt = 'You are a credit card rewards expert. The user is about to make a purchase at "' + storeName + '" (full URL: ' + currentUrl + ').\n\n' +
      'First, identify what kind of store "' + storeName + '" is and what spending category it falls under (e.g. groceries, travel, dining, gas, streaming, online retail, electronics, clothing, department store, etc.).\n\n' +
      'The user has these credit cards:\n' + cardDescriptions + '\n\n' +
      (singleCard ?
        'The user has only ONE card. Do not compare to other cards. Explain what rewards this card earns at "' + storeName + '" and note any APR or due date concerns.\n\n' :
        'Based on the specific store "' + storeName + '" and knowing which credit cards earn the highest rewards at that type of store, recommend the SINGLE BEST card to use for this purchase.\n') +
      'If any card has a payment due within 5 days, warn the user.\n' +
      'If any card has high APR (>20%), note the interest cost risk.\n\n' +
      'Respond ONLY with a JSON object, no other text, no markdown, no code block.\n\n' +
      'Format:\n' +
      '{"cardName":"<exact card name from the user\'s list>","bank":"<bank name>","reason":"<2-3 sentences explaining ' +
      (singleCard ? 'what rewards this card earns at ' + storeName + ' and any relevant APR or due date info.' : 'WHY this card is best for purchasing at ' + storeName + ' specifically. Mention the reward rate and why it beats the other cards.') +
      '>"}\n\n' +
      'Respond ONLY with the JSON.';

    sendMsg({ type: 'ASK_AI', prompt: prompt }, function(response) {
      try {
        if (!response || response.error) throw new Error(response ? response.error : 'No response');
        if (!response.text) throw new Error('Empty response from AI');

        var result = parseAIResponse(response.text);

        document.getElementById('recommended-card').innerHTML =
          '<div class="card-name">' + result.cardName + '</div>' +
          '<div class="card-bank">' + result.bank + '</div>';
        document.getElementById('recommendation-reason').textContent = result.reason;

        document.getElementById('checkout-spinner').style.display = 'none';
        document.getElementById('checkout-result').style.display = 'block';
        document.getElementById('checkout-actions').style.display = 'flex';
      } catch (err) {
        console.error('VIDAVA checkout error:', err);
        document.getElementById('checkout-spinner').style.display = 'none';
        document.getElementById('checkout-result').style.display = 'block';
        document.getElementById('recommended-card').innerHTML =
          '<div class="card-name" style="color:#ff6eb4">I could not get a recommendation</div>';
        document.getElementById('recommendation-reason').textContent =
          'Please try again. Error: ' + err.message;
        document.getElementById('checkout-actions').style.display = 'flex';
      }
    });

  } catch (err) {
    console.error('VIDAVA checkout error:', err);
    document.getElementById('checkout-spinner').style.display = 'none';
    document.getElementById('checkout-result').style.display = 'block';
    document.getElementById('recommended-card').innerHTML =
      '<div class="card-name" style="color:#ff6eb4">I could not get a recommendation</div>';
    document.getElementById('recommendation-reason').textContent =
      'Please try again. Error: ' + err.message;
    document.getElementById('checkout-actions').style.display = 'flex';
  }
}

// === SETTINGS SCREEN ===

let settingsEditIndex = -1;
let settingsRemoveIndex = -1;

function escHtml(s) {
  var d = document.createElement('span');
  d.textContent = s;
  return d.innerHTML;
}

function renderSettingsCards() {
  const list = document.getElementById('settings-cards-list');
  if (addedCards.length === 0) {
    list.innerHTML = '<div class="settings-empty">No cards added yet.</div>';
    return;
  }
  list.innerHTML = addedCards.map((c, i) =>
    '<div class="settings-card-item">' +
      '<div class="settings-card-chip"></div>' +
      '<div class="settings-card-info">' +
        '<span class="settings-card-name">' + escHtml(c.name) + '</span>' +
        '<span class="settings-card-bank">' + escHtml(c.bank) +
          (c.apr ? ' &middot; <span style="color:' + (c.apr > 25 ? '#ff6eb4' : 'inherit') + '">APR ' + c.apr + '%</span>' : '') +
          (c.dueDay ? ' &middot; Due day ' + c.dueDay : '') +
        '</span>' +
      '</div>' +
      '<div class="settings-card-actions">' +
        '<button class="settings-card-edit" data-index="' + i + '">Edit</button>' +
        '<button class="settings-card-delete" data-index="' + i + '" title="Remove">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>'
  ).join('');

  list.querySelectorAll('.settings-card-edit').forEach(btn => {
    btn.addEventListener('click', function() {
      settingsEditIndex = parseInt(this.getAttribute('data-index'));
      showEditCard(settingsEditIndex);
    });
  });

  list.querySelectorAll('.settings-card-delete').forEach(btn => {
    btn.addEventListener('click', function() {
      settingsRemoveIndex = parseInt(this.getAttribute('data-index'));
      showRemoveConfirm(settingsRemoveIndex);
    });
  });
}

function showSettings() {
  previousScreen = document.querySelector('.screen.active');
  renderSettingsCards();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-settings').classList.add('active');
}

function showEditCard(idx) {
  const card = addedCards[idx];
  document.getElementById('edit-card-name').textContent = card.name;
  document.getElementById('edit-apr').value = card.apr || '';
  document.getElementById('edit-due-day').value = card.dueDay || '';
  document.getElementById('edit-balance').value = card.creditLimit || '';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-settings-edit').classList.add('active');
}

function saveEditCard() {
  if (settingsEditIndex < 0 || settingsEditIndex >= addedCards.length) return;
  var currentCardName = addedCards[settingsEditIndex].name;
  var apr = document.getElementById('edit-apr').value.trim();
  var editDueDay = document.getElementById('edit-due-day').value.trim();
  var balance = document.getElementById('edit-balance').value.trim();

  // Merge into local array
  if (apr) addedCards[settingsEditIndex].apr = parseFloat(apr);
  else delete addedCards[settingsEditIndex].apr;
  if (editDueDay) addedCards[settingsEditIndex].dueDay = parseInt(editDueDay);
  else delete addedCards[settingsEditIndex].dueDay;
  delete addedCards[settingsEditIndex].dueMonth;
  delete addedCards[settingsEditIndex].dueDate;
  if (balance) addedCards[settingsEditIndex].creditLimit = parseFloat(balance);
  else delete addedCards[settingsEditIndex].creditLimit;

  // Read-merge-write to storage
  browser.storage.local.get('vidava_cards', function(result) {
    var cards = result.vidava_cards || [];
    var cardIndex = cards.findIndex(function(c) { return c.name === currentCardName; });
    if (cardIndex !== -1) {
      Object.assign(cards[cardIndex], addedCards[settingsEditIndex]);
      // Clean up deleted fields
      if (!apr) delete cards[cardIndex].apr;
      if (!editDueDay) delete cards[cardIndex].dueDay;
      delete cards[cardIndex].dueMonth;
      delete cards[cardIndex].dueDate;
      if (!balance) delete cards[cardIndex].creditLimit;
    } else {
      cards = addedCards;
    }
    browser.storage.local.set({ vidava_cards: cards }, function() {
      syncCardsToCloud();
    });
  });

  showSaveToast(function() {
    showSettings();
  });
}

function showRemoveConfirm(idx) {
  const card = addedCards[idx];
  document.getElementById('remove-card-msg').textContent = 'Remove ' + card.name + '?';
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-settings-remove').classList.add('active');
}

function confirmRemoveCard() {
  if (settingsRemoveIndex < 0 || settingsRemoveIndex >= addedCards.length) return;
  addedCards.splice(settingsRemoveIndex, 1);
  browser.storage.local.set({ vidava_cards: addedCards });
  syncCardsToCloud();
  settingsRemoveIndex = -1;
  showSettings();
}

// === INIT ===

document.addEventListener('DOMContentLoaded', function() {

  // Settings gear
  document.getElementById('btn-settings-gear').addEventListener('click', showSettings);

  // Settings: add more cards
  document.getElementById('btn-settings-add-more').addEventListener('click', () => {
    showScreen('screen-add-card');
  });

  // Settings: back arrow
  document.getElementById('btn-settings-back-arrow').addEventListener('click', () => {
    if (previousScreen && previousScreen.id) {
      showScreen(previousScreen.id);
    } else if (addedCards.length > 0) {
      showDoneScreen();
    } else {
      showScreen('screen-signup');
    }
  });

  // Settings: edit card — save
  document.getElementById('btn-edit-save').addEventListener('click', saveEditCard);

  // Settings: edit card — cancel / back
  document.getElementById('btn-edit-cancel').addEventListener('click', showSettings);
  document.getElementById('btn-settings-edit-back').addEventListener('click', showSettings);

  // Settings: remove card — confirm
  document.getElementById('btn-remove-confirm').addEventListener('click', confirmRemoveCard);

  // Settings: remove card — keep
  document.getElementById('btn-remove-keep').addEventListener('click', showSettings);

  // Checkout: done
  document.getElementById('btn-checkout-done').addEventListener('click', () => {
    if (addedCards.length > 0) showDoneScreen();
    else showScreen('screen-signup');
  });

  // Personal details: save & next
  document.getElementById('btn-details-save').addEventListener('click', () => {
    saveCurrentCardDetails();
    showSaveToast(function() {
      detailsCardIndex++;
      showNextDetailsCard();
    });
  });

  // Personal details: skip this card
  document.getElementById('btn-details-skip').addEventListener('click', () => {
    addedCards[detailsCardIndex].detailsAsked = true;
    detailsCardIndex++;
    showNextDetailsCard();
  });

  // Personal details: skip all
  document.getElementById('btn-details-skip-all').addEventListener('click', () => {
    // Mark all remaining as asked
    for (let i = detailsCardIndex; i < addedCards.length; i++) {
      addedCards[i].detailsAsked = true;
    }
    detailsNewCardsStart = addedCards.length;
    browser.storage.local.set({ vidava_cards: addedCards });
    syncCardsToCloud();
    showDoneScreen();
  });

  // Hide all screens until we decide which one to show
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));

  function restoreScreen(data) {
    var screen = data.vidava_screen || 'screen-signup';
    // If user is authenticated and screen is signup, skip to add-card or done
    if (currentUser && screen === 'screen-signup') {
      screen = addedCards.length > 0 ? 'screen-done' : 'screen-add-card';
    }
    document.getElementById(screen).classList.add('active');
    if (screen === 'screen-card-added' && addedCards.length > 0) {
      document.getElementById('card-confirmed-title').textContent =
        'Your ' + addedCards[addedCards.length - 1].name + ' is all set up.';
      document.getElementById('cards-list').innerHTML = addedCards.map(c =>
        '<div class="card-item">' + c.name + '</div>'
      ).join('');
    }
    if (screen === 'screen-done' && addedCards.length > 0) {
      document.getElementById('cards-list-done').innerHTML = addedCards.map(c =>
        '<div class="card-item">' + c.name + '</div>'
      ).join('');
    }
    updateSettingsAccountUI();
  }

  function onStorageReady(data) {
    if (data.vidava_cards && data.vidava_cards.length > 0) addedCards = data.vidava_cards;
    detailsNewCardsStart = addedCards.length;

    // Check auth session first
    sendMsg({ type: 'SUPABASE_AUTH', action: 'get_session' }, function(resp) {
      if (resp && resp.user) {
        currentUser = resp.user;
      }
      updateSettingsAccountUI();

      // Check if on checkout page
      if (addedCards.length > 0) {
        try {
          browser.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            var currentUrl = (tabs && tabs.length > 0) ? tabs[0].url : '';

            if (currentUrl && CHECKOUT_PATTERN.test(currentUrl)) {
              runCheckoutRecommendation(currentUrl);
              return;
            }
            restoreScreen(data);
          });
          return;
        } catch (err) {
          console.error('[VIDAVA] Tab query failed');
        }
      }
      restoreScreen(data);
    });
  }

  // Use callback pattern for Chrome MV2 compatibility
  try {
    browser.storage.local.get(['vidava_screen', 'vidava_cards'], function(data) {
      onStorageReady(data);
    });
  } catch(e) {
    document.getElementById('screen-signup').classList.add('active');
  }

  // === AUTH BUTTONS ===

  // Email auth — show the email/password screen
  document.getElementById('btn-email').addEventListener('click', function() {
    authIsLogin = false;
    document.getElementById('auth-email-title').textContent = 'Create your account';
    document.getElementById('auth-email-subtitle').textContent = 'Sign up with your email to save your cards securely.';
    document.getElementById('btn-auth-submit').textContent = 'Sign Up';
    document.getElementById('auth-toggle-link').innerHTML = 'Already have an account? <a id="btn-auth-toggle">Log in</a>';
    document.getElementById('auth-error').style.display = 'none';
    document.getElementById('auth-email-input').value = '';
    document.getElementById('auth-password-input').value = '';
    updateForgotLink();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-auth-email').classList.add('active');
    wireAuthToggle();
  });

  // Login link — same screen but in login mode
  document.getElementById('btn-login').addEventListener('click', function() {
    authIsLogin = true;
    document.getElementById('auth-email-title').textContent = 'Welcome back';
    document.getElementById('auth-email-subtitle').textContent = 'Log in to access your saved cards.';
    document.getElementById('btn-auth-submit').textContent = 'Log In';
    document.getElementById('auth-toggle-link').innerHTML = 'Don\'t have an account? <a id="btn-auth-toggle">Sign up</a>';
    document.getElementById('auth-error').style.display = 'none';
    document.getElementById('auth-email-input').value = '';
    document.getElementById('auth-password-input').value = '';
    updateForgotLink();
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-auth-email').classList.add('active');
    wireAuthToggle();
  });

  // Apple, Google, Microsoft — coming soon
  ['btn-apple','btn-google','btn-microsoft'].forEach(function(id) {
    document.getElementById(id).addEventListener('click', function() {
      // For now, redirect to email auth with a note
      document.getElementById('btn-email').click();
    });
  });

  // Auth toggle (switch between sign up / log in)
  var authIsLogin = false;
  function updateForgotLink() {
    document.getElementById('auth-forgot-link').style.display = authIsLogin ? '' : 'none';
  }
  function wireAuthToggle() {
    var toggleLink = document.getElementById('btn-auth-toggle');
    if (toggleLink) {
      toggleLink.addEventListener('click', function() {
        authIsLogin = !authIsLogin;
        if (authIsLogin) {
          document.getElementById('auth-email-title').textContent = 'Welcome back';
          document.getElementById('auth-email-subtitle').textContent = 'Log in to access your saved cards.';
          document.getElementById('btn-auth-submit').textContent = 'Log In';
          document.getElementById('auth-toggle-link').innerHTML = 'Don\'t have an account? <a id="btn-auth-toggle">Sign up</a>';
        } else {
          document.getElementById('auth-email-title').textContent = 'Create your account';
          document.getElementById('auth-email-subtitle').textContent = 'Sign up with your email to save your cards securely.';
          document.getElementById('btn-auth-submit').textContent = 'Sign Up';
          document.getElementById('auth-toggle-link').innerHTML = 'Already have an account? <a id="btn-auth-toggle">Log in</a>';
        }
        document.getElementById('auth-error').style.display = 'none';
        updateForgotLink();
        wireAuthToggle();
      });
    }
  }

  // Auth submit handler
  document.getElementById('btn-auth-submit').addEventListener('click', function() {
    var email = document.getElementById('auth-email-input').value.trim();
    var password = document.getElementById('auth-password-input').value;
    var errorEl = document.getElementById('auth-error');

    if (!email || !password) {
      errorEl.textContent = 'Please enter both email and password.';
      errorEl.style.display = 'block';
      return;
    }
    if (password.length < 6) {
      errorEl.textContent = 'Password must be at least 6 characters.';
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';
    var submitBtn = document.getElementById('btn-auth-submit');
    var origText = submitBtn.textContent;
    submitBtn.textContent = 'Please wait...';
    submitBtn.disabled = true;

    var action = authIsLogin ? 'login' : 'signup';
    sendMsg({ type: 'SUPABASE_AUTH', action: action, email: email, password: password }, function(resp) {
      submitBtn.textContent = origText;
      submitBtn.disabled = false;

      if (!resp || resp.error) {
        var errMsg = (resp && resp.error) ? resp.error : 'Something went wrong. Please try again.';
        // Friendly error messages
        if (errMsg.indexOf('already registered') !== -1) errMsg = 'This email is already registered. Try logging in instead.';
        if (errMsg.indexOf('Invalid login') !== -1) errMsg = 'Incorrect email or password. Please try again.';
        errorEl.textContent = errMsg;
        errorEl.style.display = 'block';
        return;
      }

      // Auth successful
      currentUser = resp.user;

      // If login returned merged cards, update local state
      if (resp.cards && resp.cards.length > 0) {
        addedCards = resp.cards;
        detailsNewCardsStart = addedCards.length;
      }

      updateSettingsAccountUI();

      if (addedCards.length > 0) {
        showDoneScreen();
      } else {
        showScreen('screen-add-card');
      }
    });
  });

  // Forgot password — navigate to dedicated reset screen
  document.getElementById('btn-auth-forgot').addEventListener('click', function() {
    // Pre-fill email if user already typed one on login screen
    var loginEmail = document.getElementById('auth-email-input').value.trim();
    document.getElementById('reset-email-input').value = loginEmail;
    document.getElementById('reset-error').style.display = 'none';
    document.getElementById('reset-success').style.display = 'none';
    document.getElementById('btn-reset-submit').textContent = 'Send Reset Link';
    document.getElementById('btn-reset-submit').disabled = false;
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
    document.getElementById('screen-forgot-password').classList.add('active');
  });

  // Reset screen — send reset link
  document.getElementById('btn-reset-submit').addEventListener('click', function() {
    var email = document.getElementById('reset-email-input').value.trim();
    var errorEl = document.getElementById('reset-error');
    var successEl = document.getElementById('reset-success');

    if (!email) {
      errorEl.textContent = 'Please enter your email address.';
      errorEl.style.display = 'block';
      successEl.style.display = 'none';
      return;
    }

    errorEl.style.display = 'none';
    var submitBtn = document.getElementById('btn-reset-submit');
    submitBtn.textContent = 'Sending...';
    submitBtn.disabled = true;

    sendMsg({ type: 'SUPABASE_AUTH', action: 'reset_password', email: email }, function(resp) {
      submitBtn.textContent = 'Send Reset Link';
      submitBtn.disabled = false;
      if (resp && resp.error) {
        errorEl.textContent = resp.error;
        errorEl.style.display = 'block';
        successEl.style.display = 'none';
      } else {
        errorEl.style.display = 'none';
        successEl.style.display = 'block';
      }
    });
  });

  // Reset screen — enter key support
  document.getElementById('reset-email-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('btn-reset-submit').click();
  });

  // Reset screen — back to login
  document.getElementById('btn-reset-back').addEventListener('click', function() {
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
    document.getElementById('screen-auth-email').classList.add('active');
  });

  // Auth back button
  document.getElementById('btn-auth-back').addEventListener('click', function() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-signup').classList.add('active');
  });

  // Sign out
  document.getElementById('btn-sign-out').addEventListener('click', function() {
    // Clear local state immediately so UI updates even if message fails
    currentUser = null;
    addedCards = [];
    detailsNewCardsStart = 0;
    detailsCardIndex = 0;

    // Clear local storage
    browser.storage.local.remove(['vidava_cards', 'vidava_screen'], function() {});

    // Navigate to signup screen
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
    document.getElementById('screen-signup').classList.add('active');

    // Tell background to sign out of Supabase
    sendMsg({ type: 'SUPABASE_AUTH', action: 'logout' }, function() {});
  });

  // Card input — first card
  document.getElementById('btn-submit-card').addEventListener('click', () => {
    processInput(document.getElementById('card-input-1').value);
  });

  // Card input — not listed
  document.getElementById('btn-submit-notlisted').addEventListener('click', () => {
    processInput(document.getElementById('card-input-notlisted').value);
  });

  // Card input — add more
  document.getElementById('btn-submit-more').addEventListener('click', () => {
    const raw = document.getElementById('card-input-more').value.trim();
    if (!raw) return;
    processInput(raw);
  });

  // Done button
  document.getElementById('btn-done').addEventListener('click', () => {
    browser.storage.local.remove(['vidava_screen']);
    window.close();
  });

  // Enter key support
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    const active = document.querySelector('.screen.active');
    if (!active) return;
    if (active.id === 'screen-add-card') document.getElementById('btn-submit-card').click();
    if (active.id === 'screen-card-list') document.getElementById('btn-submit-notlisted').click();
    if (active.id === 'screen-card-added') document.getElementById('btn-submit-more').click();
    if (active.id === 'screen-card-details') document.getElementById('btn-details-save').click();
    if (active.id === 'screen-auth-email') document.getElementById('btn-auth-submit').click();
  });

});
