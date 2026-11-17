/* Sell Products AI — AI Employees: shared helpers for /api/office and /api/hire.

   The employees themselves (SEO Specialist, Ad Creative Designer) run on the DropStart
   server. This repo only (a) identifies the buyer, (b) takes the hire payment, and
   (c) shows the Office. Everything here talks to DropStart's key-gated
   /api/employees/* — the key lives ONLY in the EMPLOYEES_API_KEY Vercel env var and is
   never sent to a browser.

   Switches (all off by default, so merging this changes nothing for buyers):
     EMPLOYEES_UI=on       the Office/hire APIs answer buyers in production (the pages stay inert without them)
     EMPLOYEES_HIRING=on   /api/hire may CHARGE a card in production (needs prices + a tax code)
   In a Vercel PREVIEW/development deployment (VERCEL_ENV=preview|development, never anything else) the
   pages work with a test login for fixture orders only, and hiring is SIMULATED: nothing is charged. */

const crypto = require('crypto');

const API_BASE = (process.env.EMPLOYEES_API_URL || 'https://chat.dropstart.app/api/employees').replace(/\/+$/, '');
const ROLES = {
  seo:      { label: 'SEO Specialist',       blurb: 'Fixes your search listings and image descriptions, writes better product text and blog articles for you to approve.', envPrice: 'EMPLOYEES_PRICE_SEO_CENTS' },
  designer: { label: 'Ad Creative Designer', blurb: 'Turns your product photos into ready-to-run ad images in three sizes, with matching ad copy, every month.',           envPrice: 'EMPLOYEES_PRICE_DESIGNER_CENTS' },
  manager:  { label: 'Store Manager',        blurb: 'Watches your orders every day, flags late shipments, payment problems and refund or cancellation spikes, and sends you a short weekly report. She only reads: she never changes your store.', envPrice: 'EMPLOYEES_PRICE_MANAGER_CENTS' },
  support:  { label: 'Customer Support Rep', blurb: 'Reads the emails your customers send to your store, writes a reply in your voice from your own policies, and waits for your OK before anything is sent.', envPrice: 'EMPLOYEES_PRICE_SUPPORT_CENTS' },
};
const isRole = r => typeof r === 'string' && Object.prototype.hasOwnProperty.call(ROLES, r);

/* strict: only the two non-production Vercel environments count as "preview". An unset/unknown VERCEL_ENV is treated as production. */
const isPreviewEnv = () => ['preview', 'development'].includes(process.env.VERCEL_ENV || '');
const isProd = () => !isPreviewEnv();
/* Nov 17: the AI team sells in the funnel, so both switches default to ON; set the variable to 'off' to close. */
const uiOpen = () => process.env.EMPLOYEES_UI !== 'off';
const hiringOpen = () => process.env.EMPLOYEES_HIRING !== 'off';
const LAUNCH_PRICE_CENTS = 4900;          // $49 once per employee, the funnel's launch price (EMPLOYEES_PRICE_<ROLE>_CENTS overrides)
const DEFAULT_TAX_CODE = 'txcd_10103001'; // SaaS, business use — same code as Unlimited AI Stores (EMPLOYEES_TAX_CODE overrides)
const available = () => uiOpen() || isPreviewEnv();

function priceCents(role){
  if(!isRole(role)) return null;
  const v = parseInt(process.env[ROLES[role].envPrice] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : LAUNCH_PRICE_CENTS;
}

/* run an existing (req,res) handler in-process and capture its JSON — used to ask /api/auth who the
   cookie belongs to without a network hop or re-implementing (and re-embedding the secret of) its signing */
function callHandler(handler, req){
  return new Promise(resolve => {
    let status = 200;
    const res = {
      setHeader(){}, getHeader(){ return undefined; },
      status(c){ status = c; return res; },
      json(o){ resolve({ status, json: o }); return res; },
      send(t){ resolve({ status, text: t }); return res; },
      end(){ resolve({ status }); return res; }
    };
    Promise.resolve(handler(req, res)).catch(e => resolve({ status: 500, error: e }));
  });
}

function safeEq(a, b){
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Who is asking. Returns { cs, via } or null.
   1) the signed login cookie (/api/auth) -> the buyer's base order (cs_…)
   2) PREVIEW deployments only: a test login (EMPLOYEES_PREVIEW_PASS, at least 16 characters) that may impersonate ONLY the
      fixture orders listed in EMPLOYEES_PREVIEW_CS (comma list; default cs_preview_demo) — never a real buyer. */
async function identify(req){
  const h = req.headers || {};
  const q = req.query || {};
  if(isPreviewEnv()){
    const pass = process.env.EMPLOYEES_PREVIEW_PASS || '';
    const given = String(h['x-preview-pass'] || '');
    const cs = String(h['x-preview-cs'] || '');
    const fixtures = String(process.env.EMPLOYEES_PREVIEW_CS || 'cs_preview_demo').split(',').map(s => s.trim()).filter(Boolean);
    if(pass.length >= 16 && given && safeEq(pass, given) && fixtures.includes(cs) && /^cs_[A-Za-z0-9_]{3,200}$/.test(cs)) return { cs, via: 'preview' };
  }
  try{
    const auth = require('../api/auth');
    const r = await callHandler(auth, { method: 'GET', query: { action: 'session' }, headers: { cookie: String(h.cookie || '') }, body: {} });
    const j = r && r.json;
    if(j && j.ok && /^cs_[A-Za-z0-9_]{3,200}$/.test(String(j.cs || ''))) return { cs: String(j.cs), email: String(j.email || ''), via: 'session' };
  }catch(e){}
  return null;
}

/* Cross-site request forgery guard for state-changing calls (the login cookie is SameSite=Lax, this is the second layer):
   a browser must say the request is same-origin, JSON, and (when it names an Origin) from this very host. */
function sameOriginJson(req){
  const h = req.headers || {};
  const site = String(h['sec-fetch-site'] || '');
  if(site && site !== 'same-origin' && site !== 'none') return false;
  const origin = String(h.origin || '');
  if(origin){
    try{ if(new URL(origin).host !== String(h.host || '')) return false; }catch(e){ return false; }
  }
  return /^application\/json\b/i.test(String(h['content-type'] || ''));
}

/* call DropStart's employees API. Never throws: { status, json } (json null on a non-JSON answer).
   The buyer's order id travels in the X-Base-Cs header (not the URL, so it stays out of access logs).
   Redirects are never followed (a redirect must not carry our key to another host). */
async function ours(path, opts){
  const o = opts || {};
  const key = process.env.EMPLOYEES_API_KEY || '';
  if(!key) return { status: 503, json: { ok: false, error: 'not_configured' } };
  const url = new URL(API_BASE + '/' + String(path).replace(/^\/+/, ''));
  for(const [k, v] of Object.entries(o.query || {})) if(v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const init = { method: o.method || 'GET', headers: { 'X-Express-Key': key, Accept: 'application/json' }, redirect: 'manual' };
  if(o.cs) init.headers['X-Base-Cs'] = String(o.cs);
  if(o.body){ init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
  try{
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), o.timeout || 25000);
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, init));
    clearTimeout(t);
    if(r.status >= 300 && r.status < 400) return { status: 502, json: { ok: false, error: 'upstream' } };
    const text = await r.text();
    let json = null; try{ json = JSON.parse(text); }catch(e){}
    return { status: r.status, json };
  }catch(e){
    return { status: 502, json: { ok: false, error: 'upstream' } };
  }
}

function readBody(req){
  const clean = b => (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
  if(req.body === null || typeof req.on !== 'function' && !req.body) return Promise.resolve({});
  if(req.body && typeof req.body === 'object') return Promise.resolve(clean(req.body));
  if(typeof req.body === 'string'){ try{ return Promise.resolve(clean(JSON.parse(req.body || '{}'))); }catch(e){ return Promise.resolve({}); } }
  /* the platform may already have consumed (and discarded) an empty body: never wait on a finished stream */
  if(req.readableEnded || (req.complete === true && req.readable === false)) return Promise.resolve({});
  return new Promise(resolve => {
    let raw = '';
    const done = () => { try{ resolve(clean(JSON.parse(raw || '{}'))); }catch(e){ resolve({}); } };
    const t = setTimeout(done, 2000); /* belt and braces: an empty POST must not hang the function */
    req.on('data', c => { raw += c; if(raw.length > 100000) raw = raw.slice(0, 100000); });
    req.on('end', () => { clearTimeout(t); done(); });
  });
}

/* ---- paid hires whose hand-off to DropStart failed: kept in a private blob, retried on the next visit ---- */
function blobToken(){
  if(process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find(key => /READ_WRITE_TOKEN/i.test(key) && String(process.env[key]).startsWith('vercel_blob_rw'));
  return k ? process.env[k] : '';
}
const blobOpts = extra => { const t = blobToken(); return t ? Object.assign({ token: t }, extra || {}) : (extra || {}); };
async function bread(path){
  try{
    const { head } = await import('@vercel/blob');
    const h = await head(path, blobOpts());
    return await fetch(h.url, { headers: { Authorization: 'Bearer ' + blobToken() } }).then(r => r.json());
  }catch(e){ return null; }
}
async function bwrite(path, obj){
  const { put } = await import('@vercel/blob');
  await put(path, JSON.stringify(obj), blobOpts({ access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' }));
}
const pendingPath = cs => 'employees/pending/' + crypto.createHash('sha256').update(String(cs)).digest('hex').slice(0, 40) + '.json';

/* tell DropStart about a paid hire (idempotent on their side: same reference = same hire) */
async function recordHire(cs, roles, amount, ref){
  const r = await ours('hire', { method: 'POST', cs, timeout: 8000, body: { roles, price_cents: amount, source_ref: ref, idempotency_key: 'hire-' + ref } });
  return r.status === 200 && r.json && r.json.ok === true;
}

/* Retry every unrecorded paid hire for this buyer. Returns the number still unresolved. Never throws. */
async function retryPending(cs){
  try{
    const rec = await bread(pendingPath(cs));
    const list = rec && Array.isArray(rec.items) ? rec.items : [];
    if(!list.length) return 0;
    const left = [];
    for(const it of list){
      if(!(it && it.ref && Array.isArray(it.roles) && await recordHire(cs, it.roles, it.amount || null, it.ref))) left.push(it);
    }
    if(left.length !== list.length) await bwrite(pendingPath(cs), { items: left, at: Date.now() });
    return left.length;
  }catch(e){ return 1; }
}

function taxCode(){ const t = String(process.env.EMPLOYEES_TAX_CODE || ''); return /^txcd_\d{8}$/.test(t) ? t : DEFAULT_TAX_CODE; }

module.exports = { taxCode, ROLES, isRole, isProd, isPreviewEnv, uiOpen, hiringOpen, priceCents, identify, ours, readBody, available, safeEq, sameOriginJson, bread, bwrite, pendingPath, recordHire, retryPending };
