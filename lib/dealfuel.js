/* Sell Products AI — DealFuel lead webhook.
   Every completed $20 store unlock is POSTed to DealFuel so their callers can
   reach the buyer. Fired on the server right after Stripe confirms the $20
   payment (the /api/unlock20?verify= step), once per payment, in the
   background. Opt-ins and upsells are never sent. Buyers without a phone are
   skipped.

   Once-per-payment: the Stripe PaymentIntent carries metadata.dealfuel
   (sending → sent | duplicate | skipped_no_phone | failed:<reason>). A send is
   attempted only when that marker is absent or a previous attempt failed.
   DealFuel also dedupes on event_id (the PaymentIntent id), and answers
   200 {"duplicate":true} for a repeat, which counts as success.

   Delivery: 5 s timeout per attempt, up to 3 attempts with backoff on a
   timeout, network error or 5xx. 400 and 401 are never retried; the response
   body is logged because it names the bad field or the bad token. Every
   failure is logged with the payment id.

   Buyer data: name, email, country from the Stripe session; phone, SMS
   consent, time zone and first name from the session metadata the funnel
   stamps at checkout; ActiveCampaign is the fallback for phone, name and
   consent when the session has none (returning buyers who skipped the email
   step). The token comes from env DEALFUEL_LEADS_TOKEN, never from code. */

const { credential } = require('./secrets');

const DF_URL = 'https://dba.hq.dealfuel.ai/webhooks/client-leads';
const FUNNEL_KEY = 'spai-store-unlock';
const PAGE_URL = 'https://www.sellproducts.ai/';
const AC_URL = 'https://sellproducts.api-us1.com';
const TIMEOUT_MS = 5000;
const ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];

function token(){ return process.env.DEALFUEL_LEADS_TOKEN || ''; }
const log = (...a) => console.log('[dealfuel]', ...a);
const logErr = (...a) => console.error('[dealfuel]', ...a);

/* ---- Stripe (form-encoded, same shape the funnel's functions use) ---- */
async function stripe(sk, path, params){
  const opts = { method: params ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + sk } };
  if(params){ opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params).toString(); }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

/* ---- ActiveCampaign fallback: phone, name, consent for an email ---- */
let smsFieldId = null;
async function ac(path){
  const key = credential('AC_KEY');
  if(!key) return null;
  const r = await fetch(AC_URL + path, { headers: { 'Api-Token': key } });
  return r.ok ? r.json().catch(() => null) : null;
}
async function acLookup(email){
  const out = { phone: '', firstName: '', lastName: '', consent: false };
  if(!email) return out;
  try{
    const f = await ac('/api/3/contacts?email=' + encodeURIComponent(email));
    const c = f && f.contacts && f.contacts[0];
    if(!c) return out;
    out.phone = String(c.phone || '');
    out.firstName = String(c.firstName || '');
    out.lastName = String(c.lastName || '');
    if(smsFieldId === null){
      const fl = await ac('/api/3/fields?limit=100');
      const fld = ((fl && fl.fields) || []).find(x => x.perstag === 'SMS_CONSENT');
      smsFieldId = fld ? String(fld.id) : '';
    }
    if(smsFieldId){
      const fv = await ac('/api/3/contacts/' + c.id + '/fieldValues');
      out.consent = !!((fv && fv.fieldValues) || []).some(v => String(v.field) === smsFieldId && v.value);
    }
  }catch(e){}
  return out;
}

function splitName(full){
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if(!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}
const iso = unix => new Date((unix || Math.floor(Date.now() / 1000)) * 1000).toISOString();

/* Build the DealFuel body from a paid Checkout Session and its PaymentIntent.
   Returns { payload } or { skip: 'no_phone' }. */
async function buildPayload(session, pi){
  const m = session.metadata || {}, cd = session.customer_details || {};
  const email = String(cd.email || m.email || '').trim();
  let phone = String(m.phone || '').trim();
  let consent = m.sms_consent === '1';
  let { first, last } = splitName(cd.name);
  if(m.first_name && !first) first = String(m.first_name);
  if(!phone || !first){
    const a = await acLookup(email);
    if(!phone && a.phone){ phone = a.phone; consent = consent || a.consent; }
    if(!first && a.firstName) first = a.firstName;
    if(!last && a.lastName && !cd.name) last = a.lastName;
  }
  if(!phone) return { skip: 'no_phone' };
  const when = iso(pi && pi.created);
  return { payload: {
    event: 'lead.created',
    event_id: pi.id,
    occurred_at: when,
    funnel: { key: FUNNEL_KEY, page_url: PAGE_URL },
    lead: {
      id: String(session.customer || pi.customer || ''),
      created_at: when,
      first_name: first,
      last_name: last,
      email,
      phone,
      country: String((cd.address && cd.address.country) || '').toUpperCase().slice(0, 2),
      timezone: String(m.tz || ''),
      product: String(m.product || '')
    },
    consent: { given: !!consent }
  } };
}

/* POST with timeout + retries. Resolves { ok, status, body, attempts, reason }. */
async function post(payload, piId, fetchImpl){
  const f = fetchImpl || fetch;
  let last = { ok: false, status: 0, body: '', attempts: 0, reason: 'not_sent' };
  for(let i = 0; i < ATTEMPTS; i++){
    last.attempts = i + 1;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try{
      const r = await f(DF_URL, { method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-dealfuel-token': token() },
        body: JSON.stringify(payload) });
      clearTimeout(timer);
      const text = await r.text().catch(() => '');
      let j = {}; try{ j = JSON.parse(text); }catch(e){}
      last.status = r.status; last.body = text.slice(0, 500);
      if(r.status >= 200 && r.status < 300){
        last.ok = true; last.reason = j && j.duplicate === true ? 'duplicate' : 'sent';
        return last;
      }
      if(r.status === 400 || r.status === 401 || (r.status >= 402 && r.status < 500)){
        last.reason = 'rejected_' + r.status;
        logErr('rejected', piId, r.status, last.body); // names the bad field or the bad token
        return last;
      }
      last.reason = 'http_' + r.status; // 5xx → retry
      logErr('attempt', i + 1, 'failed', piId, r.status, last.body);
    }catch(e){
      clearTimeout(timer);
      last.reason = e && e.name === 'AbortError' ? 'timeout' : 'network';
      logErr('attempt', i + 1, last.reason, piId, String(e && e.message || e).slice(0, 120));
    }
    if(i < ATTEMPTS - 1) await new Promise(r => setTimeout(r, BACKOFF_MS[i] || 2000));
  }
  return last;
}

async function mark(sk, piId, value){
  try{ await stripe(sk, 'payment_intents/' + piId, { 'metadata[dealfuel]': String(value).slice(0, 80) }); }catch(e){}
}

/* The whole job for one paid session. Safe to call repeatedly. */
async function sendForSession(sk, session, opts){
  const o = opts || {};
  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id);
  if(!piId){ logErr('no payment_intent on session', session.id); return { reason: 'no_pi' }; }
  if(!token() && !o.dry){ logErr('DEALFUEL_LEADS_TOKEN missing', piId); return { reason: 'no_token', piId }; }
  let pi;
  try{ pi = await stripe(sk, 'payment_intents/' + piId); }
  catch(e){ logErr('pi read failed', piId, String(e && e.message || e).slice(0, 120)); return { reason: 'pi_read_failed', piId }; }
  const done = (pi.metadata && pi.metadata.dealfuel) || '';
  if(!o.dry && /^(sent|duplicate|skipped_no_phone|sending)$/.test(done)) return { reason: 'already_' + done, piId };
  const built = await buildPayload(session, pi);
  if(built.skip){
    if(!o.dry) await mark(sk, piId, 'skipped_no_phone');
    log('skipped, no phone', piId);
    return { reason: 'skipped_no_phone', piId, payload: null };
  }
  if(o.dry) return { reason: 'dry', piId, marker: done, payload: built.payload };
  await mark(sk, piId, 'sending');
  const r = await post(built.payload, piId, o.fetch);
  await mark(sk, piId, r.ok ? r.reason : 'failed:' + r.reason);
  if(r.ok) log(r.reason, piId, 'attempts', r.attempts);
  else logErr('FAILED', piId, r.reason, 'attempts', r.attempts, r.body);
  return Object.assign({ piId }, r);
}

/* Run in the background so the checkout response never waits on DealFuel. */
function kick(sk, session){
  const p = sendForSession(sk, session).catch(e => logErr('unhandled', session && session.id, String(e && e.message || e).slice(0, 160)));
  try{ const { waitUntil } = require('@vercel/functions'); waitUntil(p); }catch(e){ /* local / older runtime: fire and forget */ }
  return p;
}

module.exports = { sendForSession, buildPayload, post, kick, splitName, DF_URL, FUNNEL_KEY };
