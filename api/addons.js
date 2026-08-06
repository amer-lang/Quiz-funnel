/* Sell Products AI — launch-sequence add-on charges.
   Vercel serverless function at /api/addons. Charges on OUR Stripe account,
   one-click on the card saved by the $20 unlock (same rail as upsell49).

   POST {cs, items:[...]} — items from the fixed PRICE map below. Verifies the
        base $20 session is PAID, skips anything this buyer already bought,
        and charges the remaining items as ONE PaymentIntent. Responses:
          {ok:true, charged:true, pi, amount, items:[...]}   — charged now
          {ok:true, charged:false, already:true}             — nothing new owed
          {ok:false, status:'declined'|...}                  — card refused; caller
                                                               continues the flow.
   Unlimited-stores purchases stamp metadata.unlimited='1' so the funnel's
   free-reclaim lookup (unlock20 findUnlimited) recognizes them. */

const PRICES = {
  seo_boost:        2900,
  unlimited_stores: 3900,
  profit_emails:    2900,
  video_ad_1:       3900
};
const NAMES = {
  seo_boost:        'SEO Boost',
  unlimited_stores: 'Unlimited AI Stores',
  profit_emails:    '10 Profit Emails',
  video_ad_1:       'Custom Video Ad'
};

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
  if(req.method !== 'POST') return res.status(405).json({ ok:false });
  const { sk } = keys();
  if(!sk) return res.status(200).json({ ok:false, status:'no_keys' });

  try{
    const body = await readBody(req);
    const cs = String(body.cs || '').slice(0, 300);
    const wanted = Array.isArray(body.items)
      ? [...new Set(body.items.map(String))].filter(i => PRICES[i]) : [];
    if(!cs || !wanted.length) return res.status(400).json({ ok:false, status:'bad_request' });

    const base = await stripe('checkout/sessions/' + encodeURIComponent(cs));
    if(base.payment_status !== 'paid' || (base.metadata && base.metadata.type) !== 'store_unlock20')
      return res.status(200).json({ ok:false, status:'base_not_paid' });
    const customer = typeof base.customer === 'string' ? base.customer : '';
    if(!customer) return res.status(200).json({ ok:false, status:'no_customer' });
    const email = ((base.customer_details && base.customer_details.email) || '').toLowerCase();

    /* skip items this buyer already owns (any prior succeeded addon/legacy PI) */
    const owned = new Set();
    try{
      const prev = await stripe('payment_intents?customer=' + customer + '&limit=50');
      for(const p of ((prev && prev.data) || [])){
        if(p.status !== 'succeeded' || !p.metadata) continue;
        if(p.metadata.type === 'store_addons' && p.metadata.items)
          p.metadata.items.split(',').forEach(i => owned.add(i.trim()));
        if(p.metadata.type === 'store_bump_unlimited') owned.add('unlimited_stores');
        if(p.metadata.type === 'image_ads_10') owned.add('image_ads_10');
      }
    }catch(e){}
    const items = wanted.filter(i => !owned.has(i));
    if(!items.length) return res.status(200).json({ ok:true, charged:false, already:true });

    const amount = items.reduce((s, i) => s + PRICES[i], 0);
    const pm = await defaultPm(customer);
    if(!pm) return res.status(200).json({ ok:false, status:'no_pm' });

    const params = {
      amount: String(amount), currency: 'usd', customer, payment_method: pm,
      off_session: 'true', confirm: 'true',
      description: items.map(i => NAMES[i]).join(' + '),
      'metadata[type]': 'store_addons',
      'metadata[items]': items.join(','),
      'metadata[base_cs]': cs,
      'metadata[email]': email,
      'metadata[project_id]': (base.metadata && base.metadata.project_id) || ''
    };
    if(items.includes('unlimited_stores')) params['metadata[unlimited]'] = '1';

    try{
      const pi = await stripe('payment_intents', 'POST', params,
        'addons-' + cs + '-' + items.slice().sort().join('.'));
      if(pi.status === 'succeeded')
        return res.status(200).json({ ok:true, charged:true, pi: pi.id, amount, items });
      return res.status(200).json({ ok:false, status:'not_succeeded' });
    }catch(e){
      return res.status(200).json({ ok:false, status:'declined', detail: String(e && e.message || e).slice(0, 200) });
    }
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
