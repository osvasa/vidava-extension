if (typeof browser === 'undefined') { var browser = chrome; }

let addedCards = [];
let previousScreen = null;
let detailsCardIndex = 0; // which card we're currently adding details for
let detailsNewCardsStart = 0; // index of first card that hasn't had details prompt

function toTitleCase(str) {
  return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
}

function saveState(screenId) {
  browser.storage.local.set({ vidava_screen: screenId, vidava_cards: addedCards });
  console.log('[VIDAVA popup] saveState: saved', addedCards.length, 'cards to vidava_cards');
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
async function processInput(rawInput) {
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

    console.log('[VIDAVA popup] Sending message to background...');
    const response = await browser.runtime.sendMessage({ type: 'ASK_AI', prompt: prompt });
    console.log('[VIDAVA popup] Got response from background:', JSON.stringify(response).substring(0, 300));

    if (!response) throw new Error('No response received from background script');
    if (response.error) throw new Error(response.error);

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
  browser.storage.local.get('vidava_cards').then(function(result) {
    var cards = result.vidava_cards || [];
    var cardIndex = cards.findIndex(function(c) { return c.name === currentCardName; });
    if (cardIndex !== -1) {
      // Merge all fields from the local card into storage
      Object.assign(cards[cardIndex], addedCards[detailsCardIndex]);
    } else {
      cards = addedCards; // fallback: save entire local array
    }
    browser.storage.local.set({ vidava_cards: cards }).then(function() {
      console.log('[VIDAVA] saved card details:', JSON.stringify(cards[cardIndex !== -1 ? cardIndex : detailsCardIndex]));
      browser.storage.local.get('vidava_cards').then(function(r) {
        console.log('[VIDAVA] cards in storage after save:', JSON.stringify(r.vidava_cards));
      });
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

async function runCheckoutRecommendation(currentUrl) {
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

    const prompt = `You are a credit card rewards expert. The user is about to make a purchase at "${storeName}" (full URL: ${currentUrl}).

First, identify what kind of store "${storeName}" is and what spending category it falls under (e.g. groceries, travel, dining, gas, streaming, online retail, electronics, clothing, department store, etc.).

The user has these credit cards:
${cardDescriptions}

Based on the specific store "${storeName}" and knowing which credit cards earn the highest rewards at that type of store, recommend the SINGLE BEST card to use for this purchase.
If any card has a payment due within 5 days, warn the user.
If any card has high APR (>20%), note the interest cost risk.

Respond ONLY with a JSON object, no other text, no markdown, no code block.

Format:
{"cardName":"<exact card name from the user's list>","bank":"<bank name>","reason":"<2-3 sentences explaining WHY this card is best for purchasing at ${storeName} specifically. Mention the reward rate and why it beats the other cards.>"}

Respond ONLY with the JSON.`;

    console.log('[VIDAVA] Sending checkout recommendation for:', storeName);
    const response = await browser.runtime.sendMessage({ type: 'ASK_AI', prompt: prompt });

    if (!response || response.error) throw new Error(response ? response.error : 'No response');

    const result = parseAIResponse(response.text);

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
  browser.storage.local.get('vidava_cards').then(function(result) {
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
    browser.storage.local.set({ vidava_cards: cards }).then(function() {
      console.log('[VIDAVA] saved card details:', JSON.stringify(cards[cardIndex !== -1 ? cardIndex : settingsEditIndex]));
      browser.storage.local.get('vidava_cards').then(function(r) {
        console.log('[VIDAVA] cards in storage after save:', JSON.stringify(r.vidava_cards));
      });
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
    showDoneScreen();
  });

  // Hide all screens until we decide which one to show
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));

  browser.storage.local.get(['vidava_screen', 'vidava_cards']).then(async function(data) {
    if (data.vidava_cards && data.vidava_cards.length > 0) addedCards = data.vidava_cards;
    console.log('[VIDAVA popup] Loaded', addedCards.length, 'cards from vidava_cards');
    detailsNewCardsStart = addedCards.length; // existing cards already had their chance

    // Check if on checkout page
    if (addedCards.length > 0) {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const currentUrl = (tabs && tabs.length > 0) ? tabs[0].url : '';
        console.log('[VIDAVA] Current tab URL:', currentUrl);

        if (currentUrl && CHECKOUT_PATTERN.test(currentUrl)) {
          console.log('[VIDAVA] Checkout page detected, showing recommendation...');
          runCheckoutRecommendation(currentUrl);
          return;
        }
      } catch (err) {
        console.error('[VIDAVA] Could not query tabs:', err);
      }
    }

    // Normal state restore
    const screen = data.vidava_screen || 'screen-signup';
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
  });

  // Auth buttons
  ['btn-apple','btn-google','btn-microsoft','btn-email'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => showScreen('screen-add-card'));
  });
  document.getElementById('btn-login').addEventListener('click', () => showScreen('screen-add-card'));

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
    console.log('[VIDAVA popup] Done clicked — cleared screen state, cards preserved');
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
  });

});
