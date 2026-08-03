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

const READ_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';
const RETURN_URL = 'https://www.sellproducts.ai/?upsold49=1&cs={BASE}&upsell_cs={CHECKOUT_SESSION_ID}';
const SKU_NAME = '10 Custom Image Ads';
const SKU_DESC = 'Ten ready-to-run image ads (feed + story formats) designed for your store’s product. Delivered digitally.';
const AMOUNT = 4900; // cents

function keys(){
  return { sk: process.env.STRIPE_SECRET_KEY || '', pk: process.env.STRIPE_PUBLISHABLE_KEY || '' };
}

/* minimal Stripe REST client (form-encoded), no SDK needed */
async function stripe(path, method, params){
  const { sk } = keys();
  const opts = { method: method || 'GET', headers: { Authorization: 'Bearer ' + sk } };
  if(params){
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(params).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
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
      const s = await stripe('checkout/sessions/' + encodeURIComponent(String(q.verify).slice(0, 300)));
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

    const s = await createSession(typeof base.customer === 'string' ? base.customer : '', baseCs,
      String(body.project_id || ''), String(body.product || ''));
    return res.status(200).json({ ok:true, client_secret: s.client_secret, publishable_key: pk });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
