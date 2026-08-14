/* Sell Products AI — one-time ActiveCampaign fulfillment setup for the $49
   ad-pack upsell. Key-gated admin tool, safe to leave deployed.

   The funnel already: verifies the $49 charge server-side → subscribes the
   buyer to list 7 ("SPAI Video Ad") → writes their personal delivery page
   into custom field %ADS_LINK% (/api/lead.js). This endpoint creates the
   missing piece: an auto-responder campaign on list 7 that instantly emails
   the buyer their %ADS_LINK% — hands-free fulfillment.

   GET ?key=<READ_KEY>              — status: does the fulfillment campaign exist?
   GET ?key=<READ_KEY>&do=create    — create message + responder (idempotent by name)
   GET ?key=<READ_KEY>&do=test&email=<addr>
                                    — end-to-end test: set a dummy %ADS_LINK% on
                                      that contact and subscribe it to list 7 so
                                      the responder fires a real email

   Uses AC's legacy v1 API (the only API that can create campaigns). */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const AC_URL = 'https://sellproducts.api-us1.com';
const AC_KEY = 'd84c8bf84307d5b159099552ae63a16a92af944cac522e0ff3ea8ece4bae99b7350dab92';
const LIST_ID = 7;
const ADS_FIELD_ID = 3; // %ADS_LINK% (created by /api/lead.js)
const CAMPAIGN_NAME = 'SPAI $49 Ad Pack Fulfillment (auto)';
const FROM_EMAIL = 'support@sellproducts.ai';
const FROM_NAME = 'Sell Products AI';
const SUBJECT = '🎨 Your 10 custom image ads are here';

const EMAIL_HTML = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F4F6FA;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">Your ad pack is being designed right now — open it to watch your 10 ads appear.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:28px 12px">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E5EAF3">
  <tr><td style="background:#0A1020;padding:22px 32px">
    <span style="font-size:18px;font-weight:bold;color:#ffffff">Sell Products</span>
    <span style="font-size:11px;font-weight:bold;color:#0A1020;background:#FFC93C;border-radius:5px;padding:2px 7px;margin-left:4px">AI</span>
  </td></tr>
  <tr><td style="padding:34px 32px 10px">
    <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#0A1020">Your 10 custom image ads are being designed right now 🎨</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3D4B63">
      Thanks for grabbing the <b>10-Ad Pack</b>! Our AI is designing every ad
      around the exact product you picked — square ads for Facebook &amp;
      Instagram feeds, tall ones for Stories &amp; Reels.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center" style="padding:8px 0 6px">
      <a href="%ADS_LINK%" style="display:inline-block;background:#FFC93C;color:#0A1020;font-size:16px;font-weight:bold;text-decoration:none;padding:15px 38px;border-radius:12px">Open My 10 Ads →</a>
    </td></tr></table>
    <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#7A8699;text-align:center">
      The page fills in live — the full pack takes a few minutes the first
      time you open it. <b>Your link never expires</b>, so you can come back
      and re-download your ads anytime.
    </p>
  </td></tr>
  <tr><td style="padding:22px 32px 6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F8FF;border-radius:12px"><tr><td style="padding:16px 20px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#0A1020">🚀 Quick-start tips</p>
      <p style="margin:0;font-size:13px;line-height:1.7;color:#3D4B63">
        • Download each ad with the button under it<br>
        • Run 2–3 ads at once with a small daily budget and let the best one win<br>
        • Square = feed placements · Tall = Stories &amp; Reels
      </p>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:20px 32px 30px">
    <p style="margin:0;font-size:13px;line-height:1.6;color:#7A8699">
      Questions or trouble opening your ads? Just reply, or email
      <a href="mailto:support@sellproducts.ai" style="color:#2563EB">support@sellproducts.ai</a>
      — we answer every message.
    </p>
  </td></tr>
</table>
<p style="font-size:11px;color:#9AA5B5;margin:18px 0 0;line-height:1.6">%SENDER-INFO-SINGLELINE%<br><a href="%UNSUBSCRIBELINK%" style="color:#9AA5B5">Unsubscribe</a></p>
</td></tr>
</table>
</body></html>`;

const EMAIL_TEXT = [
  'Your 10 custom image ads are being designed right now!',
  '',
  'Thanks for grabbing the 10-Ad Pack. Our AI is designing every ad around',
  'the exact product you picked - square ads for Facebook & Instagram feeds,',
  'tall ones for Stories & Reels.',
  '',
  'Open your ads here: %ADS_LINK%',
  '',
  'The page fills in live - the full pack takes a few minutes the first time',
  'you open it. Your link never expires.',
  '',
  'Questions? Email support@sellproducts.ai',
  '',
  '%SENDER-INFO-SINGLELINE%',
  'Unsubscribe: %UNSUBSCRIBELINK%'
].join('\n');

/* legacy v1 API call: action in the query string, data form-encoded */
async function v1(action, data){
  const r = await fetch(AC_URL + '/admin/api.php?api_action=' + action +
      '&api_key=' + AC_KEY + '&api_output=json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data || {}).toString()
  });
  const t = await r.text();
  try{ return JSON.parse(t); }catch(e){ return { raw: t.slice(0, 400), http: r.status }; }
}

/* v3 API (same one lead.js uses) for the test-contact leg */
async function v3(path, method, body){
  const r = await fetch(AC_URL + path, {
    method: method || 'GET',
    headers: { 'Api-Token': AC_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

async function findCampaign(){
  const l = await v1('campaign_list', { ids: 'all', full: 0 });
  for(const k of Object.keys(l || {})){
    const c = l[k];
    if(c && typeof c === 'object' && c.name === CAMPAIGN_NAME)
      return { id: c.id, status: c.status, type: c.type, sendamt: c.send_amt };
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if(q.key !== READ_KEY) return res.status(403).json({ ok:false });

  try{
    if(q.do === 'create'){
      const existing = await findCampaign();
      if(existing) return res.status(200).json({ ok:true, already:true, campaign: existing });

      const pd = {}; pd['p[' + LIST_ID + ']'] = String(LIST_ID);
      const msg = await v1('message_add', Object.assign({
        format: 'mime', subject: SUBJECT,
        fromemail: FROM_EMAIL, fromname: FROM_NAME, reply2: FROM_EMAIL,
        priority: '3', charset: 'utf-8', encoding: 'quoted-printable',
        htmlconstructor: 'editor', html: EMAIL_HTML,
        textconstructor: 'editor', text: EMAIL_TEXT
      }, pd));
      if(!(msg && msg.result_code == 1 && msg.id))
        return res.status(200).json({ ok:false, step:'message_add', detail: msg });

      const now = new Date();
      const sdate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0') + ' 00:00:00';
      const camp = await v1('campaign_create', Object.assign({
        type: 'responder', name: CAMPAIGN_NAME, sdate, status: '1', public: '0',
        tracklinks: 'all', trackreads: '1',
        'responder[type]': 'subscribe', 'responder[offset]': '0', 'responder[unit]': 'day',
        ['m[' + msg.id + ']']: '100'
      }, pd));
      if(!(camp && camp.result_code == 1))
        return res.status(200).json({ ok:false, step:'campaign_create', message_id: msg.id, detail: camp });

      return res.status(200).json({ ok:true, created:true, message_id: msg.id, campaign_id: camp.id });
    }

    /* backfill: find every real PAID $49 ad-pack charge in Stripe, make sure
       the buyer is on lists 5/6/7 with %ADS_LINK% set, and send campaign 9 to
       anyone who was already on list 7 before the responder existed (the
       responder only fires for NEW subscribers). Dry by default; &go=1 executes. */
    if(q.do === 'buyers' || q.do === 'backfill'){
      const go = q.do === 'backfill' && q.go === '1';
      const sk = process.env.STRIPE_SECRET_KEY || '';
      if(!sk) return res.status(200).json({ ok:false, status:'no_stripe_key' });
      const sGet = async path => {
        const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + sk } });
        return r.json().catch(() => ({}));
      };
      const buyers = []; // {order, email}
      const pis = await sGet('payment_intents?limit=100&expand[]=data.latest_charge');
      for(const p of (pis.data || [])){
        if(p.status !== 'succeeded' || !p.metadata || p.metadata.type !== 'image_ads_10') continue;
        let em = (p.latest_charge && p.latest_charge.billing_details && p.latest_charge.billing_details.email) || p.receipt_email || '';
        if(!em && typeof p.customer === 'string'){
          const c = await sGet('customers/' + p.customer); em = c.email || '';
        }
        buyers.push({ order: p.id, email: (em || '').toLowerCase(), amount: p.amount, created: p.created, refunded: !!(p.latest_charge && p.latest_charge.refunded) });
      }
      const css = await sGet('checkout/sessions?limit=100');
      for(const s of (css.data || [])){
        if(s.payment_status !== 'paid' || !s.metadata || s.metadata.type !== 'image_ads_10') continue;
        buyers.push({ order: s.id, email: ((s.customer_details && s.customer_details.email) || '').toLowerCase(), amount: s.amount_total, created: s.created, refunded: false });
      }
      const seen = new Set();
      const uniq = buyers.filter(b => b.email && !b.refunded && !seen.has(b.email) && seen.add(b.email));
      if(q.do === 'buyers') return res.status(200).json({ ok:true, found: buyers, actionable: uniq });

      const results = [];
      for(const b of uniq){
        const adsLink = 'https://sellproducts.ai/ads?cs=' + encodeURIComponent(b.order);
        if(!go){ results.push({ email: b.email, order: b.order, adsLink, dry: true }); continue; }
        const sync = await v3('/api/3/contact/sync', 'POST', { contact: {
          email: b.email, fieldValues: [{ field: ADS_FIELD_ID, value: adsLink }] } });
        const cid = sync.j && sync.j.contact ? sync.j.contact.id : null;
        if(!cid){ results.push({ email: b.email, error: 'sync_failed' }); continue; }
        const cl = await v3('/api/3/contacts/' + cid + '/contactLists');
        const on = new Set(((cl.j && cl.j.contactLists) || []).filter(x => x.status == 1).map(x => String(x.list)));
        const wasOn7 = on.has(String(LIST_ID));
        const subbed = [];
        for(const L of [5, 6, LIST_ID]){
          if(on.has(String(L))) continue;
          const s2 = await v3('/api/3/contactLists', 'POST', { contactList: { list: L, contact: cid, status: 1 } });
          subbed.push(L + ':' + (s2.status < 300 ? 'ok' : 'fail'));
        }
        // already on list 7 → responder won't fire → send campaign 9 directly
        let sent = wasOn7 ? await v1('campaign_send', { campaignid: '9', email: b.email, type: 'mime', action: 'send' }) : null;
        results.push({ email: b.email, order: b.order, contactId: cid, wasOn7, subscribed: subbed,
          emailVia: wasOn7 ? ('campaign_send:' + (sent && sent.result_code == 1 ? 'ok' : JSON.stringify(sent).slice(0, 120))) : 'responder' });
      }
      return res.status(200).json({ ok:true, go, count: uniq.length, results });
    }

    /* resend for a contact already on list 7: unsubscribe → resubscribe so the
       responder sees a fresh subscribe event (AC blocks direct API campaign
       sends on young accounts). One contact per call, by email. */
    if(q.do === 'resend'){
      const email = String(q.email || '').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ ok:false, status:'bad_email' });
      const sync = await v3('/api/3/contact/sync', 'POST', { contact: { email } });
      const cid = sync.j && sync.j.contact ? sync.j.contact.id : null;
      if(!cid) return res.status(200).json({ ok:false, status:'no_contact' });
      const un = await v3('/api/3/contactLists', 'POST', { contactList: { list: LIST_ID, contact: cid, status: 2 } });
      await new Promise(r => setTimeout(r, 1500));
      const re = await v3('/api/3/contactLists', 'POST', { contactList: { list: LIST_ID, contact: cid, status: 1 } });
      return res.status(200).json({ ok:true, contactId: cid,
        unsub: un.status < 300, resub: re.status < 300,
        note: 'if the responder treats this as a new subscribe, the email sends within ~2 min' });
    }

    /* debug: a contact's stored field values + every field's list relations */
    if(q.do === 'inspect'){
      const cid = String(q.cid || '').replace(/\D/g, '');
      const vals = cid ? await v3('/api/3/contacts/' + cid + '/fieldValues') : { j: {} };
      const fields = await v3('/api/3/fields?limit=100');
      const rels = await v3('/api/3/fieldRels?limit=100');
      return res.status(200).json({ ok:true,
        contactFieldValues: (vals.j.fieldValues || []).map(v => ({ field: v.field, value: v.value })),
        fields: (fields.j.fields || []).map(f => ({ id: f.id, title: f.title, perstag: f.perstag })),
        fieldRels: (rels.j.fieldRels || []).map(r => ({ field: r.field, relid: r.relid })) });
    }

    /* fix: relate the ADS_LINK field to ALL lists (relid 0) so list sends
       actually substitute it */
    if(q.do === 'fixrel'){
      const r = await v3('/api/3/fieldRels', 'POST', { fieldRel: { field: ADS_FIELD_ID, relid: 0 } });
      return res.status(200).json({ ok: r.status < 300, detail: r.j });
    }

    if(q.do === 'test'){
      const email = String(q.email || '').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
        return res.status(400).json({ ok:false, status:'bad_email' });
      // dummy delivery link — proves the tag substitution + responder fire;
      // a real purchase writes the buyer's real /ads?cs=… page instead
      const sync = await v3('/api/3/contact/sync', 'POST', { contact: {
        email, fieldValues: [{ field: ADS_FIELD_ID, value: 'https://sellproducts.ai/ads?cs=TEST-EMAIL-ONLY' }]
      } });
      const cid = sync.j && sync.j.contact ? sync.j.contact.id : null;
      if(!cid) return res.status(200).json({ ok:false, step:'contact_sync', detail: sync.j });
      const sub = await v3('/api/3/contactLists', 'POST', {
        contactList: { list: LIST_ID, contact: cid, status: 1 }
      });
      return res.status(200).json({ ok:true, contactId: cid, subscribed: sub.status < 300,
        note: 'responder should now send the fulfillment email to ' + email });
    }

    const existing = await findCampaign();
    return res.status(200).json({ ok:true, campaign: existing, adsField: ADS_FIELD_ID, list: LIST_ID });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
