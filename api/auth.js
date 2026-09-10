/* Sell Products AI — Members Area auth (/api/auth).
   Passwordless login for /members. Identity = the email used at checkout;
   entitlement = a paid store order in Stripe (metadata.type store_unlock20 /
   store_unlock). No passwords anywhere.

   Flows:
   ?action=exchange&cs=...        activation-link visit → verify the session with
                                  Stripe, set a 90-day signed cookie, remember
                                  email→cs so code logins can find the order.
   ?action=start&email=...        return visit → 6-digit code emailed via Resend
                                  (10-min expiry, hashed at rest, rate limited).
   ?action=verify&email=&code=    code checked (max 5 tries) → cookie set →
                                  { ok, cs } so the page can load progress.
   ?action=session                cookie → { ok, email, cs }.
   ?action=logout                 clears the cookie.
   ?probe=...&key=READ_KEY        owner diagnostics (lookup / mail test).

   Storage (private Vercel Blob):
   members/email/<sha256(email)>.json  { email, cs, src, created, updated }
   members/code/<sha256(email)>.json   { h, exp, tries, sends:[ts] } */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const AUTH_SECRET = process.env.AUTH_SECRET || '20365b854f330a5a41656911796269c12b0417be5adc698b572491ce9df7d857';
/* Resend key: env var wins; otherwise the private-blob config written once via
   ?probe=setmail (keeps the secret out of git — GitHub blocks pushed API keys) */
let RESEND_KEY_CACHE = null;
async function resendKey(){
  if(process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY;
  if(RESEND_KEY_CACHE !== null) return RESEND_KEY_CACHE;
  const cfg = await bread('members/config/resend.json');
  RESEND_KEY_CACHE = (cfg && cfg.key) || '';
  return RESEND_KEY_CACHE;
}
const FROM_PRIMARY = 'Sell Products AI <login@account.sellproducts.ai>'; // Resend-verified subdomain
const FROM_FALLBACK = 'Sell Products AI <onboarding@resend.dev>'; // works pre-DNS, but only to the Resend account owner
const OK_TYPES = new Set(['store_unlock20', 'store_unlock']);
const COOKIE = 'spai_sess';
const SESS_DAYS = 90;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_TRIES = 5;

const crypto = require('crypto');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = s => crypto.createHmac('sha256', AUTH_SECRET).update(String(s)).digest('hex');
const b64u = s => Buffer.from(String(s)).toString('base64url');
const unb64u = s => { try{ return Buffer.from(String(s), 'base64url').toString('utf8'); }catch(e){ return ''; } };

function blobToken(){
  if(process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find(key =>
    /READ_WRITE_TOKEN/i.test(key) && String(process.env[key]).startsWith('vercel_blob_rw'));
  return k ? process.env[k] : '';
}
function blobOpts(extra){
  const t = blobToken();
  return t ? Object.assign({ token: t }, extra || {}) : (extra || {});
}
async function bread(path){
  try{
    const { head } = await import('@vercel/blob');
    const h = await head(path, blobOpts());
    return await fetch(h.url, { headers: { Authorization: 'Bearer ' + blobToken() } }).then(r => r.json());
  }catch(e){ return null; }
}
async function bwrite(path, obj){
  const { put } = await import('@vercel/blob');
  await put(path, JSON.stringify(obj), blobOpts({
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json' }));
}

async function sget(path, ver){
  const headers = { Authorization: 'Bearer ' + (process.env.STRIPE_SECRET_KEY || '') };
  if(ver) headers['Stripe-Version'] = ver; // account default (2020-03-02) predates the Search API
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

const normEmail = e => String(e || '').trim().toLowerCase().slice(0, 200);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const idxPath = e => 'members/email/' + sha256(normEmail(e)) + '.json';
const codePath = e => 'members/code/' + sha256(normEmail(e)) + '.json';

/* is this checkout session one of our paid store orders? */
async function storeSession(csId){
  const s = await sget('checkout/sessions/' + encodeURIComponent(csId));
  const ty = (s.metadata && s.metadata.type) || '';
  if(s.payment_status !== 'paid' || !OK_TYPES.has(ty)) return null;
  return s;
}

/* email → newest paid store order. Index first; Stripe lanes as backfill for
   buyers from before this feature existed. */
async function findMemberCs(email, diag){
  const idx = await bread(idxPath(email));
  if(idx && idx.cs){ if(diag) diag.src = 'index'; return idx.cs; }

  // customer objects → their succeeded PIs → the PI's checkout session.
  // Every buyer has a customer (the one-click upsell rail requires a saved
  // card); charge/PI search can't filter on email, so this is the one lane.
  try{
    const cu = await sget('customers?limit=5&email=' + encodeURIComponent(email));
    for(const c of (cu.data || [])){
      const pis = await sget('payment_intents?limit=20&customer=' + encodeURIComponent(c.id));
      for(const pi of (pis.data || [])){
        if(pi.status !== 'succeeded') continue;
        try{
          const ss = await sget('checkout/sessions?limit=1&payment_intent=' + encodeURIComponent(pi.id));
          const s = ss.data && ss.data[0];
          if(s && s.payment_status === 'paid' && OK_TYPES.has((s.metadata && s.metadata.type) || '')){
            if(diag) diag.src = 'customer';
            await bwrite(idxPath(email), { email, cs: s.id, src: 'customer', created: Date.now(), updated: Date.now() });
            return s.id;
          }
        }catch(e){}
      }
    }
  }catch(e){ if(diag) diag.customer_err = String(e.message || e).slice(0, 120); }
  return '';
}

/* ---- session cookie: b64u(email).exp.hmac ---- */
function setSession(res, email){
  const exp = Date.now() + SESS_DAYS * 86400000;
  const core = b64u(normEmail(email)) + '.' + exp;
  res.setHeader('Set-Cookie', COOKIE + '=' + core + '.' + hmac(core) +
    '; Max-Age=' + (SESS_DAYS * 86400) + '; Path=/; HttpOnly; Secure; SameSite=Lax');
}
function clearSession(res){
  res.setHeader('Set-Cookie', COOKIE + '=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
}
function readSession(req){
  const raw = String(req.headers.cookie || '');
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if(!m) return '';
  const parts = m[1].split('.');
  if(parts.length !== 3) return '';
  const core = parts[0] + '.' + parts[1];
  if(hmac(core) !== parts[2]) return '';
  if(Date.now() > parseInt(parts[1], 10)) return '';
  return normEmail(unb64u(parts[0]));
}

/* ---- Resend ---- */
async function sendCodeEmail(to, code){
  const RESEND_KEY = await resendKey();
  if(!RESEND_KEY) return { ok:false, error:'no_resend_key' };
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:28px 20px">' +
    '<div style="font-size:18px;font-weight:800;margin-bottom:14px">Sell Products <span style="background:#F59E0B;color:#241500;border-radius:6px;padding:1px 6px">AI</span></div>' +
    '<p style="font-size:15px;color:#333;margin:0 0 18px">Your members-area login code:</p>' +
    '<div style="font-size:34px;font-weight:800;letter-spacing:10px;background:#f5f6fa;border-radius:12px;padding:18px 0;text-align:center">' + code + '</div>' +
    '<p style="font-size:13px;color:#777;margin:18px 0 0">This code expires in 10 minutes. If you didn\'t request it, you can ignore this email — nobody can get in without the code.</p>' +
    '</div>';
  const payload = from => fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: code + ' is your Sell Products AI login code', html })
  }).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
  let r = await payload(FROM_PRIMARY);
  if(r.status === 403 || r.status === 422){ // domain not verified yet → dev sender (owner-only)
    const r2 = await payload(FROM_FALLBACK);
    if(r2.status >= 200 && r2.status < 300) return { ok:true, via:'fallback' };
    return { ok:false, error:'send_failed', detail: (r.j.message || '') + ' / ' + (r2.j.message || '') };
  }
  if(r.status >= 200 && r.status < 300) return { ok:true, via:'primary' };
  return { ok:false, error:'send_failed', detail: r.j.message || ('resend ' + r.status) };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Cache-Control', 'no-store');
  let body = {};
  if(req.method === 'POST'){
    try{ body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }catch(e){}
  }
  const q = Object.assign({}, req.query || {}, body);
  const action = String(q.action || '');
  try{
    if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no_keys' });

    /* ---- owner diagnostics ---- */
    if(q.probe && q.key === READ_KEY){
      if(q.probe === 'lookup'){
        const email = normEmail(q.email); const diag = {};
        const cs = await findMemberCs(email, diag);
        return res.status(200).json({ ok:true, found: !!cs,
          cs_tail: cs ? '…' + cs.slice(-8) : '', cs: q.full ? cs : undefined, diag });
      }
      if(q.probe === 'mail'){
        const r = await sendCodeEmail(normEmail(q.to), '000000');
        return res.status(200).json({ ok:true, mail: r });
      }
      if(q.probe === 'setmail'){
        const rk = String(q.rk || '');
        if(!/^re_[A-Za-z0-9_]{10,}$/.test(rk)) return res.status(200).json({ ok:false, error:'bad_resend_key' });
        await bwrite('members/config/resend.json', { key: rk, set: Date.now() });
        RESEND_KEY_CACHE = rk;
        return res.status(200).json({ ok:true, stored:true });
      }
      return res.status(200).json({ ok:false, error:'bad_probe' });
    }

    /* ---- activation-link visit: cs → cookie ---- */
    if(action === 'exchange'){
      const cs = String(q.cs || '').slice(0, 300);
      if(!/^cs_[A-Za-z0-9_]+$/.test(cs)) return res.status(200).json({ ok:false, error:'bad_cs' });
      if(cs === 'cs_test_roadmap') return res.status(200).json({ ok:true, demo:true });
      const s = await storeSession(cs);
      if(!s) return res.status(200).json({ ok:false, error:'not_a_store_order' });
      const email = normEmail(s.customer_details && s.customer_details.email);
      if(email){
        await bwrite(idxPath(email), { email, cs, src:'exchange', created: Date.now(), updated: Date.now() });
        setSession(res, email);
      }
      return res.status(200).json({ ok:true, email, cs });
    }

    /* ---- code login, step 1: send ---- */
    if(action === 'start'){
      const email = normEmail(q.email);
      if(!emailOk(email)) return res.status(200).json({ ok:false, error:'bad_email' });
      const now = Date.now();
      const prev = (await bread(codePath(email))) || {};
      const sends = (prev.sends || []).filter(t => now - t < 3600000);
      if(sends.length >= MAX_SENDS_PER_HOUR) return res.status(200).json({ ok:false, error:'rate_limited' });
      const cs = await findMemberCs(email);
      if(!cs) return res.status(200).json({ ok:false, error:'not_found' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      sends.push(now);
      await bwrite(codePath(email), { h: hmac(email + '|' + code), exp: now + CODE_TTL_MS, tries: 0, sends });
      const sent = await sendCodeEmail(email, code);
      if(!sent.ok) return res.status(200).json({ ok:false, error: sent.error === 'no_resend_key' ? 'mail_unconfigured' : 'send_failed' });
      return res.status(200).json({ ok:true, sent:true });
    }

    /* ---- code login, step 2: verify ---- */
    if(action === 'verify'){
      const email = normEmail(q.email);
      const code = String(q.code || '').replace(/\D/g, '').slice(0, 6);
      const rec = await bread(codePath(email));
      if(!rec || !rec.h || Date.now() > rec.exp) return res.status(200).json({ ok:false, error:'expired' });
      if((rec.tries || 0) >= MAX_TRIES) return res.status(200).json({ ok:false, error:'too_many_tries' });
      if(hmac(email + '|' + code) !== rec.h){
        rec.tries = (rec.tries || 0) + 1;
        await bwrite(codePath(email), rec);
        return res.status(200).json({ ok:false, error:'wrong_code', left: MAX_TRIES - rec.tries });
      }
      await bwrite(codePath(email), { used: Date.now(), sends: rec.sends || [] });
      const cs = await findMemberCs(email);
      setSession(res, email);
      return res.status(200).json({ ok:true, email, cs });
    }

    /* ---- who am I ---- */
    if(action === 'session'){
      const email = readSession(req);
      if(!email) return res.status(200).json({ ok:false, error:'no_session' });
      const idx = await bread(idxPath(email));
      return res.status(200).json({ ok:true, email, cs: (idx && idx.cs) || '' });
    }

    if(action === 'logout'){
      clearSession(res);
      return res.status(200).json({ ok:true });
    }

    return res.status(200).json({ ok:false, error:'bad_action' });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 200) });
  }
};
