(function() {
'use strict';
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

// ── Gate: prevent double-injection ───────────────────────────────────────
if (document.getElementById('vidava-root')) return;

// ── Multi-strategy payment page detection ────────────────────────────────

var activated = false;

function detectPaymentPage() {
  var bodyText;
  try { bodyText = (document.body.innerText || '').toLowerCase(); } catch(e) { return null; }
  var path = window.location.pathname.toLowerCase();

  // ── NEGATIVE GATE: reject shipping/address-only steps ──────────────
  // If the URL clearly indicates a non-payment step, bail out
  if (/\/checkout\/(shipping|address|delivery|fulfillment)/i.test(path)) {
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

  // Check labels for card references
  if (!hasPayment) {
    var labels = document.querySelectorAll('label');
    for (var k = 0; k < labels.length; k++) {
      var lText = (labels[k].textContent || '').toLowerCase();
      if (/card.?number|credit\s*card|cvv|security\s*code/i.test(lText)) {
        hasPayment = true;
        paymentDetail = 'card label';
        break;
      }
    }
  }

  // Check for payment iframes (Stripe, Braintree, Adyen)
  if (!hasPayment) {
    var iframes = document.querySelectorAll('iframe');
    for (var j = 0; j < iframes.length; j++) {
      var src = (iframes[j].src || '').toLowerCase();
      if (/stripe|braintree|adyen/i.test(src)) {
        hasPayment = true;
        paymentDetail = 'payment iframe';
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
          /^payment\s*method$/i.test(hText) ||
          /^choose\s*payment$/i.test(hText)) {
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
  if (!hasTax) return null;

  // ── SIGNAL 3: Order total present ──────────────────────────────────
  var hasTotal = /\btotal\b|\border\s*total\b|\bgrand\s*total\b|\btotal\s*price\b|\bprice\s*total\b|\bamount\s*due\b|\byou\s*pay\b/i.test(bodyText);
  if (!hasTotal) return null;

  return 'all signals (payment: ' + paymentDetail + ' + tax + total)';
}

function tryActivate(source) {
  if (activated) return;
  var strategy = detectPaymentPage();
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

// Check for valid Supabase session before injecting anything
browser.storage.local.get(null, function(allData) {
  if (!allData) { console.log('[VIDAVA] no session — overlay disabled'); return; }
  var hasSession = false;
  var keys = Object.keys(allData);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('sb_') === 0 && keys[i].indexOf('auth-token') !== -1) {
      var val = allData[keys[i]];
      if (val && typeof val === 'string') {
        try { var parsed = JSON.parse(val); if (parsed && parsed.access_token) { hasSession = true; } } catch(e) {}
      } else if (val && typeof val === 'object' && val.access_token) {
        hasSession = true;
      }
      break;
    }
  }
  if (!hasSession) {
    console.log('[VIDAVA] no active session — overlay disabled');
    return;
  }
  console.log('[VIDAVA] session found — starting detection');
  startDetection();
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
    if (!finalTotalRe.test(labelOnly) && !finalTotalRe.test(elText)) continue;

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
          // Weight: "Order Total" and "Grand Total" get highest priority
          var weight = /order\s*total|grand\s*total/i.test(labelOnly || elText) ? 2 : 1;
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

  // ── Method 3: Fallback — collect all $ and currency-code amounts, pick the largest ──
  var allPrices = [];
  var fallbackRe = /(?:\$|USD|EUR|GBP|CAD|AUD|NZD|SGD|HKD|JPY|KRW|THB|MXN|BRL|INR|CHF|SEK|NOK|DKK|MYR|PHP|IDR|TWD|ZAR)\s*([\d,]+\.\d{2})/gi;
  var pm;
  while (pm = fallbackRe.exec(fullText)) {
    var pval = parseFloat(pm[1].replace(/,/g, ''));
    if (pval >= 1 && pval <= 99999) allPrices.push(pval);
  }

  if (allPrices.length > 0) {
    return Math.max.apply(null, allPrices);
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
  '<div class="v-pill-wrap" id="v-pill-wrap">' +
    '<button class="v-pill" id="v-pill">' +
      '<img id="v-pill-logo" style="display:none;width:auto;height:auto;max-height:20px;object-fit:contain;border-radius:0;"/>' +
      '<span class="v-pill-letter" id="v-pill-letter">V</span>' +
    '</button>' +
  '</div>' +
  '<div class="v-panel" id="v-panel" style="display:none;">' +
    '<div class="v-header">' +
      '<div class="v-brand">' +
        '<img id="v-brand-logo" style="display:none;width:auto;height:auto;max-height:40px;object-fit:contain;border-radius:0;"/>' +
        '<span class="v-brand-letter" id="v-brand-letter">V</span>' +
      '</div>' +
      '<div class="v-controls">' +
        '<button class="v-ctrl" id="v-min" title="Minimize"><svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>' +
        '<button class="v-ctrl" id="v-close" title="Close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
    '</div>' +
    '<div class="v-body" id="v-body"></div>' +
  '</div>';
shadow.appendChild(wrap);

// ── Refs ─────────────────────────────────────────────────────────────────

var pill = shadow.getElementById('v-pill');
var pillWrap = shadow.getElementById('v-pill-wrap');
var panel = shadow.getElementById('v-panel');
var body = shadow.getElementById('v-body');

// Logo — set src directly, hide fallback letter on successful load
var logoUrl = browser.runtime.getURL('logo.png');
var pillLogo = shadow.getElementById('v-pill-logo');
var brandLogo = shadow.getElementById('v-brand-logo');
pillLogo.src = logoUrl;
brandLogo.src = logoUrl;
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
var animatedLogoUrl = browser.runtime.getURL('vidava-logo-animated.gif');

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
    // Show standing-by screen with animated logo — hide header brand logo
    brandLogo.style.display = 'none';
    shadow.getElementById('v-brand-letter').style.display = 'none';
    open();
    body.style.padding = '0 18px 14px';
    setBody(
      '<div style="display:flex;flex-direction:column;align-items:center;padding:0 8px 16px;text-align:center;">' +
        '<img src="' + animatedLogoUrl + '" style="width:auto;height:auto;max-height:48px;object-fit:contain;margin-bottom:16px;border-radius:0;"/>' +
        '<div style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.6;font-weight:500;">' +
          'Standing by! I\'ll select your best card as soon as it\'s time to pay for your purchase.' +
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

// ── Analyze ──────────────────────────────────────────────────────────────

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

    // ── Trigger 4: Click on payment iframes (Stripe, Braintree, Adyen) ──
    function attachIframeListeners() {
      document.querySelectorAll('iframe').forEach(function(iframe) {
        var src = (iframe.src || '').toLowerCase();
        if (/stripe|braintree|adyen/i.test(src)) {
          // Can't listen inside cross-origin iframes, but listen on clicks near them
          var wrapper = iframe.parentElement;
          if (wrapper) {
            wrapper.addEventListener('click', function() { fireRecommendation('payment iframe click'); }, { once: true });
          }
        }
      });
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

    var interactionObserver = null;
    try {
      var reattachTimeout = null;
      interactionObserver = new MutationObserver(function() {
        if (triggered) return;
        // Debounce: re-attach listeners after DOM settles
        clearTimeout(reattachTimeout);
        reattachTimeout = setTimeout(attachAll, 300);
      });
      interactionObserver.observe(document.body, { childList: true, subtree: true });
    } catch(e) {}

    // Stop watching after 120 seconds
    setTimeout(function() {
      if (!triggered && interactionObserver) {
        interactionObserver.disconnect();
        console.log('[VIDAVA] no payment interaction after 120s — stopping');
      }
    }, 120000);
  });
}

waitForPaymentInteraction();

} // end initOverlay

})();
