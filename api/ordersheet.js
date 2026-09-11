/* Sell Products AI — video-order → Google Sheet sweep (/api/ordersheet).
   Every 5 minutes (Vercel Cron) this scans Stripe for newly PAID five-video
   orders (type video_ads_5 — the $199 VSL one-click, its checkout fallback,
   and the $299 members checkout) and appends each new one to the owner's
   Google Sheet through a Google Apps Script web-app hook. Server-side and
   ledgered, so orders are never missed or double-logged.

   GET  (cron or ?key=READ_KEY)                → sweep the last 48h
   GET  ?key=READ_KEY&backfill=30              → sweep the last N days (seed run)
   GET  ?probe=seturl&key=READ_KEY&url=...     → store the Apps Script URL
   GET  ?ping=1&key=READ_KEY                   → config + ledger sanity

   Sheet columns (row 1 headers, set by hand):
   Date (PT) | Email | Product | Amount | Source | Order ID */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const SHEET_SECRET = '789b6ab8689b124208d9bf20e12e7bbf'; // must match the Apps Script
const TYPES = new Set(['video_ads_5']);
const LEDGER = 'orders/videolog.json';
const CFG = 'members/config/ordersheet.json';

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

/* the buyer's email: session → customer_details; one-click PI → its base session */
const EMAIL_MEMO = new Map();
async function baseEmail(baseCs){
  if(!baseCs) return '';
  if(EMAIL_MEMO.has(baseCs)) return EMAIL_MEMO.get(baseCs);
  try{
    const s = await sget('checkout/sessions/' + encodeURIComponent(baseCs));
    const e = (s.customer_details && s.customer_details.email) || '';
    EMAIL_MEMO.set(baseCs, e);
    return e;
  }catch(err){ return ''; }
}

async function collectOrders(gteSec){
  const rows = [];
  // one-click PaymentIntents ($199 funnel + legacy $299)
  const pis = await pageAll('payment_intents?', gteSec, 5);
  for(const p of pis){
    if(p.status !== 'succeeded') continue;
    if(!TYPES.has((p.metadata && p.metadata.type) || '')) continue;
    rows.push({
      id: p.id, created: p.created,
      email: p.receipt_email || await baseEmail(p.metadata.base_cs) || '',
      product: (p.metadata && p.metadata.product) || '',
      amount: '$' + (p.amount / 100).toFixed(2),
      source: p.amount === 29900 ? '$299 one-click' : '$199 VSL one-click',
      base_cs: (p.metadata && p.metadata.base_cs) || ''
    });
  }
  // checkout sessions (fallback + members-area $299)
  const sess = await pageAll('checkout/sessions?', gteSec, 5);
  for(const s of sess){
    if(s.payment_status !== 'paid') continue;
    if(!TYPES.has((s.metadata && s.metadata.type) || '')) continue;
    rows.push({
      id: s.id, created: s.created,
      email: (s.customer_details && s.customer_details.email) || await baseEmail(s.metadata.base_cs) || '',
      product: (s.metadata && s.metadata.product) || '',
      amount: '$' + ((s.amount_total || 0) / 100).toFixed(2),
      source: (s.amount_total || 0) === 29900 ? '$299 checkout' : '$199 checkout',
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

    const cfg = await bread(CFG);
    const ledger = (await bread(LEDGER)) || { seen: {} };

    if(q.ping === '1' && isOwner){
      return res.status(200).json({ ok:true, has_sheet_url: !!(cfg && cfg.url),
        logged_orders: Object.keys(ledger.seen || {}).length });
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
    let pushed = 0, failed = 0;
    for(const row of rows){
      if(ledger.seen[row.id]) continue;
      const ok = await pushRow(cfg.url, row);
      if(ok){ ledger.seen[row.id] = row.created; pushed++; }
      else failed++; // stays unlogged → retried next sweep
    }
    // prune ledger entries older than 120 days
    const cutoff = Math.floor(Date.now() / 1000) - 120 * 86400;
    for(const id of Object.keys(ledger.seen)) if(ledger.seen[id] < cutoff) delete ledger.seen[id];
    if(pushed) await bwrite(LEDGER, ledger);

    return res.status(200).json({ ok:true, scanned: rows.length, pushed, failed });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 200) });
  }
};
