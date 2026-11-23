/* Sell Products AI — hire AI Employees (/api/hire).
   Modelled on /api/addons: charges OUR Stripe account, one click, on the card saved by the $20
   unlock; then tells DropStart to start the employee(s) (lib/employees.js).

   GET           → { ok, hiring_open, simulated, roles:[{id,label,blurb,price_cents|null}] }  (what the hire screen shows)
   POST {roles:[...]}  → hires the roles the buyer does not already have:
        { ok:true, charged:true, recorded:true, amount, roles }   charged now (production)
        { ok:true, simulated:true, ... }                          preview deployment: NOTHING is charged
        { ok:true, already:true }                                 nothing new owed
        { ok:false, error:'declined'|'no_pm'|'base_not_paid'|'pricing_not_set'|'hiring_closed'|'pending_record'|... }

   Safety:
   - In a non-production deployment no Stripe call is ever made (simulated hire only).
   - In production it only charges when EMPLOYEES_HIRING=on AND every wanted role has a price
     (EMPLOYEES_PRICE_<ROLE>_CENTS) AND a Stripe Tax code is configured (EMPLOYEES_TAX_CODE, "txcd_xxxxxxxx", assigned
     by the sales-tax specialist like the other products in lib/tax.js).
   - The buyer comes from their login (cookie), never from the request body; POSTs must be same-origin JSON.
   - STRIPE is the source of truth for "already paid": before charging we read the customer's succeeded ai_employees
     payments, so a hire that was paid but never recorded is recovered instead of being charged again.
   - A paid hire is written to a private blob BEFORE DropStart is told, and retried on the buyer's next visit; while one
     is unresolved no new charge is made. */

const { taxCode, ROLES, isRole, isProd, hiringOpen, priceCents, identify, ours, readBody, available, sameOriginJson, bread, bwrite, pendingPath, recordHire, retryPending } = require('../lib/employees');
const tax = require('../lib/tax');

async function stripe(path, method, params, idemKey){
  const opts = { method: method || 'GET', headers: { Authorization: 'Bearer ' + (process.env.STRIPE_SECRET_KEY || '') } };
  if(idemKey) opts.headers['Idempotency-Key'] = idemKey;
  if(params){ opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params).toString(); }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try{
    const r = await fetch('https://api.stripe.com/v1/' + path, Object.assign({ signal: ctl.signal }, opts));
    const j = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
    return j;
  } finally { clearTimeout(t); }
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if(!available()) return res.status(404).json({ ok:false, error:'not_available' });
  if(req.method === 'OPTIONS') return res.status(204).end();

  if(req.method === 'GET'){
    /* preview deployments only: is the DropStart side wired? (a boolean and an upstream status, never a key) */
    if(!isProd() && req.query && req.query.probe === '1'){
      const up = await ours('office', { cs: 'cs_probe_' + Date.now(), timeout: 8000 });
      return res.status(200).json({ ok:true, upstream_key: !!process.env.EMPLOYEES_API_KEY, upstream_status: up.status, upstream_error: up.json && up.json.error || null });
    }
    return res.status(200).json({
      ok: true,
      /* the funnel offers the team only when a hire can actually go through: hiring open AND the DropStart side wired */
      funnel_ready: hiringOpen() && !!process.env.EMPLOYEES_API_KEY,
      hiring_open: !isProd() || hiringOpen(),
      simulated: !isProd(),
      roles: Object.keys(ROLES).map(id => ({ id, label: ROLES[id].label, blurb: ROLES[id].blurb, price_cents: priceCents(id) }))
    });
  }
  if(req.method !== 'POST') return res.status(405).json({ ok:false });
  if(!sameOriginJson(req)) return res.status(403).json({ ok:false, error:'forbidden' });

  try{
    const body = await readBody(req);
    let who = await identify(req);
    /* the funnel, seconds after the $20: the buyer sends the order id Stripe handed back. The order is proven below
       (DropStart knows it, and in production Stripe says it is a PAID store_unlock20) before anything is charged. */
    if(!who && /^cs_[A-Za-z0-9_]{3,200}$/.test(String(body.cs || ''))) who = { cs: String(body.cs), via: 'funnel' };
    if(!who) return res.status(401).json({ ok:false, error:'login_required' });
    const cs = who.cs;
    const attempt = String(body.attempt || '').replace(/[^a-z0-9]/gi, '').slice(0, 24); // per click: a retry after a decline is a new request, not an idempotent replay

    /* ---- step 2 of the in-person confirmation: the buyer confirmed the on-session PaymentIntent in the browser.
       Stripe is checked directly (status, type, order); then the tax transaction is recorded and the hire is sent on. */
    if(typeof body.confirm_pi === 'string' && /^pi_[A-Za-z0-9]+$/.test(body.confirm_pi)){
      if(!isProd()) return res.status(200).json({ ok:true, simulated:true, charged:false, confirmed:true });
      if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no_keys' });
      let pi;
      try{ pi = await stripe('payment_intents/' + encodeURIComponent(body.confirm_pi)); }catch(e){ return res.status(200).json({ ok:false, error:'unavailable' }); }
      const md = (pi && pi.metadata) || {};
      if(!pi || pi.status !== 'succeeded' || md.type !== 'ai_employees' || md.base_cs !== cs) return res.status(200).json({ ok:false, error:'not_paid' });
      const roles = String(md.roles || '').split(',').map(s => s.trim()).filter(isRole);
      if(md.tax_calculation && !md.tax_transaction) await tax.record(process.env.STRIPE_SECRET_KEY, pi, { id: md.tax_calculation });
      const item = { ref: pi.id, roles, amount: pi.amount };
      const rec = (await bread(pendingPath(cs))) || { items: [] };
      const items = (rec.items || []).filter(i => i.ref !== pi.id).concat([item]);
      await bwrite(pendingPath(cs), { items, at: Date.now() }).catch(() => {});
      const recorded = await recordHire(cs, roles, pi.amount, pi.id);
      if(recorded) await bwrite(pendingPath(cs), { items: items.filter(i => i.ref !== pi.id), at: Date.now() }).catch(() => {});
      return res.status(200).json({ ok:true, charged:true, confirmed:true, recorded, amount: pi.amount, roles });
    }

    const wanted = Array.isArray(body.roles) ? [...new Set(body.roles.filter(r => typeof r === 'string'))].filter(isRole) : [];
    if(!wanted.length) return res.status(400).json({ ok:false, error:'bad_request' });

    /* what does this buyer already have? (also proves the order is a real, eligible purchase) */
    const state = await ours('office', { cs, timeout: 8000 });
    if(state.status === 404) return res.status(200).json({ ok:false, error:'not_eligible' });
    if(!state.json || state.json.ok !== true) return res.status(200).json({ ok:false, error:'unavailable' });
    const have = new Set((state.json.hires || []).filter(h => h.hire_status !== 'ended').map(h => h.role));

    /* ---- preview: simulate, never charge, never touch Stripe or the pending blob ---- */
    if(!isProd()){
      const roles = wanted.filter(r => !have.has(r));
      if(!roles.length) return res.status(200).json({ ok:true, already:true });
      const ref = 'preview-' + cs + '-' + roles.slice().sort().join('.');
      const ok = await recordHire(cs, roles, 0, ref);
      return res.status(200).json({ ok, simulated:true, charged:false, recorded:ok, roles, error: ok ? undefined : 'record_failed' });
    }

    /* ---- production ---- */
    if(!hiringOpen()) return res.status(200).json({ ok:false, error:'hiring_closed' });
    if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no_keys' });
    if(await retryPending(cs) > 0) return res.status(200).json({ ok:false, error:'pending_record' }); // an earlier paid hire is still being recorded: no new charge

    const base = await stripe('checkout/sessions/' + encodeURIComponent(cs));
    if(base.payment_status !== 'paid' || (base.metadata && base.metadata.type) !== 'store_unlock20')
      return res.status(200).json({ ok:false, error:'base_not_paid' });
    const customer = typeof base.customer === 'string' ? base.customer : '';
    if(!customer) return res.status(200).json({ ok:false, error:'no_customer' });

    /* Stripe is the source of truth: roles already PAID (succeeded ai_employees payments) are never charged again; any that
       DropStart does not know about yet are recorded now (recovery of a paid-but-unrecorded hire). */
    const paid = new Set();
    const unrecorded = [];
    try{
      const prev = await stripe('payment_intents?customer=' + customer + '&limit=50');
      for(const p of ((prev && prev.data) || [])){
        if(p.status !== 'succeeded' || !p.metadata || p.metadata.type !== 'ai_employees' || p.metadata.base_cs !== cs) continue;
        const rs = String(p.metadata.roles || '').split(',').map(s => s.trim()).filter(isRole);
        rs.forEach(r => paid.add(r));
        if(rs.some(r => !have.has(r))) unrecorded.push({ ref: p.id, roles: rs.filter(r => !have.has(r)), amount: p.amount });
      }
    }catch(e){ return res.status(200).json({ ok:false, error:'unavailable' }); } // cannot prove what is already paid: do not charge
    for(const u of unrecorded){
      if(!(await recordHire(cs, u.roles, u.amount, u.ref))){
        const rec = (await bread(pendingPath(cs))) || { items: [] };
        rec.items = (rec.items || []).filter(i => i.ref !== u.ref).concat([u]);
        await bwrite(pendingPath(cs), { items: rec.items, at: Date.now() }).catch(() => {});
        return res.status(200).json({ ok:false, error:'pending_record' });
      }
    }
    const roles = wanted.filter(r => !have.has(r) && !paid.has(r));
    if(!roles.length) return res.status(200).json({ ok:true, already:true, recovered: unrecorded.length > 0 });

    const prices = roles.map(r => priceCents(r));
    if(prices.some(p => !p)) return res.status(200).json({ ok:false, error:'pricing_not_set' });
    tax.CODES.ai_employee = taxCode();

    const pm = await defaultPm(customer);
    if(!pm) return res.status(200).json({ ok:false, error:'no_pm' });

    const amount = prices.reduce((s, p) => s + p, 0);
    const params = {
      amount: String(amount), currency: 'usd', customer, payment_method: pm, off_session: 'true', confirm: 'true',
      description: roles.map(r => ROLES[r].label).join(' + '),
      'metadata[type]': 'ai_employees', 'metadata[roles]': roles.join(','), 'metadata[base_cs]': cs,
      'metadata[email]': ((base.customer_details && base.customer_details.email) || '').toLowerCase(),
      'metadata[project_id]': (base.metadata && base.metadata.project_id) || ''
    };
    let pi;
    const idem = 'hire-' + cs + '-' + roles.slice().sort().join('.') + (attempt ? '-' + attempt : '');
    const taxItems = roles.map((r, i) => ({ key: 'ai_employee', amount: prices[i] }));
    try{
      pi = await tax.charge(process.env.STRIPE_SECRET_KEY, params, idem, taxItems, base.customer_details && base.customer_details.address, tax.clientIp(req));
    }catch(e){
      const m = String(e && e.message || e);
      if(/idempoten/i.test(m)) return res.status(200).json({ ok:false, error:'try_again_later' }); // same request seen within 24h with different details
      /* Declined silently (most often the bank wants the cardholder present). Hand the browser an on-session
         PaymentIntent for the same amount and metadata: the buyer confirms the saved card in person, which
         completes 3-D Secure when asked, or enters another card. Step 2 above records it. */
      try{
        const onParams = Object.assign({}, params);
        delete onParams.payment_method; delete onParams.off_session; delete onParams.confirm;
        onParams['automatic_payment_methods[enabled]'] = 'true';
        onParams['automatic_payment_methods[allow_redirects]'] = 'never';
        onParams['setup_future_usage'] = 'off_session';
        onParams['metadata[confirm_flow]'] = 'on_session';
        onParams['metadata[declined_detail]'] = m.slice(0, 120);
        const intent = await tax.charge(process.env.STRIPE_SECRET_KEY, onParams, idem + '-confirm', taxItems, base.customer_details && base.customer_details.address, tax.clientIp(req));
        let card = null;
        try{ const pmo = await stripe('payment_methods/' + encodeURIComponent(pm)); card = pmo && pmo.card ? { brand: pmo.card.brand || '', last4: pmo.card.last4 || '' } : (pmo && pmo.type === 'link' ? { brand: 'link', last4: '' } : null); }catch(e2){}
        return res.status(200).json({ ok:false, status:'confirm', error:'declined', detail: m.slice(0, 200),
          client_secret: intent.client_secret, pi: intent.id, pm, card, amount, publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '' });
      }catch(e3){
        return res.status(200).json({ ok:false, error:'declined', detail: m.slice(0, 200) });
      }
    }
    if(!pi || pi.status !== 'succeeded') return res.status(200).json({ ok:false, error:'not_succeeded' });

    /* PAID. Write the hire to the private blob first, so nothing can lose it, then tell DropStart. */
    const item = { ref: pi.id, roles, amount };
    const rec = (await bread(pendingPath(cs))) || { items: [] };
    const items = (rec.items || []).filter(i => i.ref !== pi.id).concat([item]);
    await bwrite(pendingPath(cs), { items, at: Date.now() }).catch(() => {});
    const recorded = await recordHire(cs, roles, amount, pi.id);
    if(recorded) await bwrite(pendingPath(cs), { items: items.filter(i => i.ref !== pi.id), at: Date.now() }).catch(() => {});
    return res.status(200).json({ ok:true, charged:true, recorded, amount, roles });
  }catch(e){
    return res.status(200).json({ ok:false, error:'error' });
  }
};
