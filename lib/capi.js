/* Meta Conversions API — server-side copies of the browser pixel's events.
   Every event carries the SAME event_id the browser used (dsFire: 'ds_' + key),
   so Meta deduplicates the pair instead of counting twice, and the server copy
   fills in whatever the browser lost (iOS, ad blockers, a closed tab).
   Enabled only when META_CAPI_TOKEN is set. A failure here never changes the
   request that triggered it. META_CAPI_TEST_CODE (preview only) routes every
   event to Events Manager → Test events. */
'use strict';
const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '2291464791591164';
const API_URL = process.env.META_CAPI_URL || ('https://graph.facebook.com/v21.0/' + PIXEL_ID + '/events');
const TIMEOUT_MS = 2500;

function enabled(){ return !!process.env.META_CAPI_TOKEN; }
/* The test code is honoured on preview deployments only. On production it would silently turn every
   live event into a test event (shown in Events Manager's Test events, never counted), whatever the
   environment variables say. */
function testCode(){ return process.env.VERCEL_ENV === 'production' ? '' : String(process.env.META_CAPI_TEST_CODE || '').slice(0, 40); }
function sha(v){ return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function normEmail(e){ e = String(e || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : ''; }
function normPhone(p){ const d = String(p || '').replace(/\D/g, ''); if(d.length < 10 || d.length > 15) return ''; return d.length === 10 ? '1' + d : d; }
function normName(n){ return String(n || '').trim().toLowerCase().replace(/[^a-zÀ-ɏ' -]/g, '').slice(0, 60); }
function clientIp(req){
  const h = (req && req.headers) || {};
  const v = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
  return /^[0-9a-f.:]+$/i.test(v) ? v : '';
}
function cookies(req){
  const out = {};
  String((req && req.headers && req.headers.cookie) || '').split(';').forEach(p => {
    const i = p.indexOf('='); if(i > 0){ try{ out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }catch(e){} }
  });
  return out;
}
function fbcFromUrl(url){
  try{ const id = new URL(String(url)).searchParams.get('fbclid'); return id ? 'fb.1.' + Date.now() + '.' + id.slice(0, 300) : ''; }catch(e){ return ''; }
}

/* user_data: what Meta matches the event to a person with. Hashed where Meta wants hashes. */
function userData(req, x){
  x = x || {};
  const c = cookies(req), u = {};
  const ip = clientIp(req); if(ip) u.client_ip_address = ip;
  const ua = req && req.headers && req.headers['user-agent']; if(ua) u.client_user_agent = String(ua).slice(0, 512);
  const fbp = String(x.fbp || c._fbp || ''); if(/^fb\.1\.\d+\.\d+$/.test(fbp)) u.fbp = fbp;
  const fbc = String(x.fbc || c._fbc || fbcFromUrl(x.url) || ''); if(/^fb\.1\.\d+\./.test(fbc)) u.fbc = fbc.slice(0, 400);
  const em = normEmail(x.email); if(em) u.em = [sha(em)];
  const ph = normPhone(x.phone); if(ph) u.ph = [sha(ph)];
  const fn = normName(x.firstName); if(fn) u.fn = [sha(fn)];
  const ext = String(x.sid || x.cid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64); if(ext) u.external_id = [sha(ext)];
  return u;
}

function sourceUrl(req, url){
  const u = String(url || (req && req.headers && req.headers.referer) || '').slice(0, 1024);
  return /^https?:\/\//.test(u) ? u : 'https://www.sellproducts.ai/';
}

/* One event. `key` is the browser's onceKey (without the 'ds_' prefix). */
function event(name, key, req, x){
  x = x || {};
  const now = Date.now();
  const t = Number(x.time) || now;
  const ev = {
    event_name: name,
    event_time: Math.floor(((t > now - 6 * 864e5 && t < now + 6e5) ? t : now) / 1000),
    event_id: 'ds_' + String(key).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120),
    event_source_url: sourceUrl(req, x.url),
    action_source: 'website',
    user_data: userData(req, x)
  };
  if(x.value != null || x.custom){
    ev.custom_data = Object.assign({}, x.custom || {});
    if(x.value != null){ ev.custom_data.value = Math.round(Number(x.value) * 100) / 100; ev.custom_data.currency = x.currency || 'USD'; }
  }
  return ev;
}

async function send(events){
  if(!enabled()) return { ok:false, skipped:'disabled' };
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if(!list.length) return { ok:false, skipped:'empty' };
  const body = { data: list, access_token: process.env.META_CAPI_TOKEN };
  if(testCode()) body.test_event_code = testCode();
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(API_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    const j = await r.json().catch(() => null);
    if(!r.ok) console.warn('capi ' + r.status + ': ' + JSON.stringify((j && j.error) || j).slice(0, 300));
    return { ok: r.ok, status: r.status, received: j && j.events_received, error: j && j.error && j.error.message };
  }catch(e){
    console.warn('capi: ' + String(e && e.message || e).slice(0, 160));
    return { ok:false, error: String(e && e.message || e).slice(0, 160) };
  }finally{ clearTimeout(timer); }
}

/* From a request handler: runs past the response on Vercel (waitUntil), the caller never waits. */
function fire(events){
  if(!enabled()) return Promise.resolve({ ok:false, skipped:'disabled' });
  const p = send(events).catch(() => ({ ok:false }));
  try{ const { waitUntil } = require('@vercel/functions'); waitUntil(p); }catch(e){}
  return p;
}

function status(){ return { enabled: enabled(), pixel: PIXEL_ID, test_mode: !!testCode() }; }

module.exports = { enabled, event, send, fire, status, userData, sha };
