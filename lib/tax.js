/* Sell Products AI — Stripe Tax for one-click charges.
   Checkout Sessions get tax from automatic_tax. PaymentIntents do not, so every
   one-click upgrade first runs a Tax Calculation with the product's tax code
   and the buyer's billing address from the original checkout, charges exactly
   as before, then records a Stripe Tax transaction for the succeeded charge.
   Refunds made by the owner are mirrored as tax reversals by a cron sweep, so
   reporting and filing stay complete. This module never creates refunds,
   never cancels or captures anything, and never changes a charge amount.

   Pricing is tax-inclusive everywhere: the buyer pays the listed price and the
   tax is carved out of it (account setting "Include tax in prices" = yes).

   Tax codes per product were assigned by the sales-tax specialist (Oct 2026).
   A charge is never lost to a tax failure: if the calculation or the attach is
   rejected, the charge goes through untaxed and is tagged in metadata
   (tax_status) so it can be found and reported by hand. */

const CODES = {
  store_unlock20:   'txcd_10701200', // AI Store Unlock $20 — Website Design
  seo_boost:        'txcd_20060002', // SEO Boost $29 — Advertising Services
  image_ads_10:     'txcd_10501000', // 10 Image Ads $49 — Digital photographs/images, downloaded
  video_ad_1:       'txcd_10402100', // Custom Video Ad $39 — Digital audio-visual works, downloaded
  video_ads_5_199:  'txcd_10402100', // 5 Custom Video Ads $199 — same
  video_ads_5_299:  'txcd_10804003', // 5 Custom Video Ads + members area $299 — Digital AV works bundle
  unlimited_stores: 'txcd_10103001', // Unlimited AI Stores $39 — SaaS, business use
  profit_emails:    'txcd_10701410'  // 10 Profit Emails $29 — Electronically delivered information services, business use
};

async function sreq(sk, path, params, idemKey, version){
  const opts = { method: params ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + sk } };
  if(idemKey) opts.headers['Idempotency-Key'] = idemKey;
  if(version) opts.headers['Stripe-Version'] = version;
  if(params){
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if(!r.ok){
    const err = new Error((j.error && j.error.message) || ('stripe ' + r.status));
    err.param = j.error && j.error.param; err.code = j.error && j.error.code; err.status = r.status;
    throw err;
  }
  return j;
}

/* customer_details[address] params from a Checkout Session's billing address.
   ZIP + country is the owner-approved minimum; state, city and street ride
   along whenever Stripe collected them. */
function addressParams(addr){
  const a = addr || {}; const out = {};
  const map = { country:'country', postal_code:'postal_code', state:'state', city:'city', line1:'line1', line2:'line2' };
  Object.keys(map).forEach(k => { if(a[k]) out['customer_details[address][' + map[k] + ']'] = String(a[k]).slice(0, 120); });
  if(out['customer_details[address][postal_code]'] && !out['customer_details[address][country]'])
    out['customer_details[address][country]'] = 'US';
  if(Object.keys(out).length) out['customer_details[address_source]'] = 'billing';
  return out;
}

/* items: [{key, amount}] — key from CODES, amount in cents at the listed
   (tax-inclusive) price. One line item per product so taxability is per product. */
async function calculate(sk, items, address, ip){
  const p = { currency: 'usd' };
  items.forEach((it, i) => {
    if(!CODES[it.key]) throw new Error('no_tax_code:' + it.key);
    p['line_items[' + i + '][amount]'] = String(it.amount);
    p['line_items[' + i + '][quantity]'] = '1';
    p['line_items[' + i + '][reference]'] = it.key;
    p['line_items[' + i + '][tax_code]'] = CODES[it.key];
    p['line_items[' + i + '][tax_behavior]'] = 'inclusive';
  });
  const ap = addressParams(address);
  if(Object.keys(ap).length) Object.assign(p, ap);
  else if(ip) p['customer_details[ip_address]'] = ip;
  else throw new Error('no_customer_location');
  return sreq(sk, 'tax/calculations', p);
}

/* Record the tax transaction for a succeeded PaymentIntent from its
   calculation (Stripe's standard custom-flow integration; the attach-to-
   PaymentIntent shortcut is not available on this account's API). Never
   throws: the money has been taken, so a recording problem is tagged on the
   PaymentIntent for the specialist to see, not surfaced to the buyer. */
async function record(sk, pi, calc){
  try{
    const tx = await sreq(sk, 'tax/transactions/create_from_calculation',
      { calculation: calc.id, reference: pi.id, 'metadata[payment_intent]': pi.id }, 'taxtx-' + pi.id);
    await sreq(sk, 'payment_intents/' + pi.id, { 'metadata[tax_transaction]': tx.id, 'metadata[tax_status]': 'recorded' });
    pi.metadata = Object.assign({}, pi.metadata, { tax_transaction: tx.id, tax_status: 'recorded' });
  }catch(e){
    try{ await sreq(sk, 'payment_intents/' + pi.id, { 'metadata[tax_status]': 'record_failed:' + String(e && e.message || e).slice(0, 60) }); }catch(e2){}
  }
  return pi;
}

/* The one-click charge with tax. piParams is the usual PaymentIntent body
   (amount, currency, customer, payment_method, off_session, confirm, metadata).
   Returns the PaymentIntent; throws on a declined/failed charge exactly as a
   direct create would, so callers keep their existing fallbacks.
   Order: calculate → charge (same idempotency key as before) → record. */
async function charge(sk, piParams, idemKey, items, address, ip){
  let calc = null;
  try{ calc = await calculate(sk, items, address, ip); }
  catch(e){ piParams['metadata[tax_status]'] = 'uncalculated:' + String(e && e.message || e).slice(0, 60); }
  if(!calc) return sreq(sk, 'payment_intents', piParams, idemKey);
  piParams.amount = String(calc.amount_total); // inclusive: equals the listed total
  piParams['metadata[tax_calculation]'] = calc.id;
  piParams['metadata[tax_amount]'] = String(calc.tax_amount_inclusive || 0);
  piParams['metadata[tax_status]'] = 'calculated';
  const pi = await sreq(sk, 'payment_intents', piParams, idemKey);
  if(pi && pi.status === 'succeeded') await record(sk, pi, calc);
  return pi;
}

/* Refunds: reverse the recorded tax transaction so reports and filings net
   out. Runs from the 5-minute cron; looks at refunds from the last 72 hours,
   skips any already reversed (tagged on the PaymentIntent). Returns a summary. */
async function sweepReversals(sk, hours){
  const since = Math.floor(Date.now() / 1000) - (hours || 72) * 3600;
  const out = { checked: 0, reversed: [], skipped: 0, errors: [] };
  let after = '';
  for(let page = 0; page < 5; page++){
    const l = await sreq(sk, 'refunds?limit=100&created[gte]=' + since + (after ? '&starting_after=' + after : ''));
    const data = (l && l.data) || [];
    for(const rf of data){
      out.checked++;
      if(rf.status !== 'succeeded' || !rf.payment_intent) continue;
      const piId = typeof rf.payment_intent === 'string' ? rf.payment_intent : rf.payment_intent.id;
      const tag = 'tax_rev_' + rf.id.slice(-10);
      try{
        const pi = await sreq(sk, 'payment_intents/' + piId);
        const m = (pi && pi.metadata) || {};
        if(!m.tax_transaction || m[tag]){ out.skipped++; continue; }
        const full = rf.amount >= pi.amount;
        const params = { original_transaction: m.tax_transaction, reference: rf.id, mode: full ? 'full' : 'partial',
          'metadata[refund]': rf.id, 'metadata[payment_intent]': piId };
        if(!full) params.flat_amount = String(-rf.amount);
        const rev = await sreq(sk, 'tax/transactions/create_reversal', params, 'taxrev-' + rf.id);
        await sreq(sk, 'payment_intents/' + piId, { ['metadata[' + tag + ']']: rev.id });
        out.reversed.push({ refund: rf.id, pi: piId, reversal: rev.id, mode: params.mode });
      }catch(e){ out.errors.push({ refund: rf.id, error: String(e && e.message || e).slice(0, 120) }); }
    }
    if(!l.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

function clientIp(req){
  return String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
}

module.exports = { CODES, calculate, charge, record, sweepReversals, addressParams, clientIp, sreq };
