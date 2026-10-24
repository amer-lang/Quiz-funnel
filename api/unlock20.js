/* Sell Products AI — $20 ONE-TIME store unlock (no subscription).
   Vercel serverless function at /api/unlock20. Charges on OUR Stripe account.

   POST {project_id, email?, product?} — creates a $20 one-time Checkout
        Session (ui_mode CUSTOM: the funnel renders its own summary, payment
        element, order-bump box and pay button) and returns {client_secret,
        publishable_key}. customer_creation=always + setup_future_usage=
        off_session so the card is saved for the bump + $299 one-click.
        If the email already owns the Unlimited add-on, returns
        {unlimited:true, cs} instead — no checkout, the store unlocks free.
   POST {bump_charge:1, cs} — after the $20 session is PAID: one-click
        charges the $39 "Unlimited AI Stores" bump on the saved card.
        Idempotent per base session; safe on double calls.
   GET  ?verify=<cs>  — {paid, project_id, email, amount} for the return leg.
   GET  ?ping=1       — env sanity.
   GET  ?probe=<KEY>  — key-gated: creates an unused test session to prove scopes. */

const { guardKey } = require('../lib/secrets');

const READ_KEY = guardKey('READ_KEY');
const RETURN_URL = 'https://www.sellproducts.ai/?paid20=1&cs={CHECKOUT_SESSION_ID}';
const SKU_NAME = 'AI Store Unlock';
const SKU_DESC = 'One-time unlock of your AI-built dropshipping store. Full store access, supplier connected, ready to launch on Shopify. No subscription.';
const AMOUNT = 2000; // cents
const STRIPE_VERSION = '2026-03-25.dahlia'; // ui_mode:'elements' (renamed from 'custom' in dahlia)
const tax = require('../lib/tax');
const dealfuel = require('../lib/dealfuel');

/* Order bump — a SEPARATE one-click charge right after the $20 confirms,
   so ticking the box never rebuilds the payment form. */
const BUMP_NAME = 'Unlimited AI Stores';
const BUMP_AMOUNT = 3900; // cents
const BUMP_TYPE = 'store_bump_unlimited';

function keys(){
  return { sk: process.env.STRIPE_SECRET_KEY || '', pk: process.env.STRIPE_PUBLISHABLE_KEY || '' };
}

async function stripe(path, method, params, idemKey, version){
  const { sk } = keys();
  const opts = { method: method || 'GET', headers: { Authorization: 'Bearer ' + sk } };
  if(version) opts.headers['Stripe-Version'] = version;
  if(idemKey) opts.headers['Idempotency-Key'] = idemKey;
  if(params){
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

/* Email-attribution UTMs (funnel stores the click, sends it with the claim).
   Stamped on the session so /api/emailrev can pay commission on Stripe truth.
   Upsell PIs all carry metadata[base_cs] → they join to this session's UTM. */
function utmFromBody(body){
  const clean = v => String(v || '').toLowerCase().replace(/[^a-z0-9._\-]/g, '').slice(0, 60);
  const cleanId = v => String(v || '').replace(/[^A-Za-z0-9._\-]/g, '').slice(0, 80); // click ids are case-sensitive
  const src = clean(body && body.utm_source);
  const waid = cleanId(body && body.waid);
  if(!src && !waid) return null;
  const p = {};
  if(src) p['metadata[utm_source]'] = src;
  const med = clean(body && body.utm_medium);
  const camp = clean(body && body.utm_campaign);
  if(med) p['metadata[utm_medium]'] = med;
  if(camp) p['metadata[utm_campaign]'] = camp;
  if(waid) p['metadata[waid]'] = waid;
  const wacid = cleanId(body && body.wacid);
  const wasid = cleanId(body && body.wasid);
  if(wacid) p['metadata[wacid]'] = wacid;
  if(wasid) p['metadata[wasid]'] = wasid;
  return p;
}

/* buyer details the funnel knows at checkout → session metadata, so the
   DealFuel lead can be built from the paid session alone */
function leadMeta(body){
  const out = {};
  const fn = String((body && body.first_name) || '').normalize('NFC').replace(/[^\p{L}\p{M}' .-]/gu, '').trim().slice(0, 40);
  const ph = String((body && body.phone) || '').replace(/[^\d+() .-]/g, '').trim().slice(0, 40);
  const tz = String((body && body.tz) || '').trim();
  if(fn) out['metadata[first_name]'] = fn;
  if(ph && ph.replace(/\D/g, '').length >= 10) out['metadata[phone]'] = ph;
  out['metadata[sms_consent]'] = (body && (body.sms_consent === 1 || body.sms_consent === '1' || body.sms_consent === true)) ? '1' : '0';
  if(/^[A-Za-z_]+\/[A-Za-z0-9_+\-\/]+$|^UTC$/.test(tz) && tz.length <= 60) out['metadata[tz]'] = tz;
  return out;
}

function sessionParams(projectId, email, product, uiMode, utm){
  const params = {
    'mode': 'payment',
    'ui_mode': uiMode,
    'return_url': RETURN_URL,
    'customer_creation': 'always',
    'payment_intent_data[setup_future_usage]': 'off_session',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(AMOUNT),
    // TAX-INCLUSIVE by owner decision (2026-09-09): the buyer always pays a
    // flat $20.00; in states with an active Stripe Tax registration the tax
    // is carved OUT of the $20 and remitted. Chosen over tax-on-top because
    // this checkout's completion is measurably sensitive to any price/copy
    // change. Product taxability comes from the account's default tax code
    // in Stripe Tax settings — deliberately not hardcoded here.
    'line_items[0][price_data][tax_behavior]': 'inclusive',
    'line_items[0][price_data][product_data][tax_code]': tax.CODES.store_unlock20, // Website Design (tax specialist, Oct 2026)
    'automatic_tax[enabled]': 'true',
    'line_items[0][price_data][product_data][name]': SKU_NAME,
    'line_items[0][price_data][product_data][description]': SKU_DESC,
    'metadata[type]': 'store_unlock20',
    'metadata[project_id]': String(projectId || ''),
    'metadata[product]': String(product || '').slice(0, 120)
  };
  if(utm) Object.assign(params, utm);
  if(email) params['customer_email'] = String(email).slice(0, 120);
  return params;
}

/* Prefer ui_mode:'elements' (funnel renders its own form + order bump; the
   dahlia release renamed 'custom' to 'elements'). If the account/API rejects
   it for any reason, fall back to the embedded checkout that ran the price
   flip — checkout must never be down over UI mode. */
async function createSession(projectId, email, product, forceEmbedded, utm){
  if(!forceEmbedded){
    try{
      const s = await stripe('checkout/sessions', 'POST',
        sessionParams(projectId, email, product, 'elements', utm), null, STRIPE_VERSION);
      return { s, ui: 'custom' };
    }catch(e){
      var customErr = String(e && e.message || e).slice(0, 200);
    }
  }
  const s = await stripe('checkout/sessions', 'POST',
    sessionParams(projectId, email, product, 'embedded', utm));
  return { s, ui: 'embedded', custom_error: customErr || '' };
}

/* card saved by the $20 payment — customer default, else newest attached */
async function defaultPm(customer){
  try{
    const c = await stripe('customers/' + customer);
    const d = c.invoice_settings && c.invoice_settings.default_payment_method;
    if(typeof d === 'string' && d) return d;
  }catch(e){}
  try{
    const l = await stripe('payment_methods?customer=' + customer + '&limit=10');
    const arr = (l && l.data) || [];
    const pick = arr.find(p => p.type === 'card') || arr.find(p => p.type === 'link') || arr[0];
    return pick ? pick.id : '';
  }catch(e){}
  return '';
}

/* Does this email already own the Unlimited add-on? Searches succeeded bump
   charges by the email stamped in their metadata. Returns the buyer's paid
   BASE session id so the funnel can unlock further stores against it. */
async function findUnlimited(email){
  if(!email) return '';
  const em = String(email).trim().toLowerCase().replace(/'/g, '');
  // Two shapes own Unlimited: the legacy checkout bump (type marker) and the
  // launch-sequence add-on charge (unlimited='1' flag from /api/addons).
  const queries = [
    "status:'succeeded' AND metadata['type']:'" + BUMP_TYPE + "' AND metadata['email']:'" + em + "'",
    "status:'succeeded' AND metadata['unlimited']:'1' AND metadata['email']:'" + em + "'"
  ];
  for(const q of queries){
    try{
      const r = await stripe('payment_intents/search?limit=1&query=' + encodeURIComponent(q));
      const hit = ((r && r.data) || [])[0];
      if(hit) return String((hit.metadata && hit.metadata.base_cs) || '');
    }catch(e){}
  }
  return '';
}

function readBody(req){
  if(req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => { try{ resolve(JSON.parse(raw || '{}')); }catch(e){ resolve({}); } });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') return res.status(204).end();
  const q = req.query || {};
  const { sk, pk } = keys();

  try{
    if(q.ping === '1'){
      return res.status(200).json({ ok:true, hasSecret: !!sk, hasPublishable: !!pk, amount: AMOUNT });
    }

    if(q.probe){
      if(q.probe !== READ_KEY) return res.status(403).json({ ok:false });
      if(!sk || !pk) return res.status(200).json({ ok:false, status:'no_keys' });
      const utm = utmFromBody({ utm_source: q.utm_source, utm_medium: q.utm_medium, utm_campaign: q.utm_campaign });
      const c = await createSession('0', '', 'probe', false, utm);
      return res.status(200).json({ ok:true, session: c.s.id, has_secret: !!c.s.client_secret,
        ui: c.ui, custom_error: c.custom_error || '', metadata: c.s.metadata || {},
        automatic_tax: c.s.automatic_tax || null });
    }

    /* owner check of the Stripe Tax wiring: a Tax Calculation for a ZIP and a
       product. Read-only: no customer, no card, no PaymentIntent. */
    if(q.taxprobe){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const zip = String(q.zip || '').replace(/\D/g, '').slice(0, 5);
      const key = String(q.item || 'store_unlock20');
      const amt = parseInt(q.amount || '2000', 10) || 2000;
      const calc = await tax.calculate(sk, [{ key, amount: amt }], { country:'US', postal_code: zip });
      return res.status(200).json({ ok:true, zip, item: key, tax_code: tax.CODES[key],
        calc: { id: calc.id, amount_total: calc.amount_total, tax_inclusive: calc.tax_amount_inclusive,
          breakdown: (calc.tax_breakdown || []).map(b => ({ amount: b.amount, rate: b.tax_rate_details && b.tax_rate_details.percentage_decimal, taxable: b.taxability_reason })) } });
    }

    /* owner: recent PaymentIntents with their Stripe Tax status (read-only) */
    if(q.taxrecent){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const n = Math.min(parseInt(q.n || '25', 10) || 25, 100);
      const since = parseInt(q.since || '0', 10) || 0;
      const l = await tax.sreq(sk, 'payment_intents?limit=' + n + (since ? '&created[gte]=' + since : ''));
      const rows = ((l && l.data) || []).map(p => ({ id: p.id, created: p.created, status: p.status, amount: p.amount,
        type: p.metadata && p.metadata.type, tax_status: p.metadata && p.metadata.tax_status, tax_amount: p.metadata && p.metadata.tax_amount,
        tax_transaction: p.metadata && p.metadata.tax_transaction, dealfuel: p.metadata && p.metadata.dealfuel }));
      return res.status(200).json({ ok:true, count: rows.length, taxed: rows.filter(r => r.tax_status).length, rows });
    }

    /* owner: one recorded Stripe Tax transaction with Stripe's own reasons (read-only) */
    if(q.taxtx){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const id = String(q.taxtx).replace(/[^A-Za-z0-9_]/g, '').slice(0, 80);
      const t = await tax.sreq(sk, 'tax/transactions/' + id + '?expand[]=line_items');
      const a = (t.customer_details && t.customer_details.address) || {};
      return res.status(200).json({ ok:true, id: t.id, reference: t.reference, created: t.created,
        address: { state: a.state, postal_code: a.postal_code, country: a.country, source: t.customer_details && t.customer_details.address_source },
        lines: (((t.line_items || {}).data) || []).map(li => ({ ref: li.reference, tax_code: li.tax_code, amount: li.amount, amount_tax: li.amount_tax, behavior: li.tax_behavior,
          breakdown: (li.tax_breakdown || []).map(b => ({ amount: b.amount, reason: b.taxability_reason, rate: b.tax_rate_details && b.tax_rate_details.percentage_decimal, state: b.jurisdiction && b.jurisdiction.state })) })) });
    }

    /* owner: duplicate-charge scan (read-only). Every PaymentIntent since a
       timestamp, grouped by base order + product; reports any pair of
       succeeded charges for the same buyer and product, plus totals. */
    if(q.taxdupes){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const since = parseInt(q.since || '0', 10) || (Math.floor(Date.now() / 1000) - 86400);
      const groups = {}, byStatus = {}, byType = {}, noneAmounts = {}; let after = '', total = 0;
      for(let page = 0; page < 20; page++){
        const l = await tax.sreq(sk, 'payment_intents?limit=100&created[gte]=' + since + (after ? '&starting_after=' + after : ''));
        const data = (l && l.data) || [];
        for(const p of data){
          total++;
          const m = p.metadata || {}, ty = m.type || '(none)';
          byStatus[p.status] = (byStatus[p.status] || 0) + 1;
          byType[ty] = (byType[ty] || 0) + 1;
          if(!m.type) noneAmounts[p.amount] = (noneAmounts[p.amount] || 0) + 1;
          if(m.type && m.base_cs){
            const k = m.base_cs + '|' + ty + (m.items ? '|' + m.items : '');
            (groups[k] = groups[k] || []).push({ id: p.id, status: p.status, amount: p.amount, created: p.created, tax: m.tax_status || '' });
          }
        }
        if(!l.has_more || !data.length) break;
        after = data[data.length - 1].id;
      }
      const dupes = Object.entries(groups).filter(([k, v]) => v.filter(x => x.status === 'succeeded').length > 1)
        .map(([k, v]) => ({ key: k.slice(0, 40) + '…' + k.slice(k.indexOf('|')), charges: v }));
      const multiAttempt = Object.values(groups).filter(v => v.length > 1).length;
      return res.status(200).json({ ok:true, since, scanned: total, by_status: byStatus, by_type: byType,
        amounts_without_our_metadata: noneAmounts, buyers_with_more_than_one_attempt: multiAttempt,
        double_charged: dupes.length, dupes });
    }

    /* owner: charge-attempt scan (read-only). Counts Charge objects since a
       timestamp by status, failure code and attempts per PaymentIntent. */
    if(q.taxcharges){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const since = parseInt(q.since || '0', 10) || (Math.floor(Date.now() / 1000) - 86400);
      const until = parseInt(q.until || '0', 10) || 0;
      const byStatus = {}, byFail = {}, perPi = {}, byHour = {}; let after = '', total = 0, noPi = 0, succeededAmount = 0, amounts = {};
      for(let page = 0; page < 30; page++){
        const l = await tax.sreq(sk, 'charges?limit=100&created[gte]=' + since + (until ? '&created[lt]=' + until : '') + (after ? '&starting_after=' + after : ''));
        const data = (l && l.data) || [];
        for(const c of data){
          total++;
          byStatus[c.status] = (byStatus[c.status] || 0) + 1;
          if(c.status === 'succeeded'){ succeededAmount += c.amount; amounts[c.amount] = (amounts[c.amount] || 0) + 1; }
          if(c.status === 'failed') byFail[c.failure_code || 'unknown'] = (byFail[c.failure_code || 'unknown'] || 0) + 1;
          const pi = typeof c.payment_intent === 'string' ? c.payment_intent : (c.payment_intent && c.payment_intent.id);
          if(pi) perPi[pi] = (perPi[pi] || 0) + 1; else noPi++;
          const h = new Date(c.created * 1000).toISOString().slice(11, 13); byHour[h] = (byHour[h] || 0) + 1;
        }
        if(!l.has_more || !data.length) break;
        after = data[data.length - 1].id;
      }
      const multi = Object.values(perPi).filter(n => n > 1);
      return res.status(200).json({ ok:true, since, until, charges: total, by_status: byStatus, succeeded_gross: succeededAmount,
        succeeded_amounts: amounts, failure_codes: byFail, charges_without_payment_intent: noPi,
        payment_intents_with_several_attempts: multi.length, extra_attempts: multi.reduce((s, n) => s + n - 1, 0), by_hour_utc: byHour });
    }

    /* owner: account dashboard timezone (read-only) so day windows match the Stripe app */
    if(q.taxacct){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const a = await tax.sreq(sk, 'account');
      return res.status(200).json({ ok:true, timezone: a.settings && a.settings.dashboard && a.settings.dashboard.timezone, name: a.settings && a.settings.dashboard && a.settings.dashboard.display_name, country: a.country });
    }

    /* owner: run the refund → tax reversal sweep now and show what it did */
    if(q.taxsweep){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const r = await tax.sweepReversals(sk, parseInt(q.hours || '72', 10) || 72);
      return res.status(200).json(Object.assign({ ok:true }, r));
    }

    /* owner: DealFuel dry run — build the lead payload for a paid session (or the
       latest paid unlock) without sending; shows the once-per-payment marker. */
    if(q.dfprobe){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      let sess = null;
      if(q.cs){ sess = await stripe('checkout/sessions/' + encodeURIComponent(String(q.cs).slice(0, 300))); }
      else{
        const l = await stripe('checkout/sessions?limit=40');
        sess = ((l && l.data) || []).find(x => x.payment_status === 'paid' && x.metadata && x.metadata.type === 'store_unlock20') || null;
      }
      if(!sess) return res.status(200).json({ ok:false, status:'no_paid_session' });
      const r = await dealfuel.sendForSession(sk, sess, { dry: true });
      return res.status(200).json({ ok:true, has_token: !!process.env.DEALFUEL_LEADS_TOKEN, session: sess.id, paid: sess.payment_status === 'paid', result: r });
    }

    /* owner: DealFuel catch-up — send every paid $20 unlock from the last N hours
       that has no once-per-payment marker yet (token set late, tab closed before
       verify, earlier failure). Bounded to ~45 s per run; call again for more. */
    if(q.dfsweep){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false });
      const hours = Math.min(parseInt(q.hours || '24', 10) || 24, 168);
      const since = Math.floor(Date.now() / 1000) - hours * 3600;
      const t0 = Date.now(), out = { scanned: 0, considered: 0, results: {}, stopped_early: false };
      let after = '';
      for(let page = 0; page < 10 && !out.stopped_early; page++){
        const l = await stripe('checkout/sessions?limit=100&created[gte]=' + since + (after ? '&starting_after=' + after : ''));
        const data = (l && l.data) || [];
        for(const x of data){
          out.scanned++;
          if(x.payment_status !== 'paid' || !x.metadata || x.metadata.type !== 'store_unlock20') continue;
          out.considered++;
          const r = await dealfuel.sendForSession(sk, x, { dry: q.dry === '1' }); // dry=1: count only, send nothing
          const k = String((r && r.reason) || 'unknown').replace(/^already_/, 'already_');
          out.results[k] = (out.results[k] || 0) + 1;
          if(Date.now() - t0 > 45000){ out.stopped_early = true; break; }
        }
        if(!l.has_more || !data.length) break;
        after = data[data.length - 1].id;
      }
      return res.status(200).json(Object.assign({ ok:true, hours, dry: q.dry === '1', has_token: !!process.env.DEALFUEL_LEADS_TOKEN }, out));
    }

    if(q.verify){
      if(!sk) return res.status(200).json({ paid:false, status:'no_keys' });
      const s = await stripe('checkout/sessions/' + encodeURIComponent(String(q.verify).slice(0, 300)));
      const paid = s.payment_status === 'paid' && (s.metadata && s.metadata.type) === 'store_unlock20';
      if(paid){ try{ dealfuel.kick(sk, s); }catch(e){} } // DealFuel lead, background, once per payment
      return res.status(200).json({ paid,
        project_id: (s.metadata && s.metadata.project_id) || '',
        product: (s.metadata && s.metadata.product) || '',
        email: (s.customer_details && s.customer_details.email) || '',
        amount: s.amount_total || 0 });
    }

    if(req.method !== 'POST') return res.status(405).json({ ok:false });
    if(!sk || !pk) return res.status(200).json({ ok:false, status:'no_keys' });
    const body = await readBody(req);

    /* ---- order bump: one-click $39 on the card just saved by the $20 ---- */
    if(body.bump_charge){
      const cs = String(body.cs || '').slice(0, 300);
      if(!cs) return res.status(400).json({ ok:false, status:'no_cs' });
      const s = await stripe('checkout/sessions/' + encodeURIComponent(cs));
      if(s.payment_status !== 'paid' || (s.metadata && s.metadata.type) !== 'store_unlock20')
        return res.status(200).json({ ok:false, status:'base_not_paid' });
      const customer = typeof s.customer === 'string' ? s.customer : '';
      if(!customer) return res.status(200).json({ ok:false, status:'no_customer' });
      const email = ((s.customer_details && s.customer_details.email) || '').toLowerCase();

      /* already charged for this base session? return it (double-call safe) */
      try{
        const prev = await stripe('payment_intents?customer=' + customer + '&limit=20');
        const hit = ((prev && prev.data) || []).find(p => p.status === 'succeeded' &&
          p.metadata && p.metadata.type === BUMP_TYPE && p.metadata.base_cs === cs);
        if(hit) return res.status(200).json({ ok:true, charged:true, pi: hit.id, repeat:true });
      }catch(e){}

      const pm = await defaultPm(customer);
      if(!pm) return res.status(200).json({ ok:false, status:'no_pm' });
      try{
        const pi = await tax.charge(sk, {
          amount: String(BUMP_AMOUNT), currency: 'usd', customer, payment_method: pm,
          off_session: 'true', confirm: 'true',
          description: BUMP_NAME,
          'metadata[type]': BUMP_TYPE, 'metadata[base_cs]': cs,
          'metadata[email]': email,
          'metadata[project_id]': (s.metadata && s.metadata.project_id) || ''
        }, 'bump39-' + cs, [{ key:'unlimited_stores', amount: BUMP_AMOUNT }],
          s.customer_details && s.customer_details.address, tax.clientIp(req));
        if(pi.status === 'succeeded') return res.status(200).json({ ok:true, charged:true, pi: pi.id });
        return res.status(200).json({ ok:false, status:'not_succeeded' });
      }catch(e){
        return res.status(200).json({ ok:false, status:'declined', detail: String(e && e.message || e).slice(0, 200) });
      }
    }

    /* ---- normal flow: create the $20 checkout (or honor Unlimited) ---- */
    const projectId = String(body.project_id || '').replace(/\D/g, '').slice(0, 20);
    if(!projectId) return res.status(400).json({ ok:false, status:'no_project' });
    const email = String(body.email || '');

    // Unlimited detection moved to our backend (/api/express/unlimited-claim,
    // called by claimStore BEFORE this endpoint). The old email-based Stripe search
    // returned the buyer's OLD base_cs, so finalize re-unlocked the WRONG store.
    // Disabled so the clean backend path is the ONLY unlimited route. TG12106.
    // if(email && !body.embedded){
    //   const owned = await findUnlimited(email);
    //   if(owned) return res.status(200).json({ ok:true, unlimited:true, cs: owned });
    // }

    const c = await createSession(projectId, email, String(body.product || ''), !!body.embedded,
      Object.assign(utmFromBody(body), leadMeta(body)));
    return res.status(200).json({ ok:true, client_secret: c.s.client_secret, publishable_key: pk,
      ui: c.ui, custom_error: c.custom_error || '' });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
