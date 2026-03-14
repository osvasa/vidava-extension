(function() {
'use strict';
console.log('[VIDAVA] script starting on: ' + window.location.href + ' (top=' + (window === window.top) + ')');
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

// ── If running inside an iframe, extract prices + payment signals and relay to parent ──
if (window !== window.top) {
  try {
    function relayData() {
      var text = document.body ? (document.body.innerText || '') : '';
      var re = /[\$£€]\s*([\d,]+\.\d{2})/g;
      var m, prices = [];
      while (m = re.exec(text)) { prices.push(m[0]); }
      // Detect payment form text visible inside this iframe
      var textLower = text.toLowerCase();
      var hasPaymentText = /payment\s*information|payment\s*details|billing\s*information|billing\s*details|enter\s*payment|card\s*details/i.test(textLower);
      var hasSummaryText = /purchase\s*summary|order\s*summary/i.test(textLower);
      if (prices.length > 0 || hasPaymentText || hasSummaryText) {
        window.parent.postMessage({
          type: 'VIDAVA_IFRAME_DATA',
          prices: prices,
          hasPaymentText: hasPaymentText,
          hasSummaryText: hasSummaryText,
          url: window.location.href
        }, '*');
      }
    }
    // Relay after load and on DOM changes
    if (document.readyState === 'complete') { relayData(); }
    else { window.addEventListener('load', relayData); }
    var relayObserver = new MutationObserver(function() {
      relayData();
    });
    if (document.body) {
      relayObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    } else {
      document.addEventListener('DOMContentLoaded', function() {
        if (document.body) relayObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        relayData();
      });
    }
  } catch(e) {}
  return;
}

console.log('[VIDAVA] content script loaded on: ' + window.location.href);

// ── Gate: exclude non-shopping domains ────────────────────────────────────
var excludedDomains = /claude\.ai|anthropic\.com|console\.anthropic/i;
if (excludedDomains.test(window.location.hostname)) { console.log('[VIDAVA] excluded domain — skipping'); return; }

// ── Gate: prevent double-injection ───────────────────────────────────────
if (document.getElementById('vidava-root')) { console.log('[VIDAVA] already injected — skipping'); return; }

// ── Listen for data relayed from iframes (prices + payment signals) ──────
var iframePricesReported = [];
var iframeHasPaymentText = false;
var iframeHasSummaryText = false;
var iframePricesFirstSeen = 0;
// Page-context script findings (for sandboxed widgets like BBC Angular checkout)
var pageContextHasPaymentText = false;
var pageContextPrices = [];
var pageContextFirstSeen = 0;
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'VIDAVA_IFRAME_DATA') {
    console.log('[VIDAVA] iframe data: payText=' + e.data.hasPaymentText + ' sumText=' + e.data.hasSummaryText + ' prices=' + (e.data.prices || []).length);
    if (Array.isArray(e.data.prices) && e.data.prices.length > 0) {
      if (iframePricesReported.length === 0) {
        iframePricesFirstSeen = Date.now();
      }
      iframePricesReported = e.data.prices;
    }
    if (e.data.hasPaymentText) iframeHasPaymentText = true;
    if (e.data.hasSummaryText) iframeHasSummaryText = true;
  }
  if (e.data && e.data.type === 'VIDAVA_PAGE_CONTEXT') {
    console.log('[VIDAVA] page-context data: payText=' + e.data.hasPaymentText + ' prices=' + (e.data.prices || []).length);
    if (e.data.hasPaymentText) pageContextHasPaymentText = true;
    if (Array.isArray(e.data.prices) && e.data.prices.length > 0) {
      if (pageContextPrices.length === 0) pageContextFirstSeen = Date.now();
      pageContextPrices = e.data.prices;
    }
  }
});

// ── Page-context scanner for subscription pages ──────────────────────────
// Detects payment data in Angular scopes, shadow DOM, and same-origin iframes.
// Firefox: uses wrappedJSObject (direct page-context access, bypasses CSP).
// Chrome: injects a <script> tag into the page.
(function initPageContextScanner() {
  var fullURL = (window.location.pathname + window.location.search + window.location.hash).toLowerCase();
  if (!/subscribe|subscription|purchase/i.test(fullURL)) return;
  console.log('[VIDAVA] subscribe URL detected — starting page-context scanner');

  var PAYMENT_RE = /payment\s*information|payment\s*details|billing\s*information|billing\s*details|enter\s*payment|card\s*details|card\s*number|cardholder/i;
  var PRICE_RE = /[\$£€]\s*([\d,]+\.\d{2})/g;

  // ── Shared scan logic (runs in content script for Firefox, in page for Chrome) ──

  function walkAllText(root) {
    var text = '';
    try {
      var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      var node;
      while (node = tw.nextNode()) { text += node.textContent + ' '; }
    } catch(e) {}
    try {
      var allEls = root.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        if (allEls[i].shadowRoot) text += walkAllText(allEls[i].shadowRoot);
      }
    } catch(e) {}
    return text;
  }

  function safeStringify(obj) {
    var seen = [];
    try {
      return JSON.stringify(obj, function(key, val) {
        if (key.charAt(0) === '$' || key === '$$hashKey') return undefined;
        if (typeof val === 'object' && val !== null) {
          if (seen.indexOf(val) !== -1) return undefined;
          seen.push(val);
        }
        return val;
      });
    } catch(e) { return ''; }
  }

  function scanAngular(angularRef) {
    var text = '';
    try {
      if (angularRef && angularRef.element) {
        var appEl = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
        var scope = angularRef.element(appEl).scope();
        if (scope) text += safeStringify(scope) + ' ';
        var scopeEls = document.querySelectorAll('.ng-scope');
        for (var si = 0; si < scopeEls.length && si < 50; si++) {
          try {
            var cs = angularRef.element(scopeEls[si]).scope();
            if (cs && cs !== scope) text += safeStringify(cs) + ' ';
          } catch(e) {}
        }
      }
    } catch(e) {}
    return text;
  }

  function doScan(angularRef) {
    var domText = walkAllText(document);
    // Check accessible iframes
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var iDoc = iframes[i].contentDocument || iframes[i].contentWindow.document;
          if (iDoc && iDoc.body) domText += ' ' + iDoc.body.textContent;
        } catch(e) {}
      }
    } catch(e) {}
    var hasPaymentText = PAYMENT_RE.test(domText);
    var allText = domText + ' ' + scanAngular(angularRef);
    var prices = [];
    var m;
    PRICE_RE.lastIndex = 0;
    while (m = PRICE_RE.exec(allText)) { prices.push(m[0]); }
    return { hasPaymentText: hasPaymentText, prices: prices };
  }

  function postResult(result) {
    if (result.hasPaymentText || result.prices.length > 0) {
      window.postMessage({
        type: 'VIDAVA_PAGE_CONTEXT',
        hasPaymentText: result.hasPaymentText,
        prices: result.prices
      }, '*');
    }
  }

  // ── Firefox: use wrappedJSObject for direct page-context access ──
  // wrappedJSObject bypasses CSP entirely — no script injection needed.
  if (window.wrappedJSObject) {
    console.log('[VIDAVA] Firefox detected — using wrappedJSObject for page context');
    function firefoxScan() {
      try {
        var pageAngular = window.wrappedJSObject.angular;
        var result = doScan(pageAngular);
        console.log('[VIDAVA] page-context scan (Firefox): payText=' + result.hasPaymentText + ' prices=' + result.prices.length);
        postResult(result);
      } catch(e) {
        console.log('[VIDAVA] Firefox page-context scan error:', e.message);
      }
    }
    setTimeout(firefoxScan, 2000);
    setTimeout(firefoxScan, 5000);
    setTimeout(firefoxScan, 10000);
    setInterval(firefoxScan, 5000);
    try {
      var ffObserver = new MutationObserver(function() { setTimeout(firefoxScan, 500); });
      ffObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch(e) {}
    return;
  }

  // ── Chrome: inject <script> into page context ──
  console.log('[VIDAVA] Chrome detected — injecting page-context script');
  var scriptCode = '(' + function() {
    var PAYMENT_RE = /payment\s*information|payment\s*details|billing\s*information|billing\s*details|enter\s*payment|card\s*details|card\s*number|cardholder/i;
    var PRICE_RE = /[\$\u00a3\u20ac]\s*([\d,]+\.\d{2})/g;
    function walkAllText(root) {
      var text = '';
      try {
        var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while (node = tw.nextNode()) { text += node.textContent + ' '; }
      } catch(e) {}
      try {
        var allEls = root.querySelectorAll('*');
        for (var i = 0; i < allEls.length; i++) {
          if (allEls[i].shadowRoot) text += walkAllText(allEls[i].shadowRoot);
        }
      } catch(e) {}
      return text;
    }
    function safeStringify(obj) {
      var seen = [];
      try {
        return JSON.stringify(obj, function(key, val) {
          if (key.charAt(0) === '$' || key === '$$hashKey') return undefined;
          if (typeof val === 'object' && val !== null) {
            if (seen.indexOf(val) !== -1) return undefined;
            seen.push(val);
          }
          return val;
        });
      } catch(e) { return ''; }
    }
    function scan() {
      var domText = walkAllText(document);
      try {
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var iDoc = iframes[i].contentDocument || iframes[i].contentWindow.document;
            if (iDoc && iDoc.body) domText += ' ' + iDoc.body.textContent;
          } catch(e) {}
        }
      } catch(e) {}
      var hasPaymentText = PAYMENT_RE.test(domText);
      var allText = domText;
      try {
        if (typeof angular !== 'undefined' && angular.element) {
          var appEl = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
          var scope = angular.element(appEl).scope();
          if (scope) allText += ' ' + safeStringify(scope);
          var scopeEls = document.querySelectorAll('.ng-scope');
          for (var si = 0; si < scopeEls.length && si < 50; si++) {
            try {
              var cs = angular.element(scopeEls[si]).scope();
              if (cs && cs !== scope) allText += ' ' + safeStringify(cs);
            } catch(e) {}
          }
        }
      } catch(e) {}
      var prices = [];
      var m;
      PRICE_RE.lastIndex = 0;
      while (m = PRICE_RE.exec(allText)) { prices.push(m[0]); }
      if (hasPaymentText || prices.length > 0) {
        window.postMessage({ type: 'VIDAVA_PAGE_CONTEXT', hasPaymentText: hasPaymentText, prices: prices }, '*');
      }
    }
    setTimeout(scan, 2000);
    setTimeout(scan, 5000);
    setTimeout(scan, 10000);
    setInterval(scan, 5000);
    var observer = new MutationObserver(function() { setTimeout(scan, 500); });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } + ')();';
  function inject() {
    var script = document.createElement('script');
    try {
      var blob = new Blob([scriptCode], { type: 'application/javascript' });
      script.src = URL.createObjectURL(blob);
    } catch(e) {
      script.textContent = scriptCode;
    }
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }
  if (document.head || document.documentElement) inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();

// ── Multi-strategy payment page detection ────────────────────────────────

var activated = false;

function detectPaymentPage() {
  var bodyText;
  try { bodyText = (document.body.innerText || '').toLowerCase(); } catch(e) { return null; }
  var path = window.location.pathname.toLowerCase();

  // ── NEGATIVE GATE: reject non-payment pages ──────────────────────
  // If the URL clearly indicates a non-payment step, bail out
  if (/\/checkout\/(shipping|address|delivery|fulfillment)/i.test(path)) {
    return null;
  }
  // Shopping bag/cart pages are NOT checkout — skip them
  if (/\/shopping-bag|\/shopping_bag|\/cart\b|\/bag\b/i.test(path)) {
    return null;
  }
  // If page prominently shows shipping step without payment, bail out
  var shippingHeadings = document.querySelectorAll('h1, h2, h3');
  for (var s = 0; s < shippingHeadings.length; s++) {
    var sText = (shippingHeadings[s].textContent || '').trim();
    if (sText.length > 60) continue;
    if (/^(shipping|delivery)\s*(address|method|options)?$/i.test(sText)) {
      // Only block if there is NO payment heading on the same page
      var hasPaymentHeading = false;
      for (var s2 = 0; s2 < shippingHeadings.length; s2++) {
        var s2Text = (shippingHeadings[s2].textContent || '').trim();
        if (/^payment|^pay\s*with|^payment\s*method|^choose\s*payment/i.test(s2Text)) {
          hasPaymentHeading = true; break;
        }
      }
      if (!hasPaymentHeading) return null;
    }
  }

  // ── EARLY DETECT: subscription/purchase pages at the card entry step ──
  var fullURL = (path + window.location.search + window.location.hash).toLowerCase();
  var isSubscribeURL = /subscribe|subscription|purchase/i.test(fullURL);
  var hasIframePrices = iframePricesReported.length > 0;
  var hasDollarAmount = /[\$£€]\s*[\d,]+\.\d{2}/.test(bodyText) || /(?:USD|GBP|EUR|CAD|AUD)\s*[\d,]+\.\d{2}/i.test(bodyText);

  // Also check textContent (includes text invisible to innerText, e.g. in sandboxed widgets)
  var fullTextContent = '';
  try { fullTextContent = (document.body.textContent || '').toLowerCase(); } catch(e) {}
  var paymentInTextContent = /payment\s*information|payment\s*details|billing\s*information|billing\s*details|card\s*details/i.test(fullTextContent);
  var priceInTextContent = /[\$£€]\s*[\d,]+\.\d{2}/.test(fullTextContent);

  // Subscribe URL + page-context script found payment text (Angular scope, shadow DOM, etc.)
  if (isSubscribeURL && pageContextHasPaymentText && pageContextPrices.length > 0) {
    return 'subscription payment step (page-context: payment text + prices)';
  }
  // Subscribe URL + page-context found payment text only (strong signal even without prices)
  if (isSubscribeURL && pageContextHasPaymentText) {
    return 'subscription payment step (page-context: payment text)';
  }
  // Subscribe URL + iframe prices received for 3+ seconds = payment step
  // The 3s delay ensures it's the payment form, not just the plan selection preloading
  if (isSubscribeURL && hasIframePrices && iframePricesFirstSeen > 0 && (Date.now() - iframePricesFirstSeen) > 3000) {
    return 'subscription payment step (iframe prices stable)';
  }
  // Subscribe URL + payment text found in textContent (covers sandboxed widgets)
  if (isSubscribeURL && paymentInTextContent && priceInTextContent) {
    return 'subscription payment step (payment text in textContent)';
  }
  // Subscribe URL + iframe payment text signal
  if (isSubscribeURL && iframeHasPaymentText) {
    return 'subscription payment step (iframe payment text)';
  }
  // Non-subscribe: purchase/order summary with a price
  var summaryTextOnPage = /purchase\s*summary|order\s*summary/i.test(bodyText) || /purchase\s*summary|order\s*summary/i.test(fullTextContent);
  if (summaryTextOnPage && (hasDollarAmount || hasIframePrices || priceInTextContent)) {
    return 'payment summary page (summary + price)';
  }

  // ── SIGNAL 1: Payment method present ───────────────────────────────
  var hasPayment = false;
  var paymentDetail = '';

  // Check for payment inputs (cc fields)
  if (document.querySelector('input[autocomplete="cc-number"]')) {
    hasPayment = true;
    paymentDetail = 'cc-number input';
  }

  // Check input fields for card-related attributes
  if (!hasPayment) {
    var inputs = document.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var allAttrs = [(el.name || ''), (el.id || ''), (el.placeholder || ''), (el.getAttribute('aria-label') || '')].join(' ').toLowerCase();
      if (/card.?number|cardnumber|cc.?num|\bcvv\b|security.?code|mm\s*\/\s*yy|expir/i.test(allAttrs)) {
        hasPayment = true;
        paymentDetail = 'card input field';
        break;
      }
    }
  }

  // Check labels and visible text elements for card references
  if (!hasPayment) {
    var cardTextRe = /card.?number|credit\s*card|cardholder|card.?holder|name\s*on\s*card|\bcvv\b|\bcvc\b|security\s*code/i;
    var labelsAndText = document.querySelectorAll('label, span, div, p, td, th, legend');
    for (var k = 0; k < labelsAndText.length; k++) {
      var ltEl = labelsAndText[k];
      if (ltEl.children.length > 3) continue;
      var lText = (ltEl.textContent || '').trim();
      if (lText.length > 40 || lText.length < 2) continue;
      if (ltEl.offsetWidth === 0 && ltEl.offsetHeight === 0) continue;
      if (cardTextRe.test(lText)) {
        hasPayment = true;
        paymentDetail = 'card label';
        break;
      }
    }
  }

  // Check for payment iframes (known payment processor domains)
  if (!hasPayment) {
    var paymentIframeRe = /stripe|braintree|adyen|square|checkout\.com|paypal|worldpay|cybersource|authorize\.net|secure\.[^.]+\.com\/payment|\/payment\//i;
    var iframes = document.querySelectorAll('iframe');
    for (var j = 0; j < iframes.length; j++) {
      var src = (iframes[j].src || '').toLowerCase();
      if (paymentIframeRe.test(src)) {
        hasPayment = true;
        paymentDetail = 'payment iframe: ' + src.substring(0, 60);
        break;
      }
    }
  }

  // Check for payment headings/labels
  if (!hasPayment) {
    var headings = document.querySelectorAll('h1, h2, h3, h4, label, div');
    for (var m = 0; m < headings.length; m++) {
      var hEl = headings[m];
      if (hEl.children.length > 3) continue;
      var hText = (hEl.textContent || '').trim();
      if (hText.length > 60) continue;
      if (/^payment$/i.test(hText) ||
          /^payment\s*&\s*gift\s*cards$/i.test(hText) ||
          /^pay\s*with$/i.test(hText) ||
          /^payment\s*(method|information|details)$/i.test(hText) ||
          /^choose\s*payment$/i.test(hText) ||
          /^(purchase|order)\s*summary$/i.test(hText) ||
          /^billing\s*(information|details)$/i.test(hText)) {
        hasPayment = true;
        paymentDetail = 'heading: "' + hText + '"';
        break;
      }
    }
  }

  // Check body text as last resort for payment signal
  if (!hasPayment) {
    if (/credit\s*card|debit\s*card|payment\s*&\s*gift\s*cards/i.test(bodyText)) {
      hasPayment = true;
      paymentDetail = 'body text (card/payment mention)';
    }
  }

  if (!hasPayment) return null;

  // ── SIGNAL 2: Tax line present ─────────────────────────────────────
  var hasTax = /\btax\b|\btaxes\b|\bestimated\s*tax\b|\bsales\s*tax\b|\btax\s*[:$]/i.test(bodyText);

  // ── SIGNAL 3: Order total present ──────────────────────────────────
  var hasTotal = /\btotal\b|\border\s*total\b|\bgrand\s*total\b|\btotal\s*price\b|\bprice\s*total\b|\bamount\s*due\b|\byou\s*pay\b/i.test(bodyText);

  // If payment was detected via actual card input fields or card labels (strong signal),
  // only require total OR tax — travel/booking sites often don't show a tax line
  var strongPayment = (paymentDetail === 'cc-number input' || paymentDetail === 'card input field' || paymentDetail === 'card label' || paymentDetail.indexOf('payment iframe') === 0);
  if (strongPayment && (hasTax || hasTotal)) {
    return 'strong payment + ' + (hasTax ? 'tax' : '') + (hasTotal ? ' total' : '') + ' (payment: ' + paymentDetail + ')';
  }

  // For weaker payment signals (headings, body text), require all three
  if (!hasTax) return null;
  if (!hasTotal) return null;

  return 'all signals (payment: ' + paymentDetail + ' + tax + total)';
}

function tryActivate(source) {
  if (activated) return;
  var strategy = detectPaymentPage();
  console.log('[VIDAVA] tryActivate(' + source + ') → ' + (strategy || 'no match'));
  if (strategy) {
    activated = true;
    console.log('[VIDAVA] triggered by ' + strategy + ' (detected via ' + source + ') — activating in 1.5s');
    setTimeout(function() { initOverlay(); }, 1500);
  }
}

// ── Session gate: only activate if user is logged in ──────────────────────
var gateObserver = null;
function startDetection() {
  // Check immediately
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    tryActivate('initial');
  } else {
    window.addEventListener('DOMContentLoaded', function() { tryActivate('DOMContentLoaded'); });
  }
  window.addEventListener('load', function() { tryActivate('load'); });
  try {
    gateObserver = new MutationObserver(function() { tryActivate('mutation'); });
    gateObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch(e) {}

  // Stop watching after 45 seconds if nothing found
  setTimeout(function() {
    if (!activated && gateObserver) {
      gateObserver.disconnect();
      console.log('[VIDAVA] no payment form found after 45s — stopping detection');
    }
  }, 45000);
}

// Check for valid Supabase session via background.js before injecting anything
console.log('[VIDAVA] checking session via background...');
sendMsg({ type: 'CHECK_SESSION' }, function(resp) {
  console.log('[VIDAVA] session check result:', JSON.stringify(resp));
  if (resp && resp.hasSession) {
    console.log('[VIDAVA] session found — starting detection');
    startDetection();
  } else {
    console.log('[VIDAVA] no active session — overlay disabled');
  }
});

// Everything below only runs when activated
function initOverlay() {
  if (gateObserver) gateObserver.disconnect();
  if (document.getElementById('vidava-root')) return;

// ── DOM Scanning ─────────────────────────────────────────────────────────

function scanStore() {
  var m = document.querySelector('meta[property="og:site_name"]');
  if (m && m.content) return m.content.trim();
  var host = window.location.hostname
    .replace(/^secure-www\./, '')
    .replace(/^secure-/, '')
    .replace(/^www\./, '');
  // Extract each subdomain part for brand matching (e.g. "oldnavy.gap.com" → try "oldnavy", then "gap")
  var parts = host.replace(/\.(com|org|net|co|io|shop|store|uk|ca|de|fr|au|in|es|it|jp|gov).*$/, '').split('.');
  var brands = {
    'gap': 'Gap', 'oldnavy': 'Old Navy', 'bananarepublic': 'Banana Republic',
    'bestbuy': 'Best Buy', 'amazon': 'Amazon', 'walmart': 'Walmart',
    'target': 'Target', 'costco': 'Costco', 'homedepot': 'Home Depot',
    'macys': 'Macy\'s', 'nordstrom': 'Nordstrom', 'nike': 'Nike',
    'adidas': 'Adidas', 'apple': 'Apple', 'sephora': 'Sephora',
    'ulta': 'Ulta', 'kohls': 'Kohl\'s', 'jcpenney': 'JCPenney',
    'newegg': 'Newegg', 'wayfair': 'Wayfair', 'ikea': 'IKEA',
    'lowes': 'Lowe\'s', 'ebay': 'eBay', 'etsy': 'Etsy',
    'bhphotovideocom': 'B&H Photo', 'zappos': 'Zappos',
    'lululemon': 'Lululemon', 'rei': 'REI', 'asos': 'ASOS',
    'zara': 'Zara', 'uniqlo': 'Uniqlo', 'hm': 'H&M',
    'tjmaxx': 'TJ Maxx', 'marshalls': 'Marshalls', 'burlington': 'Burlington'
  };
  // Try each subdomain part against brand map (first part wins, e.g. "oldnavy" before "gap")
  for (var i = 0; i < parts.length; i++) {
    var key = parts[i].replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (brands[key]) return brands[key];
  }
  // Fallback: title case the first part
  var fallback = parts[0] || host;
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

// ── Order Total Detection ────────────────────────────────────────────────

function tryFindTotal(attempt) {
  var label = attempt !== undefined ? ('retry attempt ' + attempt) : 'initial';

  var fullText = '';
  try { fullText = document.body.innerText || ''; } catch(e){}

  // Labels that mean FINAL total (includes tax + shipping)
  var finalTotalRe = /^(order\s*total|grand\s*total|total|total\s*due|amount\s*due|you\s*pay|total\s*price|price\s*total)\s*$/i;
  // Looser version: "Total" at start followed by anything (e.g. "Total $49.99 for year 1")
  var totalStartRe = /^(order\s*total|grand\s*total|total)\b/i;
  // Labels to SKIP — these are NOT the final total
  var skipRe = /subtotal|sub\s*total|est\.?\s*total|estimated\s*total|savings|discount|you\s*save|promo/i;
  // Price patterns: $123.45 or USD 123.45 or USD123.45
  var priceReFn = function(text) {
    var m = text.match(/\$\s*([\d,]+\.\d{2})/) || text.match(/(?:USD|EUR|GBP|CAD|AUD|NZD|SGD|HKD|JPY|KRW|THB|MXN|BRL|INR|CHF|SEK|NOK|DKK|MYR|PHP|IDR|TWD|ZAR)\s*([\d,]+\.\d{2})/i);
    return m;
  };

  // ── Method 1: DOM walk — find element labeled "Total" / "Order Total" / "Grand Total" ──
  // Prioritize exact final-total labels, skip subtotals and discounts
  var allEls = document.querySelectorAll('*');
  var candidates = [];

  for (var j = 0; j < allEls.length; j++) {
    var el = allEls[j];
    if (el.children.length > 4) continue;
    var elText = (el.textContent || '').trim();
    if (elText.length > 80) continue;

    // Skip anything that looks like subtotal, discount, savings
    if (skipRe.test(elText)) continue;

    // Must match a final total label
    // Also match "Total $52.42" style (label + price on same element)
    var labelOnly = elText.replace(/\$\s*[\d,]+\.\d{2}/, '').replace(/(?:USD|EUR|GBP|CAD|AUD)\s*[\d,]+\.\d{2}/i, '').trim();
    // Check strict match first, then looser "Total ..." match
    var isStrictMatch = finalTotalRe.test(labelOnly) || finalTotalRe.test(elText);
    var isLooseMatch = !isStrictMatch && (totalStartRe.test(labelOnly) || totalStartRe.test(elText));
    if (!isStrictMatch && !isLooseMatch) continue;

    // Extract price from: the element itself, siblings, parent's children, parent's siblings,
    // and grandparent's children (handles nested row layouts like <tr><td>Total</td><td>$52.42</td></tr>)
    var searchEls = [el];
    var next = el.nextElementSibling;
    var count = 0;
    while (next && count < 5) { searchEls.push(next); next = next.nextElementSibling; count++; }
    // Check parent row
    if (el.parentElement) {
      var parent = el.parentElement;
      var parentSib = parent.nextElementSibling;
      if (parentSib) searchEls.push(parentSib);
      // Check all children of the same parent
      var parentKids = parent.children;
      for (var pk = 0; pk < parentKids.length; pk++) {
        if (parentKids[pk] !== el) searchEls.push(parentKids[pk]);
      }
      // Check grandparent's children (one level up, e.g. <div><span>Total</span></div><div>$52.42</div>)
      if (parent.parentElement) {
        var gpKids = parent.parentElement.children;
        for (var gk = 0; gk < gpKids.length; gk++) {
          if (gpKids[gk] !== parent) searchEls.push(gpKids[gk]);
        }
      }
    }

    for (var k = 0; k < searchEls.length; k++) {
      var priceMatch = priceReFn(searchEls[k].textContent || '');
      if (priceMatch) {
        var pv = parseFloat(priceMatch[1].replace(/,/g, ''));
        if (pv >= 1 && pv <= 99999) {
          // Weight: "Order Total" and "Grand Total" get highest priority; loose matches get lower
          var weight = /order\s*total|grand\s*total/i.test(labelOnly || elText) ? 3 : (isLooseMatch ? 0 : 1);
          // Boost elements that are bold or larger (common for final totals)
          try {
            var style = window.getComputedStyle(searchEls[k]);
            var fw = parseInt(style.fontWeight) || 400;
            if (fw >= 700) weight += 1;
          } catch(e) {}
          candidates.push({ value: pv, weight: weight });
          break;
        }
      }
    }
  }

  // Pick the highest-weighted candidate; if tied, pick the largest value
  if (candidates.length > 0) {
    candidates.sort(function(a, b) {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return b.value - a.value;
    });
    return candidates[0].value;
  }

  // ── Method 2: Line-by-line text scan — find "Total" (not Subtotal) lines ──
  var lines = fullText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    // Skip subtotals, discounts, savings
    if (skipRe.test(line)) continue;

    if (/^(order\s*total|grand\s*total|total|total\s*price|price\s*total)\b/i.test(line)) {
      // Check this line for a price
      var sameLine = priceReFn(line);
      if (sameLine) {
        var v = parseFloat(sameLine[1].replace(/,/g, ''));
        if (v >= 1 && v <= 99999) return v;
      }
      // Check the next line
      if (i + 1 < lines.length && !skipRe.test(lines[i + 1])) {
        var nextLine = priceReFn(lines[i + 1]);
        if (nextLine) {
          var v2 = parseFloat(nextLine[1].replace(/,/g, ''));
          if (v2 >= 1 && v2 <= 99999) return v2;
        }
      }
    }
  }

  // ── Method 3: Fallback — only use if very few prices on page ──
  // If there are many prices (product listings, shopping bags), we can't reliably
  // pick the total, so skip the fallback to avoid grabbing a wrong amount.
  var allPrices = [];
  var fallbackRe = /(?:\$|USD|EUR|GBP|CAD|AUD|NZD|SGD|HKD|JPY|KRW|THB|MXN|BRL|INR|CHF|SEK|NOK|DKK|MYR|PHP|IDR|TWD|ZAR)\s*([\d,]+\.\d{2})/gi;
  var pm;
  while (pm = fallbackRe.exec(fullText)) {
    var pval = parseFloat(pm[1].replace(/,/g, ''));
    if (pval >= 1 && pval <= 99999) allPrices.push(pval);
  }

  // Only use fallback if there are 1-3 unique prices — more than that suggests a
  // product listing page where we can't distinguish total from item prices
  var uniquePrices = allPrices.filter(function(v, i, a) { return a.indexOf(v) === i; });
  if (uniquePrices.length > 0 && uniquePrices.length <= 3) {
    return Math.max.apply(null, uniquePrices);
  }

  // ── Method 4: scan same-origin iframes and page HTML for prices ──
  // Some sites (BBC, etc.) render prices inside iframes or Angular widgets
  // that aren't in innerText but may be in DOM attributes or same-origin iframe content
  try {
    // Check data attributes and aria-labels for prices
    var priceEls = document.querySelectorAll('[data-price], [data-amount], [data-total], [aria-label]');
    for (var pe = 0; pe < priceEls.length; pe++) {
      var pAttr = (priceEls[pe].getAttribute('data-price') || priceEls[pe].getAttribute('data-amount') || priceEls[pe].getAttribute('data-total') || priceEls[pe].getAttribute('aria-label') || '');
      var pAttrMatch = priceReFn(pAttr);
      if (pAttrMatch) {
        var pav = parseFloat(pAttrMatch[1].replace(/,/g, ''));
        if (pav >= 1 && pav <= 99999) return pav;
      }
    }

    // Scan same-origin iframes
    var iframes = document.querySelectorAll('iframe');
    var iframePrices = [];
    for (var fi = 0; fi < iframes.length; fi++) {
      try {
        var iDoc = iframes[fi].contentDocument || iframes[fi].contentWindow.document;
        if (!iDoc || !iDoc.body) continue;
        var iText = (iDoc.body.innerText || '');
        var iLines = iText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
        for (var il = 0; il < iLines.length; il++) {
          if (skipRe.test(iLines[il])) continue;
          if (/^(order\s*total|grand\s*total|total|total\s*price)\b/i.test(iLines[il])) {
            var iMatch = priceReFn(iLines[il]);
            if (iMatch) {
              var iv = parseFloat(iMatch[1].replace(/,/g, ''));
              if (iv >= 1 && iv <= 99999) return iv;
            }
          }
        }
        // Collect all prices from iframe as fallback
        var iPm;
        while (iPm = fallbackRe.exec(iText)) {
          var iPval = parseFloat(iPm[1].replace(/,/g, ''));
          if (iPval >= 1 && iPval <= 99999) iframePrices.push(iPval);
        }
        fallbackRe.lastIndex = 0;
      } catch(crossOriginErr) {}
    }
    if (iframePrices.length > 0 && iframePrices.length <= 3) {
      iframePrices.sort(function(a, b) { return a - b; });
      return iframePrices[0];
    }
  } catch(e) {}

  // ── Method 5: scan raw page HTML for prices near "total" ──
  // Last resort for sites where prices are in the DOM but not in innerText
  // (e.g. hidden by CSS, inside Angular bindings, or in element attributes)
  try {
    var rawHTML = document.body.innerHTML || '';
    var totalHTMLRe = /total[^<]{0,40}[\$£€]\s*([\d,]+\.\d{2})/i;
    var htmlMatch = rawHTML.match(totalHTMLRe);
    if (!htmlMatch) {
      var totalHTMLRe2 = /[\$£€]\s*([\d,]+\.\d{2})[^<]{0,40}total/i;
      htmlMatch = rawHTML.match(totalHTMLRe2);
    }
    if (htmlMatch) {
      var hv = parseFloat(htmlMatch[1].replace(/,/g, ''));
      if (hv >= 1 && hv <= 99999) return hv;
    }
  } catch(e) {}

  // ── Method 6: use prices relayed from iframes via postMessage ──
  // Handles cross-origin iframes (BBC checkout widget, etc.)
  if (iframePricesReported.length > 0) {
    var relayedPrices = [];
    for (var rp = 0; rp < iframePricesReported.length; rp++) {
      var rpMatch = iframePricesReported[rp].match(/[\$£€]\s*([\d,]+\.\d{2})/);
      if (rpMatch) {
        var rpv = parseFloat(rpMatch[1].replace(/,/g, ''));
        if (rpv >= 1 && rpv <= 99999) relayedPrices.push(rpv);
      }
    }
    if (relayedPrices.length > 0) {
      // Prefer the smallest price (current term for subscriptions)
      relayedPrices.sort(function(a, b) { return a - b; });
      return relayedPrices[0];
    }
  }

  // ── Method 7: use prices from page-context script (Angular scope, shadow DOM) ──
  if (pageContextPrices.length > 0) {
    var ctxPrices = [];
    for (var cp = 0; cp < pageContextPrices.length; cp++) {
      var cpMatch = pageContextPrices[cp].match(/[\$£€]\s*([\d,]+\.\d{2})/);
      if (cpMatch) {
        var cpv = parseFloat(cpMatch[1].replace(/,/g, ''));
        if (cpv >= 1 && cpv <= 99999) ctxPrices.push(cpv);
      }
    }
    if (ctxPrices.length > 0) {
      // For subscriptions, prefer the largest price (total annual cost, not monthly)
      ctxPrices.sort(function(a, b) { return b - a; });
      return ctxPrices[0];
    }
  }

  return null;
}

// State for total detection
var detectedTotal = null;

function scanItems() {
  var items = [];
  ['[class*="product-name"]','[class*="productName"]','[class*="item-title"]',
   '[class*="product-title"]','[class*="cart-item"] h2','[class*="cart-item"] h3',
   '[class*="line-item"] [class*="name"]'].forEach(function(s) {
    try { document.querySelectorAll(s).forEach(function(el) {
      var n = (el.textContent || '').trim();
      if (n.length > 2 && n.length < 100 && items.indexOf(n) === -1) items.push(n);
    }); } catch(e){}
  });
  return items.slice(0, 6);
}

function detectCategory(store) {
  var s = store.toLowerCase();
  var map = {
    grocery: /walmart|target|costco|kroger|safeway|aldi|publix|wholefood|trader.?joe|instacart|freshdirect|heb/,
    dining: /doordash|grubhub|uber.?eat|seamless|caviar|postmate|chipotle|mcdonald|starbuck|domino/,
    travel: /expedia|booking|airbnb|hotel|marriott|hilton|united|delta|american.?air|southwest|kayak|priceline|vrbo|agoda/,
    gas: /shell|chevron|exxon|bp|mobil|sunoco|circle.?k|wawa|speedway|quiktrip/,
    electronics: /bestbuy|best.?buy|apple|newegg|bhphoto|adorama|micro.?center/,
    clothing: /gap|oldnavy|banana.?republic|zara|hm|uniqlo|nordstrom|macys|nike|adidas|lululemon|shein|asos/,
    streaming: /netflix|hulu|disney|spotify|youtube|hbo|paramount|peacock|apple.?tv/,
    home: /ikea|wayfair|homedepot|lowes|crateandbarrel|potterybarn|williams.?sonoma|overstock|restoration/,
    beauty: /sephora|ulta|glossier|fenty|mac|clinique|nyx|bath.?body/,
    pharmacy: /cvs|walgreens|rite.?aid|pharmacy|drugstore/,
    department: /amazon|ebay|etsy|shopify|walmart|target|kohls|jcpenney|sears|burlington|tjmaxx|marshalls/
  };
  for (var cat in map) { if (map[cat].test(s)) return cat; }
  return 'online retail';
}

// ── Inject Root ──────────────────────────────────────────────────────────

var root = document.createElement('div');
root.id = 'vidava-root';
root.style.cssText = 'all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;';
document.body.appendChild(root);

var shadow = root.attachShadow({ mode: 'closed' });

// Load CSS
var cssLink = document.createElement('link');
cssLink.rel = 'stylesheet';
cssLink.href = browser.runtime.getURL('vidava-overlay.css');
shadow.appendChild(cssLink);

// Build HTML — pill button (minimized state) + panel
var wrap = document.createElement('div');
wrap.innerHTML =
  '<div class="v-pill-wrap" id="v-pill-wrap" style="position:relative;">' +
    '<button class="v-pill" id="v-pill" style="display:flex !important;align-items:center !important;justify-content:center !important;width:64px !important;height:40px !important;background:#000 !important;border:none !important;border-radius:12px !important;padding:0 !important;cursor:pointer;box-shadow:0 4px 24px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;">' +
      '<img id="v-pill-logo" style="display:none;width:20px !important;height:20px !important;max-width:20px !important;max-height:20px !important;min-width:0;min-height:0;object-fit:contain;border-radius:0;flex-shrink:0;flex-grow:0;"/>' +
      '<span class="v-pill-letter" id="v-pill-letter" style="font-size:16px;font-weight:800;color:#00e5cc;line-height:1;">V</span>' +
    '</button>' +
  '</div>' +
  '<div class="v-panel" id="v-panel" style="display:none;width:388px;max-height:65vh;overflow:hidden;background:#000;border:none;border-radius:16px;flex-direction:column;color:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;box-shadow:0 10px 50px rgba(0,0,0,0.55);">' +
    '<div class="v-header" style="display:flex !important;align-items:center !important;justify-content:space-between !important;padding:10px 18px;border-bottom:1px solid rgba(255,255,255,0.05);flex-shrink:0;overflow:visible;">' +
      '<div class="v-brand" style="display:flex !important;align-items:center !important;gap:10px;flex:1;justify-content:center;margin-left:64px;">' +
        '<img id="v-brand-logo" class="v-brand-logo" style="display:none;width:36px !important;height:36px !important;max-width:36px !important;max-height:36px !important;min-width:0;min-height:0;object-fit:contain;border-radius:0;flex-shrink:0;flex-grow:0;"/>' +
        '<span class="v-brand-letter" id="v-brand-letter" style="width:32px;height:32px;border-radius:8px;background:rgba(0,229,204,0.1);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#00e5cc;flex-shrink:0;line-height:1;">V</span>' +
      '</div>' +
      '<div class="v-controls" style="display:flex !important;gap:4px;">' +
        '<button class="v-ctrl" id="v-min" title="Minimize" style="width:30px !important;height:30px !important;border-radius:8px;border:none !important;background:transparent !important;cursor:pointer;display:flex !important;align-items:center !important;justify-content:center !important;padding:0 !important;"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:#00e5cc;fill:none;stroke-width:2;stroke-linecap:round;"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>' +
        '<button class="v-ctrl" id="v-close" title="Close" style="width:30px !important;height:30px !important;border-radius:8px;border:none !important;background:transparent !important;cursor:pointer;display:flex !important;align-items:center !important;justify-content:center !important;padding:0 !important;"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:#00e5cc;fill:none;stroke-width:2;stroke-linecap:round;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
    '</div>' +
    '<div class="v-body" id="v-body" style="padding:6px 18px 14px;overflow-y:auto;flex:1;word-wrap:break-word;overflow-wrap:break-word;min-width:0;"></div>' +
  '</div>';
shadow.appendChild(wrap);

// ── Refs ─────────────────────────────────────────────────────────────────

var pill = shadow.getElementById('v-pill');
var pillWrap = shadow.getElementById('v-pill-wrap');
var panel = shadow.getElementById('v-panel');
var body = shadow.getElementById('v-body');

// Logo — set src directly, hide fallback letter on successful load
var logoUrl = browser.runtime.getURL('logo.png');
var animatedLogoUrl = browser.runtime.getURL('vidava-logo-animated.gif');
var pillLogo = shadow.getElementById('v-pill-logo');
var brandLogo = shadow.getElementById('v-brand-logo');
pillLogo.src = logoUrl;
brandLogo.src = animatedLogoUrl;
pillLogo.onload = function() {
  pillLogo.style.display = 'block';
  shadow.getElementById('v-pill-letter').style.display = 'none';
};
brandLogo.onload = function() {
  brandLogo.style.display = 'block';
  shadow.getElementById('v-brand-letter').style.display = 'none';
};

// ── Panel State ──────────────────────────────────────────────────────────

var isOpen = false;
var closed = false;
var analyzed = false;
var paymentTriggered = false;

function open() {
  pillWrap.style.display = 'none';
  panel.style.display = 'flex';
  panel.classList.remove('v-out');
  isOpen = true;
}

function close() {
  panel.classList.add('v-out');
  setTimeout(function() {
    panel.style.display = 'none';
    panel.classList.remove('v-out');
    isOpen = false;
    closed = true;
    pillWrap.style.display = 'none';
  }, 300);
}

function minimize() {
  panel.classList.add('v-out');
  setTimeout(function() {
    panel.style.display = 'none';
    panel.classList.remove('v-out');
    isOpen = false;
    pillWrap.style.display = 'block';
  }, 300);
}

pill.addEventListener('click', function() {
  if (closed) return;
  if (!paymentTriggered) {
    // Show standing-by screen — header animated logo stays visible
    open();
    body.style.padding = '0 18px 14px';
    if (!shadow.getElementById('v-standby-style')) {
      var st = document.createElement('style');
      st.id = 'v-standby-style';
      st.textContent = '@keyframes v-breathe { 0%,100%{opacity:1} 50%{opacity:0.4} }';
      shadow.appendChild(st);
    }
    setBody(
      '<div style="display:flex;flex-direction:column;align-items:center;padding:0 8px 16px;text-align:center;">' +
        '<div style="font-size:13px;color:rgba(255,255,255,0.35);line-height:1.6;font-weight:400;animation:v-breathe 2s ease-in-out infinite;">' +
          'Analyzing your purchase... The best card selection is coming right up.' +
        '</div>' +
      '</div>'
    );
    return;
  }
  // Restore header brand logo and body padding for normal flow
  brandLogo.style.display = 'block';
  body.style.padding = '';
  open();
  if (!analyzed) analyze();
});
shadow.getElementById('v-min').addEventListener('click', minimize);
shadow.getElementById('v-close').addEventListener('click', close);

// ── Helpers ──────────────────────────────────────────────────────────────

function esc(s) { var d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

function parseJSON(text) {
  var t = text.trim();
  var m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) t = m[1].trim();
  return JSON.parse(t);
}

function setBody(html) { body.innerHTML = html; }

// ── Amortization ─────────────────────────────────────────────────────────

function amortize(principal, apr, months) {
  var r = apr / 12 / 100;
  if (r === 0) return principal;
  var pmt = principal * r / (1 - Math.pow(1 + r, -months));
  return Math.round(pmt * months * 100) / 100;
}

function buildTable(total, lowApr, highApr, customApr) {
  var periods = [3, 6, 12];
  var td = 'padding:5px 8px;border:1px solid #222;';
  var h = '';
  h += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
  // Header row
  h += '<tr>';
  h += '<td style="' + td + '"></td>';
  periods.forEach(function(p) {
    h += '<td style="' + td + 'color:#00e5cc;font-weight:700;text-align:center;">' + p + ' months</td>';
  });
  h += '</tr>';
  if (customApr) {
    // Single exact APR row — teal label
    h += '<tr>';
    h += '<td style="' + td + 'color:#00e5cc;font-weight:700;white-space:nowrap;">Your APR (' + customApr + '%)</td>';
    periods.forEach(function(p) {
      h += '<td style="' + td + 'color:#FFD932;font-weight:700;text-align:center;">$' + amortize(total, customApr, p).toFixed(2) + '</td>';
    });
    h += '</tr>';
  } else {
    // Low APR row
    h += '<tr>';
    h += '<td style="' + td + 'color:#fff;white-space:nowrap;">Low APR (' + lowApr + '%)</td>';
    periods.forEach(function(p) {
      h += '<td style="' + td + 'color:#FFD932;font-weight:700;text-align:center;">$' + amortize(total, lowApr, p).toFixed(2) + '</td>';
    });
    h += '</tr>';
    // High APR row
    if (highApr && highApr !== lowApr) {
      h += '<tr>';
      h += '<td style="' + td + 'color:#fff;white-space:nowrap;">High APR (' + highApr + '%)</td>';
      periods.forEach(function(p) {
        h += '<td style="' + td + 'color:#FFD932;font-weight:700;text-align:center;">$' + amortize(total, highApr, p).toFixed(2) + '</td>';
      });
      h += '</tr>';
    }
  }
  h += '</table>';
  return h;
}

// ── Amount Change Watcher ─────────────────────────────────────────────────
// After a recommendation is shown, poll for total changes (tax, shipping,
// travel protection added after initial render). If the total changes by
// more than $0.50, wait 3s for it to stabilize, then auto-refresh.

var amountWatcherInterval = null;

function startAmountWatcher() {
  if (amountWatcherInterval) clearInterval(amountWatcherInterval);
  var lastKnownTotal = detectedTotal;
  var debounceTimer = null;
  var pendingTotal = null;

  amountWatcherInterval = setInterval(function() {
    var newTotal = tryFindTotal('amount-watch');
    if (!newTotal || newTotal < 1) return;

    // Check if changed by more than $0.50
    var diff = Math.abs(newTotal - (lastKnownTotal || 0));
    if (diff <= 0.50) {
      // Amount stable — cancel any pending refresh
      if (debounceTimer && newTotal === pendingTotal) return; // still waiting on same change
      if (debounceTimer && newTotal !== pendingTotal) {
        // Amount changed again — reset debounce
        clearTimeout(debounceTimer);
        debounceTimer = null;
        pendingTotal = null;
      }
      return;
    }

    // Amount changed significantly
    if (debounceTimer && newTotal === pendingTotal) return; // already debouncing this amount

    // Reset debounce if amount keeps changing
    if (debounceTimer) clearTimeout(debounceTimer);
    pendingTotal = newTotal;
    console.log('[VIDAVA] amount change detected: $' + (lastKnownTotal || 0).toFixed(2) + ' → $' + newTotal.toFixed(2) + ' — waiting 3s to stabilize');

    debounceTimer = setTimeout(function() {
      // Re-check total after 3s — use whatever it is now (may have changed again)
      var stableTotal = tryFindTotal('amount-stable');
      if (!stableTotal || stableTotal < 1) stableTotal = pendingTotal;

      var finalDiff = Math.abs(stableTotal - (lastKnownTotal || 0));
      if (finalDiff <= 0.50) {
        // Settled back to roughly the same amount — no refresh needed
        debounceTimer = null;
        pendingTotal = null;
        return;
      }

      console.log('[VIDAVA] amount stabilized at $' + stableTotal.toFixed(2) + ' — refreshing recommendation');
      lastKnownTotal = stableTotal;
      detectedTotal = stableTotal;
      pendingTotal = null;
      debounceTimer = null;

      // Re-run analysis in background — keep old recommendation visible
      reanalyze();
    }, 3000);
  }, 2000);

  // Stop watching after 5 minutes
  setTimeout(function() {
    if (amountWatcherInterval) {
      clearInterval(amountWatcherInterval);
      if (debounceTimer) clearTimeout(debounceTimer);
    }
  }, 300000);
}

// ── Analyze ──────────────────────────────────────────────────────────────

function reanalyze() {
  // Show a subtle spinner overlay on the existing recommendation — don't replace content
  var existing = body.querySelector('.v-ctx') || body.firstElementChild;
  if (existing) {
    var overlay = document.createElement('div');
    overlay.id = 'v-reanalyze-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;border-radius:16px;';
    overlay.innerHTML = '<div class="v-loader" style="width:28px;height:28px;"></div>';
    body.style.position = 'relative';
    body.appendChild(overlay);
  }

  // Run analysis in background, then swap everything atomically
  browser.storage.local.get(['vidava_cards'], function(data) {
    var cards = data.vidava_cards;
    if (!cards || cards.length === 0) return;

    var store = scanStore();
    var total = detectedTotal;
    var items = scanItems();
    var category = detectCategory(store);
    var totalStr = total ? '$' + total.toFixed(2) : 'I could not find your total — but I am still here to help';

    var cardList = cards.map(function(c, i) {
      var d = (i + 1) + '. Card: ' + c.name + '\n';
      d += '   Bank: ' + c.bank + '\n';
      if (c.apr) d += '   User\'s exact APR: ' + c.apr + '%\n';
      if (c.dueDay) d += '   Payment due: day ' + c.dueDay + ' of each month\n';
      if (c.creditLimit) d += '   Credit limit: $' + c.creditLimit + '\n';
      d += '   Rewards: ' + c.rewards + '\n';
      d += '   Best for: ' + c.bestFor;
      return d;
    }).join('\n\n');

    var itemsStr = items.length > 0 ? '\nCart items: ' + items.join(', ') : '';
    var isSingleCard = cards.length === 1;

    var writingRules;
    if (isSingleCard) {
      writingRules =
        'WRITING RULES FOR "reasons" ARRAY (USER HAS ONLY ONE CARD — do NOT compare to other cards):\n' +
        '- Bullet 1 (REQUIRED): What rewards this card earns at this specific store. Be specific about the rate and dollar value.\n' +
        '- Bullet 2 (REQUIRED): APR context — explain what their APR means for this purchase if carried as a balance over 12 months.\n' +
        '- Bullet 3 (ONLY if relevant): Due date warning — only include if payment is due within 7 days.\n' +
        '- FINAL bullet (REQUIRED): "Bottom line:" — frame around the true cost of this purchase on their card (interest + rewards). Example: "Bottom line: at 24.99% APR and 3% cash back, this $50 purchase would cost you $57.20 over 12 months, but you earn $1.50 back."\n' +
        '- NEVER compare to other cards or mention "next best card" — the user only has this one card.\n';
    } else {
      writingRules =
        'WRITING RULES FOR "reasons" ARRAY — write bullets in this EXACT order:\n' +
        '- Bullet 1 (REQUIRED): APR comparison — "Your [card] has the lowest APR at X% — on this $XX purchase carried for 12 months you pay $XX total vs $XX on [other card name]"\n' +
        '- Bullet 2 (REQUIRED): Rewards comparison for this specific store — name the other card and explain why it earns less here.\n' +
        '- Bullet 3 (ONLY if relevant): Due date warning — only include if a card payment is due within 7 days.\n' +
        '- Bullet 4: NEVER mention credit limit unless a card would actually be declined.\n' +
        '- FINAL bullet (REQUIRED): "Bottom line:" — always frame around total true cost (APR + rewards combined). Example: "Bottom line: at 12.5% APR and 2% cash back, this card saves you the most on this purchase today." Must use a DIFFERENT verb than "picked" — use chose, selected, recommend, highlighted, identified, or spotlighted.\n';
    }

    var prompt =
      'You are VIDAVA, a personal AI card assistant. You speak in first person singular — always "I", never "we", never refer to yourself in third person. You are like a trusted older friend or mentor who knows every major US credit card inside and out — rewards rates, APR ranges, annual fees, perks. Write every explanation as if you are talking to an 18-25 year old using their first credit card. Be warm, encouraging, and protective. Never talk down to them. Use "you" and "your" constantly to make it personal. Say "I analyzed your cards", "I recommend", "I found", "I picked this card for you". Explain every financial concept in the simplest possible words. Make them feel smart for using you, not confused by finance. No jargon. Short sentences. Clear and direct.\n\n' +
      'PURCHASE:\n' +
      '- Store: "' + store + '" (' + window.location.href + ')\n' +
      '- Category: ' + category + '\n' +
      '- Order total: ' + totalStr + itemsStr + '\n\n' +
      'USER\'S CARDS:\n' + cardList + '\n\n' +
      'CRITICAL ASSUMPTION: Always assume the user carries a balance and does NOT pay in full each month. Never suggest paying in full. Always calculate the true cost including interest.\n\n' +
      (isSingleCard ?
        'The user has only ONE card. Do not compare to other cards. Focus on analyzing how this card performs at this specific store.\n\n' :
        'PRIORITY ORDER — rank cards strictly in this order:\n' +
        '1. LOWEST APR WINS — if the user has provided their exact APR for cards, the card with the lowest APR should be recommended unless another card has significantly better rewards that outweigh the interest cost difference. A card with a known low APR always beats a card with only an estimated higher APR range.\n' +
        '2. BEST REWARDS for this specific store category "' + category + '" — second factor after APR.\n' +
        '3. DUE DATE — today is ' + new Date().toISOString().split('T')[0] + '. If a card payment is due within 7 days, strongly avoid recommending it. Add a warning in the warnings array.\n' +
        '4. CREDIT LIMIT — if the purchase amount is close to or exceeds available credit, never recommend that card.\n\n') +
      'INSTRUCTIONS:\n' +
      '- Figure out how much cash back or rewards each card earns at "' + store + '" (a ' + category + ' store).\n' +
      '- Calculate the dollar value earned on this ' + totalStr + ' purchase.\n' +
      '- Calculate the TRUE COST of this purchase on each card: total paid over 12 months with interest, minus rewards earned.\n' +
      (isSingleCard ?
        '- Analyze the user\'s only card. Be confident and decisive. Write as VIDAVA speaking in first person.\n' :
        '- Pick the ONE card with the lowest true cost. Be confident and decisive. Write as VIDAVA speaking in first person.\n') +
      '- If a card has the user\'s exact APR provided, use THAT number as "estimatedApr" in your response. Otherwise use the card\'s typical APR range.\n\n' +
      writingRules +
      '- Never use jargon without explaining it simply. Every bullet must be specific.\n' +
      '- If a bullet would confuse a 20-year-old using a credit card for the first time, rewrite it.\n' +
      '- CRITICAL: Always write in first person as VIDAVA. Never say "we" or "VIDAVA recommends".\n' +
      '- VOCABULARY RULE: Never repeat the same key verb more than once in the entire response.\n' +
      '- NEVER use the word "flagged". Use positive language like "selected", "chose", "identified", or "recommend".\n\n' +
      'Respond with ONLY a JSON object. No markdown fences, no explanation.\n\n' +
      '{"best":{"name":"<exact card name>","bank":"<bank>","rate":"<e.g. 2% cash back>","value":"<dollar value e.g. $2.26>","reasons":["<bullet 1>","<bullet 2>","Bottom line: <true cost framing>"],"estimatedApr":"<user exact APR if provided, otherwise typical range e.g. 21.49%-29.49%>","aprWarning":"<warning about interest cost, or null>"},' +
      '"warnings":[{"card":"<name>","text":"<warning>"}],' +
      '"savings":"<best card reward dollar value>","category":"<detected category>"}';

    try {
      sendMsg({ type: 'ASK_AI', prompt: prompt }, function(resp) {
        try {
          console.log('[VIDAVA overlay] Reanalyze response:', JSON.stringify(resp));
          if (!resp || resp.error) throw new Error(resp ? resp.error : 'No AI response');
          if (!resp.text) throw new Error('Response missing text field');
          var r = parseJSON(resp.text);

          // Atomic swap — remove spinner overlay and render new result all at once
          var spinnerOverlay = body.querySelector('#v-reanalyze-overlay');
          if (spinnerOverlay) spinnerOverlay.remove();
          render(r, store, total, items, category, cards);
        } catch (err) {
          console.error('[VIDAVA overlay] Reanalyze error:', err.message);
          // Remove spinner and show error
          var spinnerOverlay = body.querySelector('#v-reanalyze-overlay');
          if (spinnerOverlay) spinnerOverlay.remove();
          setBody(
            '<div class="v-error">' +
            '<div class="v-error-msg">Something went wrong on my end — sorry about that.<br/>' + esc(err.message) + '</div>' +
            '<button class="v-retry-btn" id="v-retry">Let me try again</button>' +
            '</div>'
          );
          shadow.getElementById('v-retry').addEventListener('click', function() { analyzed = false; analyze(); });
        }
      });
    } catch (err) {
      console.error('[VIDAVA overlay] Reanalyze error:', err.message);
      var spinnerOverlay = body.querySelector('#v-reanalyze-overlay');
      if (spinnerOverlay) spinnerOverlay.remove();
    }
  });
}

function analyze() {
  analyzed = true;

  setBody(
    '<div class="v-loading">' +
    '<div class="v-loader"></div>' +
    '<div class="v-load-msg">Hang tight — I am checking your cards...</div>' +
    '<div class="v-load-sub">I am scanning this page to find your best match</div>' +
    '</div>'
  );

  // Load cards
  browser.storage.local.get(['vidava_cards'], function(data) {
  var cards = data.vidava_cards;

  if (!cards || cards.length === 0) {
    setBody(
      '<div class="v-empty">' +
      '<div class="v-empty-msg">Let me find your best card</div>' +
      '<button class="v-setup-btn" id="v-setup">Add my cards and get started</button>' +
      '</div>'
    );
    shadow.getElementById('v-setup').addEventListener('click', function() {
      sendMsg({ type: 'OPEN_POPUP' }, function() {});
    });
    return;
  }

  // Scan page — total is already detected before analyze() is called
  var store = scanStore();
  var total = detectedTotal;
  var items = scanItems();
  var category = detectCategory(store);
  var totalStr = total ? '$' + total.toFixed(2) : 'I could not find your total — but I am still here to help';

  // Update loading
  body.querySelector('.v-load-msg').textContent = 'I am finding your best card for ' + store + '...';


  // Build card list for prompt
  var cardList = cards.map(function(c, i) {
    var d = (i + 1) + '. Card: ' + c.name + '\n';
    d += '   Bank: ' + c.bank + '\n';
    if (c.apr) d += '   User\'s exact APR: ' + c.apr + '%\n';
    if (c.dueDay) {
      d += '   Payment due: day ' + c.dueDay + ' of each month\n';
    }
    if (c.creditLimit) d += '   Credit limit: $' + c.creditLimit + '\n';
    d += '   Rewards: ' + c.rewards + '\n';
    d += '   Best for: ' + c.bestFor;
    return d;
  }).join('\n\n');

  var itemsStr = items.length > 0 ? '\nCart items: ' + items.join(', ') : '';

  var isSingleCard = cards.length === 1;

  var writingRules;
  if (isSingleCard) {
    writingRules =
      'WRITING RULES FOR "reasons" ARRAY (USER HAS ONLY ONE CARD — do NOT compare to other cards):\n' +
      '- Bullet 1 (REQUIRED): What rewards this card earns at this specific store. Be specific about the rate and dollar value.\n' +
      '- Bullet 2 (REQUIRED): APR context — explain what their APR means for this purchase if carried as a balance over 12 months.\n' +
      '- Bullet 3 (ONLY if relevant): Due date warning — only include if payment is due within 7 days.\n' +
      '- FINAL bullet (REQUIRED): "Bottom line:" — frame around the true cost of this purchase on their card (interest + rewards). Example: "Bottom line: at 24.99% APR and 3% cash back, this $50 purchase would cost you $57.20 over 12 months, but you earn $1.50 back."\n' +
      '- NEVER compare to other cards or mention "next best card" — the user only has this one card.\n';
  } else {
    writingRules =
      'WRITING RULES FOR "reasons" ARRAY — write bullets in this EXACT order:\n' +
      '- Bullet 1 (REQUIRED): APR comparison — "Your [card] has the lowest APR at X% — on this $XX purchase carried for 12 months you pay $XX total vs $XX on [other card name]"\n' +
      '- Bullet 2 (REQUIRED): Rewards comparison for this specific store — name the other card and explain why it earns less here.\n' +
      '- Bullet 3 (ONLY if relevant): Due date warning — only include if a card payment is due within 7 days.\n' +
      '- Bullet 4: NEVER mention credit limit unless a card would actually be declined.\n' +
      '- FINAL bullet (REQUIRED): "Bottom line:" — always frame around total true cost (APR + rewards combined). Example: "Bottom line: at 12.5% APR and 2% cash back, this card saves you the most on this purchase today." Must use a DIFFERENT verb than "picked" — use chose, selected, recommend, highlighted, identified, or spotlighted.\n';
  }

  var prompt =
    'You are VIDAVA, a personal AI card assistant. You speak in first person singular — always "I", never "we", never refer to yourself in third person. You are like a trusted older friend or mentor who knows every major US credit card inside and out — rewards rates, APR ranges, annual fees, perks. Write every explanation as if you are talking to an 18-25 year old using their first credit card. Be warm, encouraging, and protective. Never talk down to them. Use "you" and "your" constantly to make it personal. Say "I analyzed your cards", "I recommend", "I found", "I picked this card for you". Explain every financial concept in the simplest possible words. Make them feel smart for using you, not confused by finance. No jargon. Short sentences. Clear and direct.\n\n' +
    'PURCHASE:\n' +
    '- Store: "' + store + '" (' + window.location.href + ')\n' +
    '- Category: ' + category + '\n' +
    '- Order total: ' + totalStr + itemsStr + '\n\n' +
    'USER\'S CARDS:\n' + cardList + '\n\n' +
    'CRITICAL ASSUMPTION: Always assume the user carries a balance and does NOT pay in full each month. Never suggest paying in full. Always calculate the true cost including interest.\n\n' +
    (isSingleCard ?
      'The user has only ONE card. Do not compare to other cards. Focus on analyzing how this card performs at this specific store.\n\n' :
      'PRIORITY ORDER — rank cards strictly in this order:\n' +
      '1. LOWEST APR WINS — if the user has provided their exact APR for cards, the card with the lowest APR should be recommended unless another card has significantly better rewards that outweigh the interest cost difference. A card with a known low APR always beats a card with only an estimated higher APR range.\n' +
      '2. BEST REWARDS for this specific store category "' + category + '" — second factor after APR.\n' +
      '3. DUE DATE — today is ' + new Date().toISOString().split('T')[0] + '. If a card payment is due within 7 days, strongly avoid recommending it. Add a warning in the warnings array.\n' +
      '4. CREDIT LIMIT — if the purchase amount is close to or exceeds available credit, never recommend that card.\n\n') +
    'INSTRUCTIONS:\n' +
    '- Figure out how much cash back or rewards each card earns at "' + store + '" (a ' + category + ' store).\n' +
    '- Calculate the dollar value earned on this ' + totalStr + ' purchase.\n' +
    '- Calculate the TRUE COST of this purchase on each card: total paid over 12 months with interest, minus rewards earned.\n' +
    (isSingleCard ?
      '- Analyze the user\'s only card. Be confident and decisive. Write as VIDAVA speaking in first person.\n' :
      '- Pick the ONE card with the lowest true cost. Be confident and decisive. Write as VIDAVA speaking in first person.\n') +
    '- If a card has the user\'s exact APR provided, use THAT number as "estimatedApr" in your response. Otherwise use the card\'s typical APR range.\n\n' +
    writingRules +
    '- Never use jargon without explaining it simply. Every bullet must be specific.\n' +
    '- If a bullet would confuse a 20-year-old using a credit card for the first time, rewrite it.\n' +
    '- CRITICAL: Always write in first person as VIDAVA. Never say "we" or "VIDAVA recommends".\n' +
    '- VOCABULARY RULE: Never repeat the same key verb more than once in the entire response.\n' +
    '- NEVER use the word "flagged". Use positive language like "selected", "chose", "identified", or "recommend".\n\n' +
    'Respond with ONLY a JSON object. No markdown fences, no explanation.\n\n' +
    '{"best":{"name":"<exact card name>","bank":"<bank>","rate":"<e.g. 2% cash back>","value":"<dollar value e.g. $2.26>","reasons":["<bullet 1>","<bullet 2>","Bottom line: <true cost framing>"],"estimatedApr":"<user exact APR if provided, otherwise typical range e.g. 21.49%-29.49%>","aprWarning":"<warning about interest cost, or null>"},' +
    '"warnings":[{"card":"<name>","text":"<warning>"}],' +
    '"savings":"<best card reward dollar value>","category":"<detected category>"}';

  try {
    sendMsg({ type: 'ASK_AI', prompt: prompt }, function(resp) {
      try {
        console.log('[VIDAVA overlay] Raw ASK_AI response:', JSON.stringify(resp));
        if (!resp || resp.error) throw new Error(resp ? resp.error : 'No AI response — resp is: ' + String(resp));
        if (!resp.text) throw new Error('Response missing text field. Keys: ' + Object.keys(resp).join(', '));
        var r = parseJSON(resp.text);
        render(r, store, total, items, category, cards);

        // Start watching for amount changes (tax/shipping added after overlay appears)
        startAmountWatcher();

        // Save recommendation to Supabase
        var rewardsNum = r.savings ? parseFloat(r.savings.replace(/[^0-9.]/g, '')) : null;
        sendMsg({
          type: 'SAVE_RECOMMENDATION',
          data: {
            store_name: store,
            purchase_amount: total || null,
            recommended_card_name: r.best.name,
            recommended_card_bank: r.best.bank,
            reason: r.best.reasons ? r.best.reasons.join(' ') : null,
            estimated_rewards: isNaN(rewardsNum) ? null : rewardsNum
          }
        }, function() { /* fire and forget */ });
      } catch (err) {
        console.error('[VIDAVA overlay] Error:', err.message);
        setBody(
          '<div class="v-error">' +
          '<div class="v-error-msg">Something went wrong on my end — sorry about that.<br/>' + esc(err.message) + '</div>' +
          '<button class="v-retry-btn" id="v-retry">Let me try again</button>' +
          '</div>'
        );
        shadow.getElementById('v-retry').addEventListener('click', function() { analyzed = false; analyze(); });
      }
    });
  } catch (err) {
    console.error('[VIDAVA overlay]', err);
    setBody(
      '<div class="v-error">' +
      '<div class="v-error-msg">Something went wrong on my end — sorry about that.<br/>' + esc(err.message) + '</div>' +
      '<button class="v-retry-btn" id="v-retry">Let me try again</button>' +
      '</div>'
    );
    shadow.getElementById('v-retry').addEventListener('click', function() { analyzed = false; analyze(); });
  }
  }); // close browser.storage.local.get callback
}

// ── Render Result ────────────────────────────────────────────────────────

function render(r, store, total, items, category, cards) {
  var cat = r.category || category;
  var totalDisp = total ? '$' + total.toFixed(2) : 'I could not find your total — but I am still here to help';
  var b = r.best;
  var h = '';

  // Check if the recommended card has a user-provided exact APR
  var userExactApr = null;
  if (cards) {
    for (var ci = 0; ci < cards.length; ci++) {
      if (cards[ci].name === b.name && cards[ci].apr) {
        userExactApr = cards[ci].apr;
        break;
      }
    }
  }

  // Parse APR range for table
  var aprNums = b.estimatedApr ? b.estimatedApr.match(/([\d.]+)/g) : null;
  var lowApr = aprNums ? parseFloat(aprNums[0]) : null;
  var highApr = aprNums && aprNums.length > 1 ? parseFloat(aprNums[aprNums.length - 1]) : null;

  // Context bar (no emoji)
  h += '<div class="v-ctx">';
  h += '<div class="v-ctx-info">';
  h += '<div class="v-ctx-store" style="font-size:16px;font-weight:700;">' + esc(store) + '</div>';
  h += '<div class="v-ctx-meta">' + esc(cat.charAt(0).toUpperCase() + cat.slice(1));
  if (items.length > 0) h += ' · ' + items.length + ' item' + (items.length > 1 ? 's' : '');
  h += '</div></div>';
  h += '<div class="v-ctx-total" id="v-ctx-total">' + totalDisp + '</div>';
  h += '</div>';

  // BOX 1 — Best card (pink border)
  h += '<div class="v-box-pink">';
  h += '<div class="v-card-tag" style="margin-bottom:10px;">BEST CARD FOR THIS PURCHASE</div>';
  h += '<div style="display:flex;align-items:flex-start;gap:12px;width:100%;margin-top:6px;">';
  h += '<div style="flex-shrink:0;width:40px;height:26px;border-radius:6px;background:#FFD932;margin-top:2px;"></div>';
  h += '<div style="flex:1;min-width:0;overflow:hidden;">';
  h += '<div style="font-size:12px;font-weight:700;color:#00e5cc;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">' + esc(b.name) + '</div>';
  h += '<div style="font-size:10px;color:#888;margin-top:2px;">You will earn</div>';
  h += '</div>';
  h += '<div style="flex-shrink:0;text-align:right;min-width:70px;">';
  h += '<div style="color:#FFD932;font-size:16px;font-weight:700;white-space:nowrap;">' + esc(b.value) + '</div>';
  h += '<div style="color:#888;font-size:10px;white-space:nowrap;margin-top:2px;">' + esc(b.rate) + '</div>';
  h += '</div>';
  h += '</div>';

  // Three-column details row (APR / Due Date / Credit Limit)
  var recCard = null;
  if (cards) {
    for (var ri = 0; ri < cards.length; ri++) {
      if (cards[ri].name === b.name) { recCard = cards[ri]; break; }
    }
  }
  var hasApr = recCard && recCard.apr;
  var hasDue = recCard && recCard.dueDay;
  var hasLimit = recCard && recCard.creditLimit;

  if (hasApr || hasDue || hasLimit) {
    h += '<div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #222;">';

    // COLUMN 1 — APR
    if (hasApr) {
      var aprVal = recCard.apr;
      // Rank APR among all cards
      var aprRanks = [];
      for (var ai = 0; ai < cards.length; ai++) { if (cards[ai].apr) aprRanks.push(cards[ai].apr); }
      aprRanks.sort(function(a, b) { return a - b; });
      var aprRank = aprRanks.indexOf(aprVal) + 1;
      var aprInsight = '';
      var aprInsightColor = '#888';
      if (aprRank === 1) { aprInsight = 'Lowest rate'; }
      else if (aprRank === 2) { aprInsight = '2nd lowest rate'; }
      else if (aprRank === aprRanks.length && aprRanks.length > 1) { aprInsight = 'Highest rate'; aprInsightColor = '#ff6eb4'; }
      else { aprInsight = 'Rank ' + aprRank + ' of ' + aprRanks.length; }
      h += '<div style="text-align:center;">';
      h += '<div style="font-size:11px;font-weight:700;color:#00e5cc;">APR: ' + aprVal + '%</div>';
      h += '<div style="font-size:10px;color:' + aprInsightColor + ';">' + aprInsight + '</div>';
      h += '</div>';
    }

    // COLUMN 2 — Due Date
    if (hasDue) {
      var dueDay = recCard.dueDay;
      // Calculate days until next occurrence
      var today = new Date();
      var thisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
      var nextDue = thisMonth;
      if (thisMonth <= today) {
        nextDue = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
      }
      var daysUntil = Math.ceil((nextDue - today) / (1000 * 60 * 60 * 24));
      var dueColor = '#888';
      var dueSuffix = '';
      if (daysUntil <= 7) { dueColor = '#ff6eb4'; dueSuffix = '!'; }
      else if (daysUntil <= 14) { dueColor = '#FFD932'; }
      // Ordinal suffix
      var daySuffix = 'th';
      if (dueDay === 1 || dueDay === 21 || dueDay === 31) daySuffix = 'st';
      else if (dueDay === 2 || dueDay === 22) daySuffix = 'nd';
      else if (dueDay === 3 || dueDay === 23) daySuffix = 'rd';
      h += '<div style="text-align:center;">';
      h += '<div style="font-size:11px;font-weight:700;color:#00e5cc;">Due: ' + dueDay + daySuffix + '</div>';
      h += '<div style="font-size:10px;color:' + dueColor + ';">In ' + daysUntil + ' days' + dueSuffix + '</div>';
      h += '</div>';
    }

    // COLUMN 3 — Credit Limit
    if (hasLimit) {
      var limitVal = recCard.creditLimit;
      var limitFormatted = limitVal.toLocaleString('en-US');
      // Rank and utilization
      var limitInsight = '';
      var limitColor = '#888';
      if (total) {
        var usage = (total / limitVal) * 100;
        if (usage < 10) { limitInsight = 'Plenty of room'; }
        else if (usage < 30) { limitInsight = 'Good standing'; }
        else if (usage < 50) { limitInsight = 'Watch usage'; }
        else { limitInsight = 'High usage'; limitColor = '#ff6eb4'; }
      } else {
        // No total — check if highest limit
        var allLimits = [];
        for (var li = 0; li < cards.length; li++) { if (cards[li].creditLimit) allLimits.push(cards[li].creditLimit); }
        allLimits.sort(function(a, b) { return b - a; });
        if (allLimits[0] === limitVal) { limitInsight = 'Best limit'; }
        else { limitInsight = '$' + limitFormatted + ' available'; }
      }
      h += '<div style="text-align:center;">';
      h += '<div style="font-size:11px;font-weight:700;color:#00e5cc;">$' + limitFormatted + '</div>';
      h += '<div style="font-size:10px;color:' + limitColor + ';">' + limitInsight + '</div>';
      h += '</div>';
    }

    h += '</div>'; // close three-column row
  }

  h += '</div>'; // close box 1

  // "See full analysis" button outside box 1
  h += '<button id="v-expand-toggle" style="display:flex;align-items:center;justify-content:center;gap:6px;width:100%;background:none;border:none;cursor:pointer;margin-top:8px;padding:0;font-family:inherit;font-size:12px;font-weight:600;color:#00e5cc;">';
  h += '<span id="v-expand-label">See full analysis</span>';
  h += '<svg id="v-expand-chevron" class="v-expand-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#00e5cc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  h += '</button>';

  // Expandable section (hidden by default)
  h += '<div id="v-expandable" style="display:none;">';

  // BOX 2 — Reasons (teal border)
  if (b.reasons && b.reasons.length > 0) {
    h += '<div class="v-box-teal">';
    h += '<div class="v-why-title">Here is why I picked this card for you:</div>';
    b.reasons.forEach(function(reason) {
      h += '<div class="v-why-item"><div class="v-why-dot"></div><div>' + esc(reason) + '</div></div>';
    });
    h += '</div>'; // close box 2
  }

  // BOX 3 — Financial breakdown (yellow border)
  if ((lowApr && total) || b.estimatedApr) {
    h += '<div class="v-box-yellow">';

    // Financial table — use exact APR if user provided it, otherwise show range
    if ((userExactApr || lowApr) && total) {
      h += '<div id="v-finance-section">';
      h += '<div style="font-size:11px;color:#fff;font-weight:700;margin-bottom:6px;" id="v-finance-title">What this $' + total.toFixed(2) + ' really costs you over time:</div>';
      h += '<div id="v-finance-table">';
      h += buildTable(total, lowApr, highApr, userExactApr || null);
      h += '</div>';
      h += '</div>';
    }

    // APR section
    if (b.estimatedApr) {
      h += '<div id="v-apr-section" style="margin-top:10px;">';
      h += '<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:4px;">This is based on the typical interest rate for your card.</div>';
      h += '<div style="display:flex;align-items:center;margin-bottom:4px;"><span class="v-card-apr-val" id="v-apr-best-val" style="font-size:12px;font-weight:700;color:#fff;">' + esc(b.estimatedApr) + '</span><button class="v-card-apr-edit" id="v-apr-best-edit" style="font-size:10px;color:#00e5cc;background:none;border:none;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0;margin-left:8px;">Edit</button></div>';
      h += '<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:4px;">APR (Annual Percentage Rate) is the yearly cost of borrowing money on your card.</div>';
      h += '<div style="font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:4px;">You can find your exact APR on your monthly statement or in your card\'s app.</div>';
      h += '<div style="font-size:10px;color:rgba(255,255,255,0.4);font-style:italic;margin-bottom:4px;">Enter your exact APR above and I will show you your real cost.</div>';
      h += '</div>';
    }

    // APR warning
    if (b.aprWarning) {
      h += '<div class="v-warn" style="margin-top:10px;">';
      h += '<span>' + esc(b.aprWarning) + '</span>';
      h += '</div>';
    }

    h += '</div>'; // close box 3
  } else if (b.aprWarning) {
    // APR warning outside box if no financial data
    h += '<div class="v-warn">';
    h += '<span>' + esc(b.aprWarning) + '</span>';
    h += '</div>';
  }

  // "Close full analysis" button at bottom of expanded content
  h += '<button id="v-collapse-toggle" style="display:flex;align-items:center;justify-content:center;gap:6px;width:100%;background:none;border:none;cursor:pointer;padding:6px 0 4px;font-family:inherit;font-size:11px;font-weight:600;color:#00e5cc;">';
  h += '<span>Close full analysis</span>';
  h += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#00e5cc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>';
  h += '</button>';

  h += '</div>'; // close expandable section


  setBody(h);

  // Expand/collapse toggle handlers
  var expandToggle = shadow.getElementById('v-expand-toggle');
  var collapseToggle = shadow.getElementById('v-collapse-toggle');
  var expandable = shadow.getElementById('v-expandable');

  function expandPanel() {
    expandable.style.display = 'block';
    expandToggle.style.display = 'none';
  }
  function collapsePanel() {
    expandable.style.display = 'none';
    expandToggle.style.display = 'flex';
  }

  if (expandToggle) expandToggle.addEventListener('click', expandPanel);
  if (collapseToggle) collapseToggle.addEventListener('click', collapsePanel);

  // APR edit handler — recalculates table in real time and saves to storage
  var editBtn = shadow.getElementById('v-apr-best-edit');
  var recommendedCardName = b.name;
  if (editBtn) {
    editBtn.addEventListener('click', function() {
      var valSpan = shadow.getElementById('v-apr-best-val');
      var origText = valSpan.textContent;
      var input = document.createElement('input');
      input.className = 'v-card-apr-input';
      input.type = 'number';
      input.step = '0.01';
      input.placeholder = 'APR %';
      valSpan.replaceWith(input);
      input.focus();
      editBtn.style.display = 'none';

      var tableDiv = shadow.getElementById('v-finance-table');
      var currentTotal = detectedTotal || total;

      // Update table in real time as user types
      input.addEventListener('input', function() {
        var newApr = parseFloat(input.value);
        if (newApr > 0 && newApr < 100 && tableDiv && currentTotal) {
          tableDiv.innerHTML = buildTable(currentTotal, lowApr, highApr, newApr);
        }
      });

      input.addEventListener('blur', function() {
        var newVal = input.value.trim();
        var newAprNum = newVal ? parseFloat(newVal) : null;

        // Restore display span
        var span = document.createElement('span');
        span.className = 'v-card-apr-val';
        span.id = 'v-apr-best-val';
        span.textContent = newVal ? newVal + '%' : origText;
        input.replaceWith(span);
        editBtn.style.display = '';

        // Update table
        if (newAprNum && newAprNum > 0 && tableDiv && currentTotal) {
          tableDiv.innerHTML = buildTable(currentTotal, lowApr, highApr, newAprNum);
        } else if (!newVal && tableDiv && currentTotal) {
          tableDiv.innerHTML = buildTable(currentTotal, lowApr, highApr, null);
        }

        // Save to storage if valid
        if (newAprNum && newAprNum > 0) {
          browser.storage.local.get('vidava_cards', function(result) {
            var storageCards = result.vidava_cards || [];
            var cardIndex = storageCards.findIndex(function(c) { return c.name === recommendedCardName; });
            if (cardIndex !== -1) {
              storageCards[cardIndex].apr = newAprNum;
              browser.storage.local.set({ vidava_cards: storageCards }, function() {
                // Sync to cloud
                sendMsg({ type: 'SUPABASE_SYNC_CARDS', cards: storageCards }, function() {});
              });
            }
          });

          // Show "Saved" confirmation next to Edit link
          var savedMsg = document.createElement('span');
          savedMsg.textContent = 'Saved';
          savedMsg.style.cssText = 'color:#00e5cc;font-size:10px;font-weight:600;margin-left:8px;font-family:inherit;';
          editBtn.parentNode.insertBefore(savedMsg, editBtn.nextSibling);
          setTimeout(function() {
            savedMsg.style.opacity = '0';
            savedMsg.style.transition = 'opacity 0.3s';
            setTimeout(function() { savedMsg.remove(); }, 300);
          }, 1200);
        }
      });

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') input.blur();
      });
    });
  }
}

// ── Payment interaction trigger — fire when user ACTIVELY selects a payment option ──

function waitForPaymentInteraction() {
  browser.storage.local.get(['vidava_cards'], function(data) {
    if (!data.vidava_cards || data.vidava_cards.length === 0) return;

    // Show pill immediately so user knows VIDAVA is present
    pillWrap.style.display = 'block';

    var triggered = false;

    function fireRecommendation(reason) {
      if (triggered) return;
      triggered = true;
      paymentTriggered = true;
      // Restore header brand logo and body padding if changed by standing-by screen
      brandLogo.style.display = 'block';
      body.style.padding = '';
      console.log('[VIDAVA] Payment interaction: ' + reason);

      // Clean up listeners
      if (interactionObserver) interactionObserver.disconnect();

      // Grab the final total — retry up to 5 times if not found immediately
      detectedTotal = tryFindTotal('interaction');
      if (!detectedTotal || detectedTotal < 1) {
        var retryCount = 0;
        var retryInterval = setInterval(function() {
          retryCount++;
          detectedTotal = tryFindTotal('interaction-retry-' + retryCount);
          if ((detectedTotal && detectedTotal >= 1) || retryCount >= 5) {
            clearInterval(retryInterval);
            console.log('[VIDAVA] Total detected: ' + detectedTotal);
            open();
            analyze();
          }
        }, 300);
      } else {
        console.log('[VIDAVA] Total detected: ' + detectedTotal);
        // Small delay to let any UI transitions settle
        setTimeout(function() {
          open();
          analyze();
        }, 400);
      }
    }

    // ── Trigger 1: User clicks/focuses on credit card input fields ──
    function attachInputListeners() {
      var allInputs = document.querySelectorAll('input');
      var ccRe = /card.?number|cardnumber|cc.?num|cc.?number|credit.?card|debit.?card|card.?holder|cardholder|name.?on.?card|\bcvv\b|\bcvc\b|\bcvn\b|security.?code|exp.?date|expir|mm\s*\/?\s*yy/i;
      var ccAutocomplete = ['cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'cc-type'];

      allInputs.forEach(function(el) {
        var attrs = [(el.name || ''), (el.id || ''), (el.placeholder || ''), (el.getAttribute('aria-label') || '')].join(' ');
        // Also check the label associated with this input
        var labelText = '';
        if (el.id) {
          var lbl = document.querySelector('label[for="' + el.id + '"]');
          if (lbl) labelText = lbl.textContent || '';
        }
        if (!labelText && el.closest('label')) {
          labelText = el.closest('label').textContent || '';
        }
        var allText = attrs + ' ' + labelText;

        if (ccRe.test(allText) || ccAutocomplete.indexOf(el.autocomplete) !== -1) {
          el.addEventListener('focus', function() { fireRecommendation('cc input focus: ' + (el.name || el.id || el.placeholder)); }, { once: true });
          el.addEventListener('click', function() { fireRecommendation('cc input click: ' + (el.name || el.id || el.placeholder)); }, { once: true });
        }
      });

      // Also listen on labels containing payment field text
      var labelRe = /card.?number|credit.?card|debit.?card|card.?holder|cardholder|name.?on.?card|\bcvv\b|\bcvc\b|security.?code|expir/i;
      document.querySelectorAll('label').forEach(function(lbl) {
        var lText = (lbl.textContent || '').trim();
        if (labelRe.test(lText)) {
          lbl.addEventListener('click', function() { fireRecommendation('cc label click: ' + lText.substring(0, 30)); }, { once: true });
          // Also attach to the input inside/associated with this label
          var inp = lbl.querySelector('input') || (lbl.htmlFor ? document.getElementById(lbl.htmlFor) : null);
          if (inp) {
            inp.addEventListener('focus', function() { fireRecommendation('cc label-input focus: ' + lText.substring(0, 30)); }, { once: true });
            inp.addEventListener('click', function() { fireRecommendation('cc label-input click: ' + lText.substring(0, 30)); }, { once: true });
          }
        }
      });
    }

    // ── Trigger 2: User selects a payment radio button / payment option ──
    function attachPaymentOptionListeners() {
      var paymentRe = /paypal|klarna|afterpay|affirm|apple\s*pay|google\s*pay|credit|debit|visa|mastercard|amex|discover|payment\s*method|pay\s*with|select\s*payment/i;

      // Radio buttons and their labels
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(function(radio) {
        var container = radio.closest('label') || radio.parentElement;
        var text = container ? (container.textContent || '').trim() : '';
        if (paymentRe.test(text) || paymentRe.test(radio.name || '') || paymentRe.test(radio.value || '')) {
          radio.addEventListener('change', function() { fireRecommendation('payment radio: ' + text.substring(0, 40)); }, { once: true });
          radio.addEventListener('click', function() { fireRecommendation('payment radio click: ' + text.substring(0, 40)); }, { once: true });
          if (container && container !== radio) {
            container.addEventListener('click', function() { fireRecommendation('payment option click: ' + text.substring(0, 40)); }, { once: true });
          }
        }
      });

      // Clickable payment option buttons/divs (PayPal, Apple Pay, etc.)
      document.querySelectorAll('button, a, div[role="button"], [class*="payment"], [class*="pay-"], [data-testid*="payment"]').forEach(function(el) {
        if (el.children.length > 10) return;
        var text = (el.textContent || '').trim();
        if (text.length > 80) return;
        if (paymentRe.test(text) || paymentRe.test(el.className || '')) {
          el.addEventListener('click', function() { fireRecommendation('payment button: ' + text.substring(0, 40)); }, { once: true });
        }
      });
    }

    // ── Trigger 3: User clicks on a saved card ("ending in XXXX") ──
    function attachSavedCardListeners() {
      var savedCardRe = /ending\s*in\s*\d{4}|\*{3,}\s*\d{4}|•{3,}\s*\d{4}|x{3,}\d{4}|\d{4}$/i;

      document.querySelectorAll('*').forEach(function(el) {
        if (el.children.length > 4) return;
        var text = (el.textContent || '').trim();
        if (text.length > 80) return;
        if (savedCardRe.test(text)) {
          el.addEventListener('click', function() { fireRecommendation('saved card: ' + text.substring(0, 40)); }, { once: true });
        }
      });
    }

    // ── Trigger 4: Click on payment iframes or visible payment iframe detection ──
    var paymentIframeRe = /stripe|braintree|adyen|square|checkout\.com|paypal|worldpay|cybersource|authorize\.net|secure\.[^.]+\.com\/payment|\/payment\//i;
    function attachIframeListeners() {
      document.querySelectorAll('iframe').forEach(function(iframe) {
        var src = (iframe.src || '').toLowerCase();
        if (paymentIframeRe.test(src)) {
          // Can't listen inside cross-origin iframes, but listen on clicks near them
          var wrapper = iframe.parentElement;
          if (wrapper) {
            wrapper.addEventListener('click', function() { fireRecommendation('payment iframe click: ' + src.substring(0, 60)); }, { once: true });
          }
        }
      });
    }

    // ── Trigger 5: Periodic scan — detect visible payment fields automatically ──
    // Catches sites like Agoda where focus/click listeners don't fire on custom components
    var fieldScanRe = /card.?number|cardnumber|credit.?card|debit.?card|card.?holder|cardholder|name.?on.?card|\bcvv\b|\bcvc\b|\bcvn\b|security.?code|exp.?date|expir|mm\s*\/?\s*yy/i;

    function scanForVisiblePaymentFields() {
      if (triggered) return false;

      // Check inputs by placeholder, name, id, aria-label, autocomplete
      var allInputs = document.querySelectorAll('input');
      var found = false;
      var foundDetail = '';
      var ccAutocomplete = ['cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'cc-type'];

      for (var i = 0; i < allInputs.length; i++) {
        var el = allInputs[i];
        var vis = el.offsetWidth + 'x' + el.offsetHeight;
        var attrs = [(el.name || ''), (el.id || ''), (el.placeholder || ''), (el.getAttribute('aria-label') || '')].join(' | ');
        var ac = el.autocomplete || '';
        // Must be visible (has dimensions and not hidden)
        if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
        var attrStr = [(el.name || ''), (el.id || ''), (el.placeholder || ''), (el.getAttribute('aria-label') || '')].join(' ');
        if (fieldScanRe.test(attrStr) || ccAutocomplete.indexOf(el.autocomplete) !== -1) {
          found = true;
          foundDetail = 'input: ' + (el.placeholder || el.name || el.id || el.autocomplete);
          break;
        }
      }

      // Also check labels
      if (!found) {
        var allLabels = document.querySelectorAll('label, [class*="label"], [class*="Label"]');
        for (var j = 0; j < allLabels.length; j++) {
          var lbl = allLabels[j];
          var lVis = lbl.offsetWidth + 'x' + lbl.offsetHeight;
          var lText = (lbl.textContent || '').trim();
          if (lText.length > 60) continue;
          if (lbl.offsetWidth === 0 && lbl.offsetHeight === 0) continue;
          if (fieldScanRe.test(lText)) {
            found = true;
            foundDetail = 'label: ' + lText.substring(0, 30);
            break;
          }
        }
      }

      // Also scan ALL visible text for payment field indicators (spans, divs, etc.)
      if (!found) {
        var allEls = document.querySelectorAll('span, div, p, td, th, li, h1, h2, h3, h4, h5, h6');
        var textMatches = [];
        for (var t = 0; t < allEls.length; t++) {
          var te = allEls[t];
          if (te.children.length > 3) continue;
          if (te.offsetWidth === 0 && te.offsetHeight === 0) continue;
          var tt = (te.textContent || '').trim();
          if (tt.length > 40 || tt.length < 3) continue;
          if (fieldScanRe.test(tt)) {
            textMatches.push(te.tagName + ': "' + tt + '"');
            if (!found) {
              found = true;
              foundDetail = 'text element: ' + tt.substring(0, 30);
            }
          }
        }
      }

      // On subscription/purchase pages, check innerText for payment step text.
      // On subscription pages, use iframe data, textContent, or delayed iframe prices.
      if (!found) {
        var scanFullURL = (window.location.pathname + window.location.search + window.location.hash).toLowerCase();
        var isSubURL = /subscribe|subscription|purchase/i.test(scanFullURL);
        if (isSubURL) {
          // Check textContent (reaches into sandboxed/hidden widgets that innerText misses)
          var scanTC = '';
          try { scanTC = (document.body.textContent || '').toLowerCase(); } catch(e) {}
          var payInTC = /payment\s*information|payment\s*details|billing\s*information|billing\s*details|card\s*details/i.test(scanTC);
          var priceInTC = /[\$£€]\s*[\d,]+\.\d{2}/.test(scanTC);

          if (pageContextHasPaymentText) {
            found = true;
            foundDetail = 'subscription payment step (page-context payment text)';
          } else if (iframeHasPaymentText) {
            found = true;
            foundDetail = 'subscription payment step (iframe payment text)';
          } else if (iframePricesReported.length > 0 && iframePricesFirstSeen > 0 && (Date.now() - iframePricesFirstSeen) > 3000) {
            found = true;
            foundDetail = 'subscription payment step (iframe prices stable)';
          } else if (payInTC && priceInTC) {
            found = true;
            foundDetail = 'subscription payment step (textContent match)';
          }
        }
      }

      // Check for visible payment iframes (Agoda, Stripe, etc.)
      if (!found) {
        var iframes = document.querySelectorAll('iframe');
        if (iframes.length > 0) {
          for (var f = 0; f < iframes.length; f++) {
            var ifSrc = iframes[f].src || '';
            if (iframes[f].offsetWidth > 0 && iframes[f].offsetHeight > 0 && paymentIframeRe.test(ifSrc)) {
              found = true;
              foundDetail = 'visible payment iframe: ' + ifSrc.substring(0, 60);
              break;
            }
          }
        }
      }

      if (found) {
        fireRecommendation('visible payment field detected — ' + foundDetail);
        return true;
      }
      return false;
    }

    // Attach all listeners
    function attachAll() {
      if (triggered) return;
      attachInputListeners();
      attachPaymentOptionListeners();
      attachSavedCardListeners();
      attachIframeListeners();
    }

    // Attach now and re-attach on DOM changes (payment forms often load dynamically)
    attachAll();

    // Also run periodic field scan every 2 seconds
    var fieldScanInterval = setInterval(function() {
      if (triggered) { clearInterval(fieldScanInterval); return; }
      scanForVisiblePaymentFields();
    }, 2000);
    // Run first scan after a short delay
    setTimeout(function() { scanForVisiblePaymentFields(); }, 1000);

    var interactionObserver = null;
    try {
      var reattachTimeout = null;
      interactionObserver = new MutationObserver(function() {
        if (triggered) return;
        // Debounce: re-attach listeners and scan after DOM settles
        clearTimeout(reattachTimeout);
        reattachTimeout = setTimeout(function() {
          attachAll();
          scanForVisiblePaymentFields();
        }, 300);
      });
      interactionObserver.observe(document.body, { childList: true, subtree: true });
    } catch(e) {}

    // Stop watching after 120 seconds
    setTimeout(function() {
      if (!triggered) {
        if (interactionObserver) interactionObserver.disconnect();
        clearInterval(fieldScanInterval);
        console.log('[VIDAVA] no payment interaction after 120s — stopping');
      }
    }, 120000);
  });
}

waitForPaymentInteraction();

} // end initOverlay

})();
