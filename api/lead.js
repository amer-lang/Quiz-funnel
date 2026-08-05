/* Sell Products AI — ActiveCampaign bridge.
   Runs server-side so the AC API key never reaches the browser.

   POST {email, stage, cs?}  stage: optin → list 5 · unlocked → list 6 · videoads → list 7
     Syncs the contact into ActiveCampaign and subscribes it to the mapped list.
     Paid stages (unlocked/videoads) require `cs` (a verified PAID session); the
     verified store id is written to the AC custom field %ACTIVATION_LINK% (id 2)
     as the buyer's durable …/?resume=<id> setup link.
   GET  ?actest=<KEY>    Verifies the AC connection and returns the three lists'
                         names so the mapping can be sanity-checked. */

const AC_URL = 'https://sellproducts.api-us1.com';
const AC_KEY = 'd84c8bf84307d5b159099552ae63a16a92af944cac522e0ff3ea8ece4bae99b7350dab92';
const TEST_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';

// Payment verification (same backend the funnel itself uses)
const DS_API = 'https://chat.dropstart.app/api/express';
const DS_KEY = 'ek_c70_42ceb3e0322b33b8fe9f339ded261337f584ed8a75f2918b';

const STAGE_LIST = { optin: 5, unlocked: 6, videoads: 7 };
const ACTIVATION_FIELD_ID = 2; // AC custom field %ACTIVATION_LINK% ("Activation link")

/* AC custom field %ADS_LINK% — the $49 buyer's durable /ads?cs=<order> page.
   Resolved (and auto-created on first use) by perstag, cached per lambda. */
let adsFieldId = null;
async function adsField(){
  if(adsFieldId) return adsFieldId;
  try{
    const r = await ac('/api/3/fields?limit=100');
    const f = ((r.j && r.j.fields) || []).find(x => x.perstag === 'ADS_LINK');
    if(f){ adsFieldId = Number(f.id); return adsFieldId; }
    const c = await ac('/api/3/fields', 'POST', { field: { type: 'text', title: 'Ads link', perstag: 'ADS_LINK', visible: 1 } });
    if(c.ok && c.j.field) adsFieldId = Number(c.j.field.id);
  }catch(e){}
  return adsFieldId;
}
const OK_ORIGINS = /^https:\/\/(www\.)?sellproducts\.ai$/;

/* Paid stages require a Stripe checkout-session id that the payment backend
   confirms as PAID. Presence of return-URL params is NOT proof of payment —
   failed charges can bounce back through the same URLs. */
async function verifyPaid(cs){
  if(!cs || typeof cs !== 'string' || cs.length > 300) return { paid: false, projectId: null };
  try{
    const r = await fetch(DS_API + '/verify-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Express-Key': DS_KEY },
      body: JSON.stringify({ cs })
    });
    const j = await r.json().catch(() => ({}));
    // Also return the verified store id so callers can build the buyer's durable
    // activation link (…/?resume=<id>) straight from the paid session.
    if(j && j.ok && j.paid) return { paid: true, projectId: (j && j.project_id) || null };
  }catch(err){ /* fall through to the Stripe check */ }
  // The $49 image-ads charges live on OUR Stripe account (not the payment
  // backend above) — a Checkout Session (cs_…) from the fallback popup or a
  // PaymentIntent (pi_…) from the one-click charge. Verify directly with
  // Stripe; only PAID + our image_ads_10 metadata counts. Fail CLOSED.
  try{
    const sk = process.env.STRIPE_SECRET_KEY || '';
    if(!sk) return { paid: false, projectId: null };
    const isPi = /^pi_/.test(cs);
    const r2 = await fetch('https://api.stripe.com/v1/' + (isPi ? 'payment_intents/' : 'checkout/sessions/') + encodeURIComponent(cs), {
      headers: { Authorization: 'Bearer ' + sk }
    });
    const s = await r2.json().catch(() => ({}));
    const paidOk = isPi ? s.status === 'succeeded' : s.payment_status === 'paid';
    const ty = (s.metadata && s.metadata.type) || '';
    const paid = r2.ok && paidOk && (ty === 'image_ads_10' || ty === 'store_unlock20');
    return { paid, projectId: (paid && s.metadata && s.metadata.project_id) || null };
  }catch(err){ return { paid: false, projectId: null }; }
}

async function ac(path, method, body){
  const r = await fetch(AC_URL + path, {
    method: method || 'GET',
    headers: { 'Api-Token': AC_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.status >= 200 && r.status < 300, j };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'OPTIONS') return res.status(204).end();

  try{
    if(req.method === 'GET'){
      if((req.query || {}).actest !== TEST_KEY) return res.status(403).json({ error: 'bad key' });
      const out = {};
      for(const [stage, id] of Object.entries(STAGE_LIST)){
        const r = await ac('/api/3/lists/' + id);
        out[stage] = { listId: id, name: r.ok && r.j.list ? r.j.list.name : ('ERROR ' + r.status) };
      }
      if((req.query || {}).backfill === TEST_KEY){
        const q2 = req.query;
        const dry = q2.dry !== '0';
        // Manual mode: ?emails=a@b.com,c@d.com&stage=unlocked|videoads|optin
        // (owner-attested — used when purchases predate event tracking)
        if(q2.emails){
          const CUMUL = { optin: [5], unlocked: [5, 6], videoads: [5, 6, 7] };
          const lists = CUMUL[String(q2.stage || '')];
          if(!lists) return res.status(400).json({ error: 'stage must be optin|unlocked|videoads' });
          const emails = String(q2.emails).split(',').map(s => s.trim().toLowerCase())
            .filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)).slice(0, 100);
          const results = [];
          for(const em of emails){
            if(dry){ results.push({ email: em, lists, dry: true }); continue; }
            const sync = await ac('/api/3/contact/sync', 'POST', { contact: { email: em } });
            const cid = sync.ok && sync.j.contact ? sync.j.contact.id : null;
            const done = [];
            for(const L of lists){
              if(!cid) break;
              const s = await ac('/api/3/contactLists', 'POST', { contactList: { list: L, contact: cid, status: 1 } });
              done.push(L + ':' + (s.ok ? 'ok' : 'fail'));
            }
            results.push({ email: em, contactId: cid, lists: done });
          }
          return res.status(200).json({ ok: true, dry, mode: 'manual', results });
        }
        // Auto mode: read today's verified purchase events, resolve each store's
        // email via the payment backend, subscribe to the cumulative lists.
        const days = Math.min(7, Math.max(1, parseInt(q2.days, 10) || 1));
        const evr = await fetch('https://www.sellproducts.ai/api/collect?key=' + TEST_KEY + '&days=' + days);
        const events = (await evr.json().catch(() => [])) || [];
        const pidsOf = name => [...new Set(events.filter(e => e && e.e === name && e.v && /^\d+$/.test(e.v)).map(e => e.v))];
        const paid1 = pidsOf('paid_1dollar'), paid299 = pidsOf('paid_upsell');
        const found = [];
        for(const pid of new Set([...paid1, ...paid299])){
          const r = await fetch(DS_API + '/status/' + pid, { headers: { 'X-Express-Key': DS_KEY } });
          const j = await r.json().catch(() => ({}));
          const email = (j && (j.email || j.customer_email || j.contact_email || (j.lead && j.lead.email))) || null;
          found.push({ pid, upsell: paid299.includes(pid), email,
            statusKeys: dry ? Object.keys(j || {}) : undefined });
        }
        const results = [];
        if(!dry){
          for(const f of found){
            if(!f.email){ results.push({ pid: f.pid, skipped: 'no email in status' }); continue; }
            const lists = f.upsell ? [5, 6, 7] : [5, 6];
            const bfContact = { email: f.email };
            if(f.pid && /^\d+$/.test(String(f.pid))) bfContact.fieldValues = [{ field: ACTIVATION_FIELD_ID, value: 'https://sellproducts.ai/?resume=' + encodeURIComponent(f.pid) }];
            const sync = await ac('/api/3/contact/sync', 'POST', { contact: bfContact });
            const cid = sync.ok && sync.j.contact ? sync.j.contact.id : null;
            const done = [];
            for(const L of lists){
              if(!cid) break;
              const s = await ac('/api/3/contactLists', 'POST', { contactList: { list: L, contact: cid, status: 1 } });
              done.push(L + ':' + (s.ok ? 'ok' : 'fail'));
            }
            results.push({ pid: f.pid, email: f.email, lists: done });
          }
        }
        return res.status(200).json({ ok: true, dry, mode: 'auto', paid1, paid299, found, results });
      }

      if((req.query || {}).verifytest){
        // key-gated: exercise the payment-verification call with any cs and
        // report the raw outcome — never subscribes anyone.
        const v = await verifyPaid(String(req.query.verifytest === '1' ? (req.query.cs || 'cs_test_bogus') : req.query.verifytest));
        return res.status(200).json({ ok: true, verifiedPaid: v.paid, projectId: v.projectId });
      }
      let wrote = null;
      if((req.query || {}).write === '1'){
        // exercise the REAL write path with a test contact into the opt-in list
        const sync = await ac('/api/3/contact/sync', 'POST', { contact: { email: 'integration-test@sellproducts.ai' } });
        const cid = sync.ok && sync.j.contact ? sync.j.contact.id : null;
        const sub = cid ? await ac('/api/3/contactLists', 'POST', { contactList: { list: STAGE_LIST.optin, contact: cid, status: 1 } }) : { ok: false };
        wrote = { contactId: cid, subscribed: sub.ok };
      }
      return res.status(200).json({ ok: true, lists: out, wrote, adsFieldId: await adsField() });
    }

    if(req.method === 'POST'){
      // Beacons from the funnel carry no Origin sometimes; when one IS present
      // it must be ours (or localhost during testing).
      const origin = req.headers.origin || '';
      if(origin && !OK_ORIGINS.test(origin) && !/^https?:\/\/localhost/.test(origin))
        return res.status(204).end();

      let body = req.body;
      if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = null; } }
      const email = body && String(body.email || '').trim().toLowerCase().slice(0, 120);
      const stage = body && String(body.stage || '');
      const listId = STAGE_LIST[stage];
      if(!listId || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(204).end();

      // Money lists demand a server-verified PAID Stripe session — no cs or a
      // failed/unverifiable charge means no list add, full stop. The verified
      // store id also yields the buyer's durable activation link.
      let activationLink = '';
      if(stage === 'unlocked' || stage === 'videoads'){
        const v = await verifyPaid(body.cs);
        if(!v.paid) return res.status(204).end();
        if(v.projectId) activationLink = 'https://sellproducts.ai/?resume=' + encodeURIComponent(v.projectId);
      }

      // Write the activation link into AC custom field %ACTIVATION_LINK% (id 2) so
      // the partner's emails can send the buyer back to finish store setup at any
      // time. Server-derived from the verified session, so it always matches the
      // store they actually paid for.
      const contact = { email };
      if(activationLink) contact.fieldValues = [{ field: ACTIVATION_FIELD_ID, value: activationLink }];

      // $49 ad-pack buyers: write their delivery page into %ADS_LINK% so the
      // list-7 purchase email can hand them the ads (the thank-you page
      // deliberately stays focused on Shopify setup).
      if(stage === 'videoads' && /^(cs|pi)_/.test(String(body.cs || ''))){
        const fid = await adsField();
        if(fid) contact.fieldValues = (contact.fieldValues || [])
          .concat([{ field: fid, value: 'https://sellproducts.ai/ads?cs=' + encodeURIComponent(String(body.cs)) }]);
      }

      const sync = await ac('/api/3/contact/sync', 'POST', { contact });
      const contactId = sync.ok && sync.j.contact ? sync.j.contact.id : null;
      if(!contactId) return res.status(502).json({ error: 'ac sync failed' });

      const sub = await ac('/api/3/contactLists', 'POST', {
        contactList: { list: listId, contact: contactId, status: 1 }
      });
      if(!sub.ok) return res.status(502).json({ error: 'ac list subscribe failed' });

      return res.status(204).end();
    }

    return res.status(405).json({ error: 'method' });
  }catch(err){
    return res.status(500).json({ error: 'lead bridge error' });
  }
};
