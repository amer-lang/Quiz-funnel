/* Sell Products AI — order sweep (/api/ordersheet).
   Every 5 minutes (Vercel Cron) this scans Stripe for newly PAID orders and
   feeds two sinks, each with its own dedupe ledger:
   1. GOOGLE SHEET — five-video orders only (type video_ads_5), appended via
      the owner's Apps Script web-app hook.
   2. WHOP CONVERSIONS API — every paid order (all purchase types) POSTed as
      a server-side `purchase` event with the Stripe payment id as event_id
      (globally unique, so Whop can never double-count; the browser pixel
      deliberately does NOT send purchase — this is the single source).

   GET  (cron or ?key=READ_KEY)                → sweep the last 48h
   GET  ?key=READ_KEY&backfill=30              → sheet-sink seed run (N days)
   GET  ?probe=seturl&key=READ_KEY&url=...     → store the Apps Script URL
   GET  ?probe=setwhop&key=READ_KEY&wk=...     → store the Whop API key
   GET  ?ping=1&key=READ_KEY                   → config + ledger sanity
   3. SMS ACTIVATION DRIP — $20 store buyers who opted in to texts (their
      ActiveCampaign contact carries the consented phone) get their activation
      link by SMS on a schedule: +10m, +1h, +24h, +48h, +72h, +6d, +9d, +12d,
      +15d. Stops the moment the buyer's ActiveCampaign contact is an active
      member of the "Store completed" list, on a STOP reply (SimpleTexting
      rejects the send), or when the schedule ends. One message per buyer per sweep, never a burst.
      Needs env SIMPLETEXTING_API_KEY. Buyers from before the deploy are never
      enrolled (start watermark).
   GET  ?probe=drip&key=READ_KEY               → drip ledger summary
   GET  ?probe=driptest&key=READ_KEY&to=1XXX&name=Amer → send step-0 copy to a number
   GET  ?probe=dsstatus&key=READ_KEY&pid=NNN   → raw DropStart status for a store

   Sheet columns (row 1 headers, set by hand):
   Date (PT) | Email | Product | Amount | Source | Order ID */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const SHEET_SECRET = '789b6ab8689b124208d9bf20e12e7bbf'; // must match the Apps Script
const TYPES = new Set(['video_ads_5']); // sheet sink
const ALL_TYPES = new Set(['store_unlock20', 'store_unlock', 'video_ads_5', 'image_ads_10', 'store_addons']); // whop sink
const LEDGER = 'orders/videolog.json';
const WHOP_LEDGER = 'orders/whoplog.json';
const DRIP_LEDGER = 'orders/smsdrip.json';
const DRIP_TYPES = new Set(['store_unlock20']);
const AC_COMPLETED_LIST = 'Store completed'; // AC list = stop signal for the drip
const ST_API = 'https://api-app2.simpletexting.com/v2/api/messages';
const AC = require('./members.js').AC; // ActiveCampaign creds live in members.js only
/* DropStart status via OUR proxy (/api/ds holds the express key server-side —
   it is deliberately not duplicated here) */
const DS_STATUS = 'https://www.sellproducts.ai/api/ds/status/';
/* seconds after purchase for each step */
const DRIP_AT = [10*60, 3600, 24*3600, 48*3600, 72*3600, 6*86400, 9*86400, 12*86400, 15*86400];
function dripText(i, name, link){
  const n = name ? name : 'Hey';
  const nm = name ? name + ',' : 'Hey —';
  const T = [
    nm + ' your store is built and waiting 🎉 Activate it here (takes ~10 min): ' + link + ' — Sell Products AI. Reply STOP to opt out.',
    'Quick one, ' + n + ': your store can\'t make a single sale until it\'s live. Your activation link: ' + link + ' Txt STOP to end',
    nm + ' 24 hours in and your store is still offline. Most people finish activation in 10 minutes: ' + link + ' Txt STOP to end',
    'Day 2: your trending product is still reserved for you, ' + n + '. Take the store live: ' + link + ' Txt STOP to end',
    nm + ' this is the step most people never do — and the only one that matters. Activate your store: ' + link + ' Txt STOP to end',
    'Still here for you, ' + n + '. Your store, your product, your activation link: ' + link + ' Txt STOP to end',
    n + ' — quick reminder that your store is built and paid for. Go live whenever you\'re ready: ' + link + ' Txt STOP to end',
    'Two weeks ago you bought a store, ' + n + '. It takes 10 minutes to turn on: ' + link + ' Txt STOP to end',
    'Last reminder from us, ' + n + '. Your activation link stays valid: ' + link + ' — Sell Products AI. Reply STOP to opt out.'
  ];
  return T[i] || '';
}
const CFG = 'members/config/ordersheet.json';
const WHOP_CFG = 'members/config/whop.json';
const WHOP_ACCOUNT = 'biz_FXze6GwnWnentH';

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

async function sget(path){
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + (process.env.STRIPE_SECRET_KEY || '') }
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}
async function pageAll(base, gte, cap){
  const out = [];
  let after = '';
  for(let i = 0; i < (cap || 5); i++){
    const j = await sget(base + '&limit=100&created[gte]=' + gte + (after ? '&starting_after=' + after : ''));
    out.push(...(j.data || []));
    if(!j.has_more || !j.data.length) break;
    after = j.data[j.data.length - 1].id;
  }
  return out;
}

const ptDate = ts => new Date(ts * 1000).toLocaleString('en-US',
  { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/* the buyer's email + UTMs: session → customer_details/metadata;
   one-click PI → its base session */
const BASE_MEMO = new Map();
async function baseInfo(baseCs){
  if(!baseCs) return { email: '', utm: {} };
  if(BASE_MEMO.has(baseCs)) return BASE_MEMO.get(baseCs);
  let out = { email: '', utm: {} };
  try{
    const s = await sget('checkout/sessions/' + encodeURIComponent(baseCs));
    out = { email: (s.customer_details && s.customer_details.email) || '', utm: utmOf(s.metadata) };
  }catch(err){}
  BASE_MEMO.set(baseCs, out);
  return out;
}
function utmOf(meta){
  meta = meta || {};
  const u = {};
  if(meta.utm_source) u.utm_source = String(meta.utm_source).slice(0, 100);
  if(meta.utm_medium) u.utm_medium = String(meta.utm_medium).slice(0, 100);
  if(meta.utm_campaign) u.utm_campaign = String(meta.utm_campaign).slice(0, 100);
  if(meta.waid) u.waid = String(meta.waid).slice(0, 100);   // Whop ad click ids
  if(meta.wacid) u.wacid = String(meta.wacid).slice(0, 100);
  if(meta.wasid) u.wasid = String(meta.wasid).slice(0, 100);
  return u;
}
const SOURCE_BY_TYPE = { store_unlock20: '$20 unlock', store_unlock: 'legacy unlock',
  image_ads_10: '$49 image ads', store_addons: 'launch addons' };

async function collectOrders(gteSec){
  const rows = [];
  // one-click PaymentIntents
  const pis = await pageAll('payment_intents?', gteSec, 5);
  for(const p of pis){
    if(p.status !== 'succeeded') continue;
    const ty = (p.metadata && p.metadata.type) || '';
    if(!ALL_TYPES.has(ty)) continue;
    const base = await baseInfo(p.metadata.base_cs);
    rows.push({
      id: p.id, created: p.created, type: ty,
      email: p.receipt_email || base.email || '',
      utm: base.utm,
      product: (p.metadata && p.metadata.product) || '',
      value: p.amount / 100,
      amount: '$' + (p.amount / 100).toFixed(2),
      source: ty === 'video_ads_5'
        ? (p.amount === 29900 ? '$299 one-click' : '$199 VSL one-click')
        : (SOURCE_BY_TYPE[ty] || ty) + ' one-click',
      base_cs: (p.metadata && p.metadata.base_cs) || ''
    });
  }
  // checkout sessions
  const sess = await pageAll('checkout/sessions?', gteSec, 5);
  for(const s of sess){
    if(s.payment_status !== 'paid') continue;
    const ty = (s.metadata && s.metadata.type) || '';
    if(!ALL_TYPES.has(ty)) continue;
    const selfUtm = utmOf(s.metadata);
    let email = (s.customer_details && s.customer_details.email) || '';
    let utm = selfUtm;
    if((!email || !Object.keys(utm).length) && s.metadata && s.metadata.base_cs){
      const base = await baseInfo(s.metadata.base_cs);
      email = email || base.email;
      if(!Object.keys(utm).length) utm = base.utm;
    }
    rows.push({
      id: s.id, created: s.created, type: ty,
      email: email,
      pid: (s.metadata && s.metadata.project_id) || '',
      utm: utm,
      product: (s.metadata && s.metadata.product) || '',
      value: (s.amount_total || 0) / 100,
      amount: '$' + ((s.amount_total || 0) / 100).toFixed(2),
      source: ty === 'video_ads_5'
        ? ((s.amount_total || 0) === 29900 ? '$299 checkout' : '$199 checkout')
        : (SOURCE_BY_TYPE[ty] || ty) + ' checkout',
      base_cs: (s.metadata && s.metadata.base_cs) || ''
    });
  }
  rows.sort((a, b) => a.created - b.created);
  return rows;
}

async function pushRow(url, row, diag){
  const r = await fetch(url, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ k: SHEET_SECRET,
      date: ptDate(row.created), email: row.email, product: row.product,
      amount: row.amount, source: row.source, id: row.id })
  });
  if(diag){
    diag.status = r.status;
    diag.body = String(await r.text().catch(() => '')).slice(0, 300);
  }
  return r.status >= 200 && r.status < 400;
}

/* ---- Whop server-side conversions ---- */
let WHOP_KEY_CACHE = null;
async function whopKey(){
  if(process.env.WHOP_API_KEY) return process.env.WHOP_API_KEY;
  if(WHOP_KEY_CACHE !== null) return WHOP_KEY_CACHE;
  const cfg = await bread(WHOP_CFG);
  WHOP_KEY_CACHE = (cfg && cfg.key) || '';
  return WHOP_KEY_CACHE;
}
async function pushWhop(key, row, diag){
  const payload = {
    account_id: WHOP_ACCOUNT,
    event_name: 'purchase',
    event_time: new Date(row.created * 1000).toISOString(), // true purchase time (sweep sends up to 5 min later; retro sends up to 48h)
    event_id: row.id,            // Stripe payment id — unique per conversion
    value: row.value,
    currency: 'usd',
    action_source: 'website',
    user: {},
    context: {}
  };
  if(row.email) payload.user.email = row.email;
  Object.assign(payload.context, row.utm || {});
  const r = await fetch('https://api.whop.com/api/v1/events', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if(diag){
    diag.status = r.status;
    diag.body = String(await r.text().catch(() => '')).slice(0, 300);
  }
  return r.status >= 200 && r.status < 300;
}

/* ---- SMS activation drip helpers ---- */
function smsKey(){ return process.env.SIMPLETEXTING_API_KEY || ''; }
function normPhone(p){
  const d = String(p || '').replace(/\D/g, '');
  if(d.length === 10) return '1' + d;
  if(d.length >= 11 && d.length <= 15) return d;
  return '';
}
async function pushSms(phone, text, diag){
  const r = await fetch(ST_API, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + smsKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ contactPhone: phone, mode: 'AUTO', text })
  });
  const body = String(await r.text().catch(() => '')).slice(0, 300);
  if(diag){ diag.status = r.status; diag.body = body; }
  // a STOPped / blocked number comes back 4xx with an unsubscribe-flavoured message
  const optedOut = r.status >= 400 && r.status < 500 && /unsubscrib|opt.?out|blocked|blacklist/i.test(body);
  return { ok: r.status >= 200 && r.status < 300, optedOut, status: r.status };
}
/* the "Store completed" list id, resolved by name once per lambda */
let AC_COMPLETED_ID = null;
async function acCompletedList(){
  if(AC_COMPLETED_ID) return AC_COMPLETED_ID;
  try{
    const r = await fetch(AC.url + '/api/3/lists?limit=100', { headers: { 'Api-Token': AC.key } }).then(x => x.json());
    const hit = ((r && r.lists) || []).find(l => String(l.name || '').trim().toLowerCase() === AC_COMPLETED_LIST.toLowerCase());
    if(hit) AC_COMPLETED_ID = Number(hit.id);
  }catch(e){}
  return AC_COMPLETED_ID;
}
/* stop signal: the buyer's AC contact is an ACTIVE member of "Store completed" */
async function acCompleted(b){
  try{
    const h = { 'Api-Token': AC.key };
    const lid = await acCompletedList();
    if(!lid) return false; // list missing → never stop on it (probe shows this)
    let cid = b.ac;
    if(!cid){
      const f = await fetch(AC.url + '/api/3/contacts?email=' + encodeURIComponent(b.e || ''), { headers: h }).then(r => r.json());
      cid = f && f.contacts && f.contacts[0] ? f.contacts[0].id : '';
      if(cid) b.ac = cid;
    }
    if(!cid) return false;
    const m = await fetch(AC.url + '/api/3/contacts/' + cid + '/contactLists', { headers: h }).then(r => r.json());
    return ((m && m.contactLists) || []).some(x => String(x.list) === String(lid) && String(x.status) === '1');
  }catch(e){ return false; }
}
/* the buyer's consented phone + first name + activation link, from the AC contact */
async function acBuyer(email){
  const out = { phone: '', name: '', link: '', id: '' };
  if(!email) return out;
  try{
    const h = { 'Api-Token': AC.key };
    const f = await fetch(AC.url + '/api/3/contacts?email=' + encodeURIComponent(email), { headers: h }).then(r => r.json());
    const c = f && f.contacts && f.contacts[0];
    if(!c) return out;
    out.id = c.id;
    out.phone = normPhone(c.phone);
    out.name = String(c.firstName || '').trim().slice(0, 40);
    const fv = await fetch(AC.url + '/api/3/contacts/' + c.id + '/fieldValues', { headers: h }).then(r => r.json());
    const hit = ((fv && fv.fieldValues) || []).find(v => String(v.field) === String(AC.activationField) && v.value);
    if(hit) out.link = String(hit.value);
  }catch(e){}
  return out;
}
async function dsStatus(pid){
  try{
    const r = await fetch(DS_STATUS + encodeURIComponent(pid));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }catch(e){ return { error: String(e && e.message || e).slice(0, 120) }; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const ua = String(req.headers['user-agent'] || '');
  const isCron = /vercel-cron/i.test(ua);
  const isOwner = q.key === READ_KEY;
  if(!isCron && !isOwner) return res.status(403).json({ ok:false });

  try{
    if(q.probe === 'seturl' && isOwner){
      const url = String(q.url || '');
      if(!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url))
        return res.status(200).json({ ok:false, error:'bad_url', hint:'expected https://script.google.com/macros/s/…/exec' });
      await bwrite(CFG, { url, set: Date.now() });
      return res.status(200).json({ ok:true, stored:true });
    }
    if(q.probe === 'setwhop' && isOwner){
      const wk = String(q.wk || '');
      if(wk.length < 20) return res.status(200).json({ ok:false, error:'bad_whop_key' });
      await bwrite(WHOP_CFG, { key: wk, set: Date.now() });
      WHOP_KEY_CACHE = wk;
      return res.status(200).json({ ok:true, stored:true });
    }

    const cfg = await bread(CFG);
    const ledger = (await bread(LEDGER)) || { seen: {} };
    const wledger = (await bread(WHOP_LEDGER)) || { seen: {}, start: Math.floor(Date.now() / 1000) - 7200 };
    const wkey = await whopKey();

    if(q.ping === '1' && isOwner){
      return res.status(200).json({ ok:true, has_sheet_url: !!(cfg && cfg.url),
        has_whop_key: !!wkey,
        logged_orders: Object.keys(ledger.seen || {}).length,
        whop_sent: Object.keys(wledger.seen || {}).length,
        whop_start: wledger.start });
    }
    /* owner: SMS drip ledger summary */
    if(q.probe === 'drip' && isOwner){
      const d = (await bread(DRIP_LEDGER)) || { buyers: {} };
      const B = Object.values(d.buyers || {});
      const stops = {};
      for(const b of B) if(b.stop) stops[b.stop] = (stops[b.stop] || 0) + 1;
      const recentPids = (await collectOrders(Math.floor(Date.now() / 1000) - 48 * 3600))
        .filter(r => DRIP_TYPES.has(r.type) && r.pid).slice(-3).map(r => r.pid);
      const clid = await acCompletedList();
      return res.status(200).json({ ok:true, has_sms_key: !!smsKey(), start: d.start || null,
        stop_list: { name: AC_COMPLETED_LIST, ac_list_id: clid || null, resolved: !!clid },
        recent_pids: recentPids,
        enrolled: B.length, active: B.filter(b => !b.stop).length, stopped: stops,
        messages_sent: B.reduce((n, b) => n + ((b.sent || []).length), 0),
        recent: B.slice(-5).map(b => ({ cs_tail: '…' + String(b.cs || '').slice(-6), name: b.n || '', pid: b.pid || '',
          sent_steps: b.sent || [], stop: b.stop || null, enrolled_at: b.at ? new Date(b.at * 1000).toISOString() : null })) });
    }
    /* owner: send the step-0 copy to a number — proves key, host and copy */
    if(q.probe === 'driptest' && isOwner){
      if(!smsKey()) return res.status(200).json({ ok:false, error:'no_sms_key' });
      const to = normPhone(q.to);
      if(!to) return res.status(200).json({ ok:false, error:'bad_to', hint:'?to=1XXXXXXXXXX' });
      const diag = {};
      const r = await pushSms(to, dripText(0, String(q.name || '').slice(0, 40), 'https://sellproducts.ai/?resume=TEST'), diag);
      return res.status(200).json({ ok: r.ok, st_status: diag.status, st_body: diag.body });
    }
    /* owner: raw DropStart status for a store — to discover an activation flag */
    if(q.probe === 'dsstatus' && isOwner){
      const pid = String(q.pid || '').replace(/\D/g, '');
      if(!pid) return res.status(200).json({ ok:false, error:'bad_pid' });
      return res.status(200).json({ ok:true, pid, ds: await dsStatus(pid) });
    }
    /* owner: Whop-ad attribution stats — Stripe-truth count of waid-stamped orders */
    if(q.probe === 'whopstats' && isOwner){
      const hrs = Math.min(parseInt(q.hours, 10) || 24, 96);
      const rows2 = await collectOrders(Math.floor(Date.now() / 1000) - hrs * 3600);
      const hit = rows2.filter(r => r.utm && r.utm.waid);
      return res.status(200).json({ ok:true, window_hours: hrs,
        total_orders: rows2.length,
        total_revenue: rows2.reduce((s2, r) => s2 + r.value, 0),
        whop_attributed_orders: hit.length,
        whop_attributed_revenue: hit.reduce((s2, r) => s2 + r.value, 0),
        whop_events_sent_ledger: Object.keys(wledger.seen || {}).length,
        sample: hit.slice(0, 5).map(r => ({ amount: r.amount, source: r.source,
          waid_tail: '…' + String(r.utm.waid).slice(-6), created: new Date(r.created * 1000).toISOString() })) });
    }
    /* owner diagnostic: send one TEST lead event to Whop, report raw response */
    if(q.probe === 'whoptest' && isOwner){
      if(!wkey) return res.status(200).json({ ok:false, error:'no_whop_key' });
      const diag = {};
      const r = await fetch('https://api.whop.com/api/v1/events', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + wkey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: WHOP_ACCOUNT, event_name: 'lead',
          event_id: 'capi_test_' + Date.now(), action_source: 'website',
          user: { email: 'test@sellproducts.ai' }, context: {} })
      });
      return res.status(200).json({ ok: r.status >= 200 && r.status < 300,
        whop_status: r.status, whop_body: String(await r.text().catch(() => '')).slice(0, 300) });
    }
    /* owner diagnostic: plain GET to the script URL — distinguishes an access
       wall (Workspace restriction) from a POST/redirect problem */
    if(q.probe === 'getcheck' && isOwner){
      if(!cfg || !cfg.url) return res.status(200).json({ ok:false, error:'no_sheet_url' });
      const r = await fetch(cfg.url, { redirect: 'follow' });
      const body = String(await r.text().catch(() => '')).slice(0, 400);
      return res.status(200).json({ ok:true, google_status: r.status, google_body: body });
    }
    /* owner diagnostic: push one TEST row and report Google's raw response */
    if(q.probe === 'push' && isOwner){
      if(!cfg || !cfg.url) return res.status(200).json({ ok:false, error:'no_sheet_url' });
      const diag = {};
      const ok = await pushRow(cfg.url, { created: Math.floor(Date.now() / 1000),
        email: 'test@sellproducts.ai', product: 'TEST ROW — delete me',
        amount: '$0.00', source: 'diagnostic', id: 'test_' + Date.now() }, diag);
      return res.status(200).json({ ok, google_status: diag.status, google_body: diag.body });
    }

    if(!cfg || !cfg.url) return res.status(200).json({ ok:false, error:'no_sheet_url' });
    if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no_keys' });

    const backDays = isOwner && q.backfill ? Math.min(parseInt(q.backfill, 10) || 0, 120) : 0;
    const gte = Math.floor(Date.now() / 1000) - (backDays ? backDays * 86400 : 48 * 3600);

    const rows = await collectOrders(gte);

    // sink 1: Google Sheet — video orders only
    let pushed = 0, failed = 0;
    for(const row of rows){
      if(!TYPES.has(row.type)) continue;
      if(ledger.seen[row.id]) continue;
      const ok = await pushRow(cfg.url, row);
      if(ok){ ledger.seen[row.id] = row.created; pushed++; }
      else failed++; // stays unlogged → retried next sweep
    }
    // prune ledger entries older than 120 days
    const cutoff = Math.floor(Date.now() / 1000) - 120 * 86400;
    for(const id of Object.keys(ledger.seen)) if(ledger.seen[id] < cutoff) delete ledger.seen[id];
    if(pushed) await bwrite(LEDGER, ledger);

    // sink 2: Whop conversions — every purchase type, from the ledger's start
    let wsent = 0, wfailed = 0;
    if(wkey){
      for(const row of rows){
        if(row.created < (wledger.start || 0)) continue; // never resend history from before the integration
        if(!(row.value > 0)) continue;                    // Whop rejects value-less purchases
        if(wledger.seen[row.id]) continue;
        const ok = await pushWhop(wkey, row);
        if(ok){ wledger.seen[row.id] = row.created; wsent++; }
        else wfailed++; // retried next sweep
      }
      const wcut = Math.floor(Date.now() / 1000) - 14 * 86400; // dedupe horizon ≫ 48h scan window
      for(const id of Object.keys(wledger.seen)) if(wledger.seen[id] < wcut) delete wledger.seen[id];
      if(wsent || !wledger.written){ wledger.written = 1; await bwrite(WHOP_LEDGER, wledger); }
    }

    // sink 3: SMS activation drip — enroll new opted-in store buyers, send due steps
    let dEnrolled = 0, dSent = 0, dStopped = 0;
    if(smsKey()){
      const now = Math.floor(Date.now() / 1000);
      const d = (await bread(DRIP_LEDGER)) || { start: now - 600, buyers: {} };
      let dirty = !d.written;
      // enroll: $20 store sessions since the watermark, once each
      for(const row of rows){
        if(!DRIP_TYPES.has(row.type) || !/^cs_/.test(row.id)) continue;
        if(row.created < (d.start || 0) || d.buyers[row.id]) continue;
        if(now - row.created < 120) continue; // let the lead bridge land the phone on the AC contact first
        const b = await acBuyer(row.email);
        const rec = { cs: row.id, at: now, c: row.created, e: row.email, pid: row.pid || '', sent: [], stop: null };
        if(!b.phone){ rec.stop = 'no_consent'; }
        else{
          rec.p = b.phone; rec.n = b.name; rec.ac = b.id;
          rec.l = b.link || (row.pid ? 'https://sellproducts.ai/?resume=' + encodeURIComponent(row.pid) : 'https://www.sellproducts.ai/members');
        }
        d.buyers[row.id] = rec; dirty = true; dEnrolled++;
      }
      // send: one due step per active buyer per sweep (the latest due, never a burst)
      for(const cs of Object.keys(d.buyers)){
        const b = d.buyers[cs];
        if(b.stop) continue;
        let due = -1;
        for(let i = 0; i < DRIP_AT.length; i++) if(now >= b.c + DRIP_AT[i] && !b.sent.includes(i)) due = i;
        if(due < 0){
          if(b.sent.length >= DRIP_AT.length){ b.stop = 'completed'; dirty = true; dStopped++; }
          continue;
        }
        if(await acCompleted(b)){ b.stop = 'store_completed'; dirty = true; dStopped++; continue; }
        const r = await pushSms(b.p, dripText(due, b.n, b.l));
        if(r.ok){ b.sent.push(due); b.last = now; dirty = true; dSent++; }
        else if(r.optedOut){ b.stop = 'opted_out'; dirty = true; dStopped++; }
        else { b.fail = (b.fail || 0) + 1; dirty = true; if(b.fail >= 12){ b.stop = 'send_failed'; dStopped++; } }
        if(b.sent.length >= DRIP_AT.length){ b.stop = 'completed'; dStopped++; }
      }
      // prune buyers older than the schedule + a margin
      for(const cs of Object.keys(d.buyers)) if(d.buyers[cs].c < now - 20 * 86400){ delete d.buyers[cs]; dirty = true; }
      if(dirty){ d.written = 1; await bwrite(DRIP_LEDGER, d); }
    }

    return res.status(200).json({ ok:true, scanned: rows.length,
      sheet: { pushed, failed }, whop: { sent: wsent, failed: wfailed, enabled: !!wkey },
      drip: { enrolled: dEnrolled, sent: dSent, stopped: dStopped, enabled: !!smsKey() } });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 200) });
  }
};
