/* Sell Products AI — $299 "5 Custom Video Ads" upsell checkout.
   Vercel serverless function at /api/upsell299. Charges on OUR Stripe account
   (no DropStart dependency), exactly like the proven /api/upsell49 rail.

   POST {cs, project_id?, product?} — cs = the buyer's PAID $20 unlock session.
        Verifies it, then ONE-CLICK charges the saved card off-session; if the
        card can't be charged silently, returns {client_secret,
        publishable_key} for the embedded-checkout fallback.
   GET  ?verify=<id>  — {paid, base_cs, email} for cs_/pi_ ids (return leg).
   GET  ?ping=1       — env sanity.
   POST {probe:KEY}   — key-gated: creates an unused session to prove scopes.

   The embedded fallback returns to ?upsold=1&cs=<base>&upsell_cs=<cs_299>,
   the same deep-link the legacy DropStart $299 checkout used, so the
   existing dsResumeAfterUpsell() handler settles it unchanged. */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const RETURN_URL = 'https://www.sellproducts.ai/?upsold=1&cs={BASE}&upsell_cs={CHECKOUT_SESSION_ID}';
const SKU_NAME = '5 Custom Video Ads';
const SKU_DESC = 'Five ready-to-run video ads produced for your store’s product. Delivered digitally to your email.';
const AMOUNT = 29900; // cents
const SKU_TYPE = 'video_ads_5';

function keys(){
  return { sk: process.env.STRIPE_SECRET_KEY || '', pk: process.env.STRIPE_PUBLISHABLE_KEY || '' };
}

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

/* the payment method saved by the $20 unlock — customer default, then the
   newest attached method */
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
    'metadata[type]': SKU_TYPE,
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
      return res.status(200).json({ ok:true, hasSecret: !!sk, hasPublishable: !!pk, amount: AMOUNT });
    }

    if(q.verify){
      if(!sk) return res.status(200).json({ paid:false, status:'no_keys' });
      const id = String(q.verify).slice(0, 300);
      if(/^pi_/.test(id)){ // one-click charge (PaymentIntent, no redirect leg)
        const p = await stripe('payment_intents/' + encodeURIComponent(id));
        const paid = p.status === 'succeeded' && (p.metadata && p.metadata.type) === SKU_TYPE;
        return res.status(200).json({ paid, base_cs: (p.metadata && p.metadata.base_cs) || '',
          product: (p.metadata && p.metadata.product) || '',
          email: p.receipt_email || '', amount: p.amount || 0 });
      }
      const s = await stripe('checkout/sessions/' + encodeURIComponent(id));
      const paid = s.payment_status === 'paid' && (s.metadata && s.metadata.type) === SKU_TYPE;
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

    /* real flow: require a PAID base session on our account */
    const baseCs = String(body.cs || '').slice(0, 300);
    if(!baseCs) return res.status(400).json({ ok:false, status:'no_base_cs' });
    const base = await stripe('checkout/sessions/' + encodeURIComponent(baseCs));
    if(base.payment_status !== 'paid') return res.status(200).json({ ok:false, status:'base_not_paid' });
    const customer = typeof base.customer === 'string' ? base.customer : '';
    const email = (base.customer_details && base.customer_details.email) || '';
    const projectId = String(body.project_id || '');
    const product = String(body.product || '').slice(0, 120);

    /* ONE-CLICK: charge the payment method saved by the $20 unlock,
       off-session — no checkout UI at all. The idempotency key pins one $299
       charge per base session, so double-taps can never double-charge. */
    if(customer){
      /* already bought? return the existing charge instead of making another */
      try{
        const prev = await stripe('payment_intents?customer=' + customer + '&limit=20');
        const hit = ((prev && prev.data) || []).find(p => p.status === 'succeeded' &&
          p.metadata && p.metadata.type === SKU_TYPE && p.metadata.base_cs === baseCs);
        if(hit) return res.status(200).json({ ok:true, charged:true, pi: hit.id, email, repeat:true });
      }catch(e){}

      const pm = await defaultPm(customer);
      if(pm){
        try{
          const pi = await stripe('payment_intents', 'POST', {
            amount: String(AMOUNT), currency: 'usd', customer, payment_method: pm,
            off_session: 'true', confirm: 'true',
            description: SKU_NAME,
            'metadata[type]': SKU_TYPE, 'metadata[base_cs]': baseCs,
            'metadata[project_id]': projectId, 'metadata[product]': product
          }, 'upsell299-' + baseCs);
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
