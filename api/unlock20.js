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

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const RETURN_URL = 'https://www.sellproducts.ai/?paid20=1&cs={CHECKOUT_SESSION_ID}';
const SKU_NAME = 'AI Store Unlock';
const SKU_DESC = 'One-time unlock of your AI-built dropshipping store. Full store access, supplier connected, ready to launch on Shopify. No subscription.';
const AMOUNT = 2000; // cents
const STRIPE_VERSION = '2026-03-25.dahlia'; // ui_mode:'elements' (renamed from 'custom' in dahlia)

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
  const src = clean(body && body.utm_source);
  if(!src) return null;
  const p = { 'metadata[utm_source]': src };
  const med = clean(body && body.utm_medium);
  const camp = clean(body && body.utm_campaign);
  if(med) p['metadata[utm_medium]'] = med;
  if(camp) p['metadata[utm_campaign]'] = camp;
  return p;
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
        ui: c.ui, custom_error: c.custom_error || '', metadata: c.s.metadata || {} });
    }

    if(q.verify){
      if(!sk) return res.status(200).json({ paid:false, status:'no_keys' });
      const s = await stripe('checkout/sessions/' + encodeURIComponent(String(q.verify).slice(0, 300)));
      const paid = s.payment_status === 'paid' && (s.metadata && s.metadata.type) === 'store_unlock20';
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
        const pi = await stripe('payment_intents', 'POST', {
          amount: String(BUMP_AMOUNT), currency: 'usd', customer, payment_method: pm,
          off_session: 'true', confirm: 'true',
          description: BUMP_NAME,
          'metadata[type]': BUMP_TYPE, 'metadata[base_cs]': cs,
          'metadata[email]': email,
          'metadata[project_id]': (s.metadata && s.metadata.project_id) || ''
        }, 'bump39-' + cs);
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
      utmFromBody(body));
    return res.status(200).json({ ok:true, client_secret: c.s.client_secret, publishable_key: pk,
      ui: c.ui, custom_error: c.custom_error || '' });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
