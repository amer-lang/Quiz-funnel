/* Sell Products AI — $49 "10 Custom Image Ads" upsell checkout.
   Vercel serverless function at /api/upsell49. Charges on OUR Stripe account
   directly (no DropStart dependency for this SKU).

   POST {cs, project_id?}       — cs = the buyer's PAID $1 checkout session.
                                  Verifies it, reuses its Customer so the card
                                  prefills, and returns {client_secret,
                                  publishable_key} for embedded checkout.
   GET  ?verify=<upsell_cs>     — {paid, base_cs, email} for the return leg.
   GET  ?ping=1                 — env sanity: which keys are present.
   POST {probe:KEY}             — key-gated: creates a $49 session WITHOUT a
                                  base session, to prove key permissions.

   Env: STRIPE_SECRET_KEY (restricted: Checkout Sessions RW, Customers R,
   PaymentIntents R), STRIPE_PUBLISHABLE_KEY. */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const RETURN_URL = 'https://www.sellproducts.ai/?upsold49=1&cs={BASE}&upsell_cs={CHECKOUT_SESSION_ID}';
const SKU_NAME = '10 Custom Image Ads';
const SKU_DESC = 'Ten ready-to-run image ads (feed + story formats) designed for your store’s product. Delivered digitally.';
const AMOUNT = 4900; // cents

function keys(){
  return { sk: process.env.STRIPE_SECRET_KEY || '', pk: process.env.STRIPE_PUBLISHABLE_KEY || '' };
}

/* minimal Stripe REST client (form-encoded), no SDK needed */
async function stripe(path, method, params, idemKey){
  const { sk } = keys();
  const opts = { method: method || 'GET', headers: { Authorization: 'Bearer ' + sk } };
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

/* the payment method saved by the $1 subscription — subscription default,
   then customer default, then the newest attached method */
async function defaultPm(customer, subId){
  try{
    if(subId){
      const sub = await stripe('subscriptions/' + subId);
      if(typeof sub.default_payment_method === 'string' && sub.default_payment_method) return sub.default_payment_method;
    }
  }catch(e){}
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

async function createSession(customer, baseCs, projectId, product){
  const params = {
    'mode': 'payment',
    'ui_mode': 'embedded',
    'return_url': RETURN_URL.replace('{BASE}', encodeURIComponent(baseCs || '')),
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(AMOUNT),
    'line_items[0][price_data][product_data][name]': SKU_NAME,
    'line_items[0][price_data][product_data][description]': SKU_DESC,
    'metadata[type]': 'image_ads_10',
    'metadata[base_cs]': baseCs || '',
    'metadata[project_id]': projectId || '',
    'metadata[product]': String(product || '').slice(0, 120)
  };
  if(customer) params['customer'] = customer;
  return stripe('checkout/sessions', 'POST', params);
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
      return res.status(200).json({ ok:true, hasSecret: !!sk, secretType: sk.slice(0, 3), hasPublishable: !!pk });
    }

    /* key-gated session inspector (GET) — full shape of any session on our account */
    if(q.inspect){
      if(q.inspect !== READ_KEY) return res.status(403).json({ ok:false });
      const s = await stripe('checkout/sessions/' + encodeURIComponent(String(q.cs || '').slice(0, 300)) +
        '?expand[]=line_items&expand[]=subscription');
      return res.status(200).json({ ok:true, mode: s.mode, ui_mode: s.ui_mode, status: s.status,
        payment_status: s.payment_status, amount_total: s.amount_total, currency: s.currency,
        metadata: s.metadata, success_url: s.success_url, return_url: s.return_url, cancel_url: s.cancel_url,
        customer: s.customer, customer_creation: s.customer_creation,
        subscription: s.subscription && (typeof s.subscription === 'string' ? s.subscription :
          { id: s.subscription.id, status: s.subscription.status, trial_end: s.subscription.trial_end }),
        line_items: s.line_items && (s.line_items.data || []).map(li => ({ desc: li.description,
          amount: li.amount_total, recurring: !!(li.price && li.price.recurring),
          interval: li.price && li.price.recurring && li.price.recurring.interval })) });
    }

    /* key-gated one-click DRY RUN (GET) — walks the exact lookup chain the
       live charge uses on a REAL paid $1 session (latest one, or ?cs=…) and
       reports what it would charge, without creating any PaymentIntent. */
    if(q.dryrun){
      if(q.dryrun !== READ_KEY) return res.status(403).json({ ok:false });
      let base = null;
      if(q.cs){
        base = await stripe('checkout/sessions/' + encodeURIComponent(String(q.cs).slice(0, 300)));
      }else{
        const l = await stripe('checkout/sessions?limit=20');
        base = ((l && l.data) || []).find(s => s.payment_status === 'paid' &&
          (s.metadata && s.metadata.type) !== 'image_ads_10') || null;
      }
      if(!base) return res.status(200).json({ ok:false, status:'no_paid_base_found' });
      const cust = typeof base.customer === 'string' ? base.customer : '';
      const pm = cust ? await defaultPm(cust, typeof base.subscription === 'string' ? base.subscription : '') : '';
      let pmType = '';
      if(pm){ try{ const p = await stripe('payment_methods/' + pm); pmType = p.type + (p.card ? ':' + p.card.brand : ''); }catch(e){} }
      let prior = [];
      if(cust){
        try{
          const prev = await stripe('payment_intents?customer=' + cust + '&limit=20');
          prior = ((prev && prev.data) || []).filter(p => p.metadata && p.metadata.type === 'image_ads_10')
            .map(p => ({ id: p.id, status: p.status, amount: p.amount }));
        }catch(e){}
      }
      return res.status(200).json({ ok:true, base_cs: base.id, base_paid: base.payment_status === 'paid',
        base_amount: base.amount_total, customer: cust || null, has_pm: !!pm, pm_type: pmType || null,
        would_charge: pm ? AMOUNT : null, prior_49_charges: prior,
        one_click_ready: !!(cust && pm) });
    }

    /* key-gated permission probe (GET) — creates a $49 session with no base
       session purely to prove the key's scopes; it simply expires unused */
    if(q.probe){
      if(q.probe !== READ_KEY) return res.status(403).json({ ok:false });
      if(!sk || !pk) return res.status(200).json({ ok:false, status:'no_keys' });
      const s = await createSession(null, '', '');
      return res.status(200).json({ ok:true, session: s.id, has_secret: !!s.client_secret });
    }

    if(q.verify){
      if(!sk) return res.status(200).json({ paid:false, status:'no_keys' });
      const id = String(q.verify).slice(0, 300);
      if(/^pi_/.test(id)){ // one-click charge (PaymentIntent, no redirect leg)
        const p = await stripe('payment_intents/' + encodeURIComponent(id));
        const paid = p.status === 'succeeded' && (p.metadata && p.metadata.type) === 'image_ads_10';
        return res.status(200).json({ paid, base_cs: (p.metadata && p.metadata.base_cs) || '',
          product: (p.metadata && p.metadata.product) || '',
          email: p.receipt_email || '', amount: p.amount || 0 });
      }
      const s = await stripe('checkout/sessions/' + encodeURIComponent(id));
      const paid = s.payment_status === 'paid' && (s.metadata && s.metadata.type) === 'image_ads_10';
      return res.status(200).json({ paid, base_cs: (s.metadata && s.metadata.base_cs) || '',
        product: (s.metadata && s.metadata.product) || '',
        email: (s.customer_details && s.customer_details.email) || '', amount: s.amount_total || 0 });
    }

    if(req.method !== 'POST') return res.status(405).json({ ok:false });
    if(!sk || !pk) return res.status(200).json({ ok:false, status:'no_keys' });
    const body = await readBody(req);

    /* key-gated permission probe (no base session, test only) */
    if(body.probe){
      if(body.probe !== READ_KEY) return res.status(403).json({ ok:false });
      const s = await createSession(null, '', '');
      return res.status(200).json({ ok:true, session: s.id, has_secret: !!s.client_secret });
    }

    /* real flow: require a PAID $1 base session on our account */
    const baseCs = String(body.cs || '').slice(0, 300);
    if(!baseCs) return res.status(400).json({ ok:false, status:'no_base_cs' });
    const base = await stripe('checkout/sessions/' + encodeURIComponent(baseCs));
    if(base.payment_status !== 'paid') return res.status(200).json({ ok:false, status:'base_not_paid' });
    const customer = typeof base.customer === 'string' ? base.customer : '';
    const email = (base.customer_details && base.customer_details.email) || '';
    const projectId = String(body.project_id || '');
    const product = String(body.product || '').slice(0, 120);

    /* ONE-CLICK: charge the payment method saved by the $1 subscription,
       off-session — no checkout UI at all. The idempotency key pins one $49
       charge per base session, so double-taps can never double-charge. */
    if(customer){
      /* already bought? return the existing charge instead of making another */
      try{
        const prev = await stripe('payment_intents?customer=' + customer + '&limit=20');
        const hit = ((prev && prev.data) || []).find(p => p.status === 'succeeded' &&
          p.metadata && p.metadata.type === 'image_ads_10' && p.metadata.base_cs === baseCs);
        if(hit) return res.status(200).json({ ok:true, charged:true, pi: hit.id, email, repeat:true });
      }catch(e){}

      const pm = await defaultPm(customer, typeof base.subscription === 'string' ? base.subscription : '');
      if(pm){
        try{
          const pi = await stripe('payment_intents', 'POST', {
            amount: String(AMOUNT), currency: 'usd', customer, payment_method: pm,
            off_session: 'true', confirm: 'true',
            description: SKU_NAME,
            'metadata[type]': 'image_ads_10', 'metadata[base_cs]': baseCs,
            'metadata[project_id]': projectId, 'metadata[product]': product
          }, 'upsell49-' + baseCs);
          if(pi.status === 'succeeded')
            return res.status(200).json({ ok:true, charged:true, pi: pi.id, email });
        }catch(e){ /* declined / needs authentication → embedded checkout below */ }
      }
    }

    const s = await createSession(customer, baseCs, projectId, product);
    return res.status(200).json({ ok:true, client_secret: s.client_secret, publishable_key: pk });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
