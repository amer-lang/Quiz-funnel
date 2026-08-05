/* Sell Products AI — $20 ONE-TIME store unlock (no subscription).
   Vercel serverless function at /api/unlock20. Charges on OUR Stripe account,
   replacing DropStart's $1-trial + $49/mo checkout for the price test.

   POST {project_id, email?, product?} — creates an embedded $20 one-time
        Checkout Session and returns {client_secret, publishable_key}.
        customer_creation=always + setup_future_usage=off_session so the
        card is saved and the $49 ad-pack one-click upsell still works.
   GET  ?verify=<cs>  — {paid, project_id, email, amount} for the return leg.
   GET  ?ping=1       — env sanity.
   GET  ?probe=<KEY>  — key-gated: creates an unused test session to prove scopes.

   Metadata mirrors DropStart's own sessions (type/project_id) plus our own
   marker so /api/lead.js and the funnel can verify it. Whether DropStart's
   /finalize accepts these sessions for the store unlock is validated with a
   live test purchase behind the funnel's ?price20test=1 lane BEFORE any
   public flip. */

const READ_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';
const RETURN_URL = 'https://www.sellproducts.ai/?paid20=1&cs={CHECKOUT_SESSION_ID}';
const SKU_NAME = 'AI Store Unlock';
const SKU_DESC = 'One-time unlock of your AI-built dropshipping store. Full store access, supplier connected, ready to launch on Shopify. No subscription.';
const AMOUNT = 2000; // cents

/* Order bump: sold ONLY as an add-on inside this checkout. Owners can claim
   any number of additional stores later with the same email, free. */
const BUMP_NAME = 'Unlimited AI Stores';
const BUMP_DESC = 'Come back anytime, take the quiz again with this email, and the AI builds + unlocks another store — any niche, as many stores as you want, forever. One-time.';
const BUMP_AMOUNT = 3900; // cents
const BUMP_FLAG = 'unlimited_stores';

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

async function createSession(projectId, email, product, bump){
  const params = {
    'mode': 'payment',
    'ui_mode': 'embedded',
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
  if(bump){
    params['line_items[1][quantity]'] = '1';
    params['line_items[1][price_data][currency]'] = 'usd';
    params['line_items[1][price_data][unit_amount]'] = String(BUMP_AMOUNT);
    params['line_items[1][price_data][product_data][name]'] = BUMP_NAME;
    params['line_items[1][price_data][product_data][description]'] = BUMP_DESC;
    params['metadata[bump]'] = BUMP_FLAG;
  }
  if(email) params['customer_email'] = String(email).slice(0, 120);
  return stripe('checkout/sessions', 'POST', params);
}

/* Does this email already own the Unlimited add-on? Returns the paid session
   id if so — the funnel unlocks further stores against it without charging. */
async function findUnlimited(email){
  if(!email) return '';
  try{
    const l = await stripe('checkout/sessions?status=complete&limit=100&customer_details[email]=' +
      encodeURIComponent(String(email).trim().toLowerCase()));
    const hit = ((l && l.data) || []).find(s => s.payment_status === 'paid' &&
      (s.metadata && s.metadata.type) === 'store_unlock20' &&
      (s.metadata && s.metadata.bump) === BUMP_FLAG);
    return hit ? hit.id : '';
  }catch(e){ return ''; }
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
      const s = await createSession('0', '', 'probe');
      return res.status(200).json({ ok:true, session: s.id, has_secret: !!s.client_secret });
    }

    if(q.verify){
      if(!sk) return res.status(200).json({ paid:false, status:'no_keys' });
      const s = await stripe('checkout/sessions/' + encodeURIComponent(String(q.verify).slice(0, 300)));
      const paid = s.payment_status === 'paid' && (s.metadata && s.metadata.type) === 'store_unlock20';
      return res.status(200).json({ paid,
        project_id: (s.metadata && s.metadata.project_id) || '',
        product: (s.metadata && s.metadata.product) || '',
        email: (s.customer_details && s.customer_details.email) || '',
        amount: s.amount_total || 0,
        bump: paid && (s.metadata && s.metadata.bump) === BUMP_FLAG });
    }

    if(req.method !== 'POST') return res.status(405).json({ ok:false });
    if(!sk || !pk) return res.status(200).json({ ok:false, status:'no_keys' });
    const body = await readBody(req);

    const projectId = String(body.project_id || '').replace(/\D/g, '').slice(0, 20);
    if(!projectId) return res.status(400).json({ ok:false, status:'no_project' });
    const email = String(body.email || '');

    // Unlimited owners never pay again: hand back their original paid session
    // so the funnel can unlock this new store against it. Skipped when the
    // request explicitly asks for a checkout anyway (bump toggle repaint).
    if(email && !body.bump){
      const owned = await findUnlimited(email);
      if(owned) return res.status(200).json({ ok:true, unlimited:true, cs: owned });
    }

    const s = await createSession(projectId, email, String(body.product || ''), !!body.bump);
    return res.status(200).json({ ok:true, client_secret: s.client_secret, publishable_key: pk, bump: !!body.bump });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
