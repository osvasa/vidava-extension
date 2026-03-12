if (typeof browser === 'undefined') { var browser = chrome; }
// VIDAVA Content Script — multi-strategy payment page detection

function detectCheckoutPage() {
  // STRATEGY 1 — Label text scan
  try {
    var bodyText = (document.body.innerText || '').toLowerCase();
    if (/card\s*number|credit\s*card|payment\s*&\s*gift\s*cards|debit\s*card/i.test(bodyText)) return true;
  } catch(e) {}

  // STRATEGY 2 — Input field scan
  if (document.querySelector('input[autocomplete="cc-number"]')) return true;
  var inputs = document.querySelectorAll('input');
  for (var i = 0; i < inputs.length; i++) {
    var el = inputs[i];
    var allAttrs = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    if (/card.?number|cardnumber|cc.?num|credit.?card|\bcard\b|\bcc\b|\bcvv\b|security.?code|mm\s*\/\s*yy|expir/i.test(allAttrs)) return true;
  }
  var labels = document.querySelectorAll('label');
  for (var k = 0; k < labels.length; k++) {
    var labelText = (labels[k].textContent || '').toLowerCase();
    if (/card.?number|credit\s*card|cvv|security\s*code|mm\s*\/\s*yy|expir/i.test(labelText)) return true;
  }
  var iframes = document.querySelectorAll('iframe');
  for (var j = 0; j < iframes.length; j++) {
    var src = (iframes[j].src || '').toLowerCase();
    if (/stripe|braintree|adyen/i.test(src)) return true;
  }

  // STRATEGY 3 — URL pattern (last resort)
  var path = window.location.pathname.toLowerCase();
  if (/\/checkout\/payment|\/checkout\/billing|\/checkout\/review/i.test(path)) return true;
  if (/\/checkout\/?$/i.test(path)) return true;

  // STRATEGY 4 — Payment section heading
  var headings = document.querySelectorAll('h1, h2, h3, h4, label, div');
  for (var m = 0; m < headings.length; m++) {
    var hEl = headings[m];
    if (hEl.children.length > 3) continue;
    var hText = (hEl.textContent || '').trim();
    if (hText.length > 60) continue;
    if (/^payment$/i.test(hText) ||
        /^payment\s*&\s*gift\s*cards$/i.test(hText) ||
        /^pay\s*with$/i.test(hText) ||
        /^payment\s*method$/i.test(hText) ||
        /^choose\s*payment$/i.test(hText)) return true;
  }

  return false;
}

function checkAndStore() {
  if (detectCheckoutPage()) {
    browser.storage.local.set({ vidava_checkout_url: window.location.href });
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  checkAndStore();
} else {
  window.addEventListener('DOMContentLoaded', checkAndStore);
}
window.addEventListener('load', checkAndStore);
// The overlay is loaded separately via manifest content_scripts
