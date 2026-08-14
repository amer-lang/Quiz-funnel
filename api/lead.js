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
const TEST_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';

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
/* AC custom field %EMAILS_LINK% — the email-pack buyer's durable
   /emails?cs=<order> delivery page. Auto-created on first use by perstag. */
let emailsFieldId = null;
async function emailsField(){
  if(emailsFieldId) return emailsFieldId;
  try{
    const r = await ac('/api/3/fields?limit=100');
    const f = ((r.j && r.j.fields) || []).find(x => x.perstag === 'EMAILS_LINK');
    if(f){ emailsFieldId = Number(f.id); return emailsFieldId; }
    const c = await ac('/api/3/fields', 'POST', { field: { type: 'text', title: 'Emails link', perstag: 'EMAILS_LINK', visible: 1 } });
    if(c.ok && c.j.field) emailsFieldId = Number(c.j.field.id);
  }catch(e){}
  return emailsFieldId;
}

/* "SPAI Email Pack" list — email-pack buyers land here so an automation can
   send them their delivery link. Resolved by name; auto-created if missing. */
let emailsListId = null;
async function emailsList(){
  if(emailsListId) return emailsListId;
  try{
    const r = await ac('/api/3/lists?limit=100');
    const l = ((r.j && r.j.lists) || []).find(x =>
      String(x.name || '').trim().toLowerCase() === 'spai email pack');
    if(l){ emailsListId = Number(l.id); return emailsListId; }
    const c = await ac('/api/3/lists', 'POST', { list: {
      name: 'SPAI Email Pack', stringid: 'spai-email-pack',
      sender_url: 'https://sellproducts.ai',
      sender_reminder: 'You purchased the 10 Profit Emails pack on sellproducts.ai.'
    } });
    if(c.ok && c.j.list) emailsListId = Number(c.j.list.id);
  }catch(e){}
  return emailsListId;
}

/* "SPAI Subscribers" — the master buyers list. Resolved by NAME once per
   lambda (case-insensitive) so the mapping can't drift if list ids change.
   Every verified $20 unlock is subscribed here in addition to list 6. */
let spaiListId = null;
async function spaiList(){
  if(spaiListId) return spaiListId;
  try{
    const r = await ac('/api/3/lists?limit=100');
    const l = ((r.j && r.j.lists) || []).find(x =>
      /^spai subscribers?$/.test(String(x.name || '').trim().toLowerCase()));
    if(l) spaiListId = Number(l.id);
  }catch(e){}
  return spaiListId;
}

const OK_ORIGINS = /^https:\/\/(www\.)?sellproducts\.ai$/;

/* Paid stages require a Stripe checkout-session id that the payment backend
   confirms as PAID. Presence of return-URL params is NOT proof of payment —
   failed charges can bounce back through the same URLs. */
async function verifyPaid(cs){
  if(!cs || typeof cs !== 'string' || cs.length > 300) return { paid: false, projectId: null, type: '', items: '' };
  // STRIPE FIRST. All current charges live on our account and carry
  // metadata.type — and type-gated logic (ADS_LINK, EMAILS_LINK) depends on
  // it. The old DS-first order caused a silent regression: DS answers "paid"
  // for our ids too (shared Stripe account) but returns NO type, so the
  // ads-link write was skipped while the list subscribe went through —
  // delivery emails with an empty %ADS_LINK%. TG12147.
  try{
    const sk = process.env.STRIPE_SECRET_KEY || '';
    if(sk){
      const isPi = /^pi_/.test(cs);
      const r2 = await fetch('https://api.stripe.com/v1/' + (isPi ? 'payment_intents/' : 'checkout/sessions/') + encodeURIComponent(cs), {
        headers: { Authorization: 'Bearer ' + sk }
      });
      const s = await r2.json().catch(() => ({}));
      const paidOk = isPi ? s.status === 'succeeded' : s.payment_status === 'paid';
      const ty = (s.metadata && s.metadata.type) || '';
      if(r2.ok && paidOk &&
         (ty === 'image_ads_10' || ty === 'store_unlock20' || ty === 'video_ads_5' || ty === 'store_addons')){
        return { paid: true, projectId: (s.metadata && s.metadata.project_id) || null,
          type: ty, items: (s.metadata && s.metadata.items) || '' };
      }
    }
  }catch(err){ /* fall through to the DS check */ }
  // Fallback: DropStart-created sessions (legacy $1/$299 flows) — DS knows
  // their paid state but not our SKU types, so type stays empty here.
  try{
    const r = await fetch(DS_API + '/verify-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Express-Key': DS_KEY },
      body: JSON.stringify({ cs })
    });
    const j = await r.json().catch(() => ({}));
    if(j && j.ok && j.paid) return { paid: true, projectId: (j && j.project_id) || null, type: '', items: '' };
  }catch(err){}
  return { paid: false, projectId: null, type: '', items: '' };
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
      const sid = await spaiList();
      out.spai_subscribers = sid ? { listId: sid, note: sid === STAGE_LIST.unlocked ? 'same list the unlocked stage already subscribes — no double-add' : 'separate list, added on unlock' } : 'NOT FOUND — check the list name in AC';
      // provision the email-pack delivery plumbing on demand (idempotent):
      // creates the %EMAILS_LINK% field and the SPAI Email Pack list if missing
      const efid = await emailsField();
      const elid = await emailsList();
      out.email_pack = {
        emailsFieldId: efid || 'CREATE FAILED',
        list: elid ? { listId: elid, name: 'SPAI Email Pack' } : 'CREATE FAILED — make it manually in AC with this exact name'
      };
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

      if((req.query || {}).emailsweep){
        // key-gated safety net: scan recent Stripe charges for profit_emails
        // purchases and (re)stamp %EMAILS_LINK% + SPAI Email Pack for each —
        // catches pre-feature buyers and any browser-side misses. Idempotent.
        if(req.query.emailsweep !== TEST_KEY) return res.status(403).json({ error: 'bad key' });
        const sk = process.env.STRIPE_SECRET_KEY || '';
        if(!sk) return res.status(200).json({ ok:false, status:'no_stripe_key' });
        const r = await fetch('https://api.stripe.com/v1/payment_intents?limit=100', {
          headers: { Authorization: 'Bearer ' + sk } });
        const j = await r.json().catch(() => ({}));
        const buyers = ((j && j.data) || []).filter(p => p.status === 'succeeded' &&
          p.metadata && p.metadata.type === 'store_addons' &&
          String(p.metadata.items || '').split(',').map(s => s.trim()).includes('profit_emails'));
        const fid = await emailsField();
        const lid = await emailsList();
        const done = [];
        for(const p of buyers){
          const em = String(p.metadata.email || '').toLowerCase();
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)){ done.push({ pi: p.id, status: 'no_email' }); continue; }
          const contact = { email: em };
          if(fid) contact.fieldValues = [{ field: fid,
            value: 'https://sellproducts.ai/emails?cs=' + encodeURIComponent(p.id) }];
          const sync = await ac('/api/3/contact/sync', 'POST', { contact });
          const cid = sync.ok && sync.j.contact ? sync.j.contact.id : null;
          if(cid && lid) await ac('/api/3/contactLists', 'POST', { contactList: { list: lid, contact: cid, status: 1 } });
          done.push({ pi: p.id, email: em.replace(/^(..).*(@.*)$/, '$1***$2'), stamped: !!(cid && fid), listed: !!(cid && lid) });
        }
        return res.status(200).json({ ok:true, found: buyers.length, processed: done });
      }

      if((req.query || {}).adsweep){
        // key-gated safety net: scan Stripe for $49 image-ads purchases —
        // BOTH shapes: one-click PaymentIntents (metadata on the PI) and
        // embedded-fallback Checkout Sessions (metadata on the session) —
        // and (re)stamp %ADS_LINK% + list 7 for each. Idempotent; contacts
        // already on the list are not re-triggered.
        if(req.query.adsweep !== TEST_KEY) return res.status(403).json({ error: 'bad key' });
        const sk = process.env.STRIPE_SECRET_KEY || '';
        if(!sk) return res.status(200).json({ ok:false, status:'no_stripe_key' });
        const sget = p => fetch('https://api.stripe.com/v1/' + p, { headers: { Authorization: 'Bearer ' + sk } })
          .then(r => r.json()).catch(() => ({}));
        const [pis, sessions] = await Promise.all([
          sget('payment_intents?limit=100'), sget('checkout/sessions?limit=100')
        ]);
        const orders = [];
        for(const p of ((pis && pis.data) || [])){
          if(p.status !== 'succeeded' || !p.metadata || p.metadata.type !== 'image_ads_10') continue;
          let em = '';
          if(typeof p.customer === 'string'){
            const c = await sget('customers/' + p.customer);
            em = String((c && c.email) || '').toLowerCase();
          }
          orders.push({ id: p.id, email: em });
        }
        for(const s of ((sessions && sessions.data) || [])){
          if(s.payment_status !== 'paid' || !s.metadata || s.metadata.type !== 'image_ads_10') continue;
          orders.push({ id: s.id, email: String((s.customer_details && s.customer_details.email) || '').toLowerCase() });
        }
        const fid2 = await adsField();
        const done = [];
        for(const o of orders){
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)){ done.push({ order: o.id, status: 'no_email' }); continue; }
          const contact = { email: o.email };
          if(fid2) contact.fieldValues = [{ field: fid2,
            value: 'https://sellproducts.ai/ads?cs=' + encodeURIComponent(o.id) }];
          const sync = await ac('/api/3/contact/sync', 'POST', { contact });
          const cid = sync.ok && sync.j.contact ? sync.j.contact.id : null;
          if(cid) await ac('/api/3/contactLists', 'POST', { contactList: { list: STAGE_LIST.videoads, contact: cid, status: 1 } });
          done.push({ order: o.id, email: o.email.replace(/^(..).*(@.*)$/, '$1***$2'), stamped: !!(cid && fid2), listed: !!cid });
        }
        return res.status(200).json({ ok:true, found: orders.length, processed: done });
      }

      if((req.query || {}).dsraw){
        // key-gated: hit DropStart /verify-checkout DIRECTLY and return its raw
        // verdict — tells us whether DS verifies sessions it didn't create.
        if(req.query.dsraw !== TEST_KEY) return res.status(403).json({ error: 'bad key' });
        const cs = String(req.query.cs || '').slice(0, 300);
        const r = await fetch(DS_API + '/verify-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Express-Key': DS_KEY },
          body: JSON.stringify({ cs })
        });
        const j = await r.json().catch(() => ({}));
        return res.status(200).json({ ok: true, dsStatus: r.status, dsResponse: j });
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
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(204).end();

      /* Email-pack fulfillment: verified profit_emails buyers get their
         durable /emails delivery link stamped into %EMAILS_LINK% and land on
         the "SPAI Email Pack" list, whose automation emails them the link. */
      if(stage === 'emails'){
        const v = await verifyPaid(body.cs);
        if(!v.paid || v.type !== 'store_addons' ||
           !String(v.items).split(',').map(s2 => s2.trim()).includes('profit_emails'))
          return res.status(204).end();
        const fid = await emailsField();
        const contact2 = { email };
        if(fid) contact2.fieldValues = [{ field: fid,
          value: 'https://sellproducts.ai/emails?cs=' + encodeURIComponent(String(body.cs)) }];
        const sync2 = await ac('/api/3/contact/sync', 'POST', { contact: contact2 });
        const cid2 = sync2.ok && sync2.j.contact ? sync2.j.contact.id : null;
        if(!cid2) return res.status(502).json({ error: 'ac sync failed' });
        const lid = await emailsList();
        if(lid) await ac('/api/3/contactLists', 'POST', { contactList: { list: lid, contact: cid2, status: 1 } });
        return res.status(204).end();
      }

      const listId = STAGE_LIST[stage];
      if(!listId) return res.status(204).end();

      // Money lists demand a server-verified PAID Stripe session — no cs or a
      // failed/unverifiable charge means no list add, full stop. The verified
      // store id also yields the buyer's durable activation link.
      let activationLink = '', paidType = '';
      if(stage === 'unlocked' || stage === 'videoads'){
        const v = await verifyPaid(body.cs);
        if(!v.paid) return res.status(204).end();
        paidType = v.type || '';
        if(v.projectId) activationLink = 'https://sellproducts.ai/?resume=' + encodeURIComponent(v.projectId);
      }

      // Write the activation link into AC custom field %ACTIVATION_LINK% (id 2) so
      // the partner's emails can send the buyer back to finish store setup at any
      // time. Server-derived from the verified session, so it always matches the
      // store they actually paid for.
      const contact = { email };
      if(activationLink) contact.fieldValues = [{ field: ACTIVATION_FIELD_ID, value: activationLink }];

      // $49 image-pack buyers ONLY: write their delivery page into %ADS_LINK%
      // so the list-7 purchase email can hand them the ads. $299 video buyers
      // must NOT get this link — /ads renders image packs, not videos.
      if(stage === 'videoads' && paidType === 'image_ads_10' && /^(cs|pi)_/.test(String(body.cs || ''))){
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

      // $20 buyers also join the master "SPAI Subscribers" list. Best-effort:
      // a hiccup here never fails the request (the stage list already took).
      if(stage === 'unlocked'){
        try{
          const sid = await spaiList();
          if(sid && sid !== listId)
            await ac('/api/3/contactLists', 'POST', { contactList: { list: sid, contact: contactId, status: 1 } });
        }catch(e){}
      }

      return res.status(204).end();
    }

    return res.status(405).json({ error: 'method' });
  }catch(err){
    return res.status(500).json({ error: 'lead bridge error' });
  }
};
