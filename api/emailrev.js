/* Sell Products AI — email-marketing revenue attribution (copywriter commission).
   Vercel serverless function at /api/emailrev.

   HOW ATTRIBUTION WORKS (all figures straight from Stripe, never the beacon):
   - Email links carry ?utm_source=email&utm_campaign=<slug>. The funnel stores
     the last click for 7 days and sends it with the $20 claim; /api/unlock20
     stamps it into the Checkout Session metadata.
   - A PAID store_unlock20 session with metadata utm_source='email' is an
     attributed order (last click wins).
   - Every upsell charge (bump $39, ads $49, addons, $299 video — one-click PI
     or fallback checkout session) already stamps metadata[base_cs] = that $20
     session, so follow-on revenue joins to the same campaign automatically.
   - Refunds are matched by payment_intent against attributed charges and
     subtracted. Commission = 5% of the NET.

   Day-partitioned like /api/metrics (this account is busy — one big range
   pull truncates): each Pacific day is pulled with created[gte/lt], finished
   days cached forever in Vercel Blob (emailrev/d-YYYY-MM-DD.json), today live.
   A 14-day lookback before the window keeps upsell/refund joins correct for
   purchases that happened just before the window opened.

   GET ?key=<EMAILREV_KEY|READ_KEY>&days=N   (N default 30, max 90)
   GET ?key=<READ_KEY>&rebuild=YYYY-MM-DD    force-recompute one cached day */

const EMAILREV_KEY = '4df5f90b15564978972ac6f045a80606185d699a7001ec6811dc79d344fc3df7';
const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const RATE = 0.05;        // copywriter commission on net attributed revenue
const LOOKBACK = 14;      // days of pre-window purchases kept for joins
const MAX_PAGES = 40;
const SCHEMA = 1;
const TZ = 'America/Los_Angeles';

let todayCache = null, todayCacheAt = 0;
const dayMemo = {};

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
function bfetch(url){
  return fetch(url, { headers: { Authorization: 'Bearer ' + blobToken() } });
}

async function sget(path){
  const sk = process.env.STRIPE_SECRET_KEY || '';
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + sk }
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

async function pageAll(base, gte, lt){
  const out = [];
  let after = '';
  for(let p = 0; p < MAX_PAGES; p++){
    const j = await sget(base + '&limit=100&created[gte]=' + gte + '&created[lt]=' + lt +
      (after ? '&starting_after=' + after : ''));
    const data = (j && j.data) || [];
    out.push(...data);
    if(!j.has_more || !data.length) return { items: out, truncated: false };
    after = data[data.length - 1].id;
  }
  return { items: out, truncated: true };
}

const dayStr = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
function dayStartMs(d){
  for(const off of ['-07:00', '-08:00']){
    const e = Date.parse(d + 'T00:00:00' + off);
    if(dayStr(e) === d && dayStr(e - 1) !== d) return e;
  }
  return Date.parse(d + 'T00:00:00-08:00');
}
const prevDay = d => dayStr(dayStartMs(d) - 1);
const nextDayStartMs = d => dayStartMs(dayStr(dayStartMs(d) + 30 * 3600 * 1000));
function lastNDays(n){
  const list = [dayStr(Date.now())];
  for(let i = 1; i < n; i++) list.push(prevDay(list[i - 1]));
  return list;
}

/* One day's attribution-relevant rows (small — a fraction of the day's objects). */
function distill(sessions, pis, refunds){
  const ses = [], ups = [], refs = [];
  for(const s of sessions){
    if(s.payment_status !== 'paid' || !s.metadata) continue;
    if(s.metadata.type === 'store_unlock20' && s.metadata.utm_source){
      ses.push({ cs: s.id, pi: typeof s.payment_intent === 'string' ? s.payment_intent : '',
        amt: s.amount_total || 0, src: s.metadata.utm_source,
        camp: s.metadata.utm_campaign || '(no campaign)' });
    }else if(s.metadata.base_cs && (s.amount_total || 0) > 0){
      // upsell that fell back to its own checkout session (its PI has no metadata)
      ups.push({ id: typeof s.payment_intent === 'string' ? s.payment_intent : s.id,
        base: s.metadata.base_cs, amt: s.amount_total || 0, ty: s.metadata.type || 'session' });
    }
  }
  for(const p of pis){
    if(p.status !== 'succeeded' || !p.metadata || !p.metadata.base_cs) continue;
    if((p.amount || 0) <= 0) continue;
    ups.push({ id: p.id, base: p.metadata.base_cs, amt: p.amount, ty: p.metadata.type || 'pi' });
  }
  for(const r of refunds){
    if(r.payment_intent) refs.push({ pi: r.payment_intent, amt: r.amount || 0 });
  }
  return { ses, ups, refs };
}

async function computeDay(day){
  const gte = Math.floor(dayStartMs(day) / 1000);
  const lt = Math.floor(nextDayStartMs(day) / 1000);
  const [sesR, piR, refR] = await Promise.all([
    pageAll('checkout/sessions?', gte, lt),
    pageAll('payment_intents?', gte, lt),
    pageAll('refunds?', gte, lt)
  ]);
  const rec = distill(sesR.items, piR.items, refR.items);
  rec.v = SCHEMA;
  rec.day = day;
  rec.truncated = sesR.truncated || piR.truncated || refR.truncated;
  return rec;
}

async function cachedDay(day, force){
  if(!force && dayMemo[day]) return dayMemo[day];
  const path = 'emailrev/d-' + day + '.json';
  if(!force){
    try{
      const { head } = await import('@vercel/blob');
      const h = await head(path, blobOpts());
      const rec = await bfetch(h.url).then(r => r.json());
      if(rec && rec.v === SCHEMA){ dayMemo[day] = rec; return rec; }
    }catch(e){}
  }
  const rec = await computeDay(day);
  try{
    const { put } = await import('@vercel/blob');
    await put(path, JSON.stringify(rec), blobOpts({
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json' }));
  }catch(e){}
  dayMemo[day] = rec;
  return rec;
}

async function liveToday(){
  if(todayCache && todayCache.day === dayStr(Date.now()) && Date.now() - todayCacheAt < 120000)
    return todayCache;
  const rec = await computeDay(dayStr(Date.now()));
  todayCache = rec; todayCacheAt = Date.now();
  return rec;
}

async function pool(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while(i < items.length){ const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if(q.key !== EMAILREV_KEY && q.key !== READ_KEY)
    return res.status(403).json({ ok:false, error:'bad key' });
  if(!process.env.STRIPE_SECRET_KEY)
    return res.status(200).json({ ok:false, error:'no stripe key' });

  try{
    /* ?diag=1&day=YYYY-MM-DD — fresh Stripe truth for one Pacific day, no
       caches. Shows whether utm-stamped paid sessions exist at all, plus a
       comparison against the cached day record to expose stale caches. */
    if(q.diag){
      const day = /^\d{4}-\d{2}-\d{2}$/.test(q.day || '') ? q.day : dayStr(Date.now());
      const gte = Math.floor(dayStartMs(day) / 1000);
      const lt = Math.floor(nextDayStartMs(day) / 1000);
      const [sesR, piR] = await Promise.all([
        pageAll('checkout/sessions?', gte, lt),
        pageAll('payment_intents?', gte, lt)
      ]);
      const paid20 = sesR.items.filter(s => s.payment_status === 'paid' && s.metadata && s.metadata.type === 'store_unlock20');
      const withUtm = paid20.filter(s => s.metadata.utm_source);
      const anyUtm = sesR.items.filter(s => s.metadata && s.metadata.utm_source);
      const srcs = {}, camps = {};
      for(const s of anyUtm){
        srcs[s.metadata.utm_source] = (srcs[s.metadata.utm_source] || 0) + 1;
        const c = s.metadata.utm_campaign || '(none)';
        camps[c] = camps[c] || { sessions: 0, paid: 0, cents: 0 };
        camps[c].sessions++;
        if(s.payment_status === 'paid'){ camps[c].paid++; camps[c].cents += s.amount_total || 0; }
      }
      let cached = null;
      try{
        const { head } = await import('@vercel/blob');
        const h = await head('emailrev/d-' + day + '.json', blobOpts());
        const rec = await bfetch(h.url).then(r => r.json());
        cached = { v: rec.v, ses: (rec.ses || []).length, ups: (rec.ups || []).length };
      }catch(e){ cached = 'none'; }
      return res.status(200).json({ ok:true, day,
        sessions_total: sesR.items.length, truncated: sesR.truncated || piR.truncated,
        unlock20_paid: paid20.length,
        unlock20_paid_with_utm: withUtm.length,
        sessions_with_utm_any_status: anyUtm.length,
        utm_sources: srcs, utm_campaigns: camps,
        upsell_pis_with_base: piR.items.filter(p => p.status === 'succeeded' && p.metadata && p.metadata.base_cs).length,
        cached_record: cached });
    }

    if(q.rebuild && /^\d{4}-\d{2}-\d{2}$/.test(q.rebuild)){
      if(q.key !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
      delete dayMemo[q.rebuild];
      const rec = await cachedDay(q.rebuild, true);
      return res.status(200).json({ ok:true, rebuilt: q.rebuild,
        sessions: rec.ses.length, upsells: rec.ups.length, truncated: rec.truncated });
    }

    const n = Math.min(Math.max(parseInt(q.days, 10) || 30, 1), 90);
    const srcFilter = String(q.src || 'email').toLowerCase(); // 'all' disables the filter
    const allDays = lastNDays(n + LOOKBACK);      // [0]=today … oldest last
    const windowSet = new Set(allDays.slice(0, n));

    const recs = await pool(allDays.slice(1), 6, d => cachedDay(d));
    const byDay = { [allDays[0]]: await liveToday() };
    allDays.slice(1).forEach((d, i) => byDay[d] = recs[i]);

    /* one pass, oldest → newest: purchases register before their upsells and
       refunds, so plain map lookups are chronologically safe */
    const csMap = {};   // attributed $20 session → campaign
    const piMap = {};   // every attributed charge's PI → campaign (for refunds)
    const days = [];    // window rows, oldest first
    const camps = {};
    const camp0 = () => ({ orders: 0, gross: 0, upsell: 0, refunds: 0 });
    const missing = [];

    for(let i = allDays.length - 1; i >= 0; i--){
      const d = allDays[i];
      const rec = byDay[d];
      if(!rec){ missing.push(d); continue; }
      const inWin = windowSet.has(d);
      const row = { day: d, orders: 0, gross: 0, upsell: 0, refunds: 0 };
      for(const s of rec.ses){
        if(srcFilter !== 'all' && s.src !== srcFilter) continue;
        csMap[s.cs] = s.camp;
        if(s.pi) piMap[s.pi] = s.camp;
        if(!inWin) continue;
        row.orders++; row.gross += s.amt;
        (camps[s.camp] = camps[s.camp] || camp0()).orders++;
        camps[s.camp].gross += s.amt;
      }
      for(const u of rec.ups){
        const camp = csMap[u.base];
        if(camp === undefined) continue;
        piMap[u.id] = camp;
        if(!inWin) continue;
        row.upsell += u.amt;
        (camps[camp] = camps[camp] || camp0()).upsell += u.amt;
      }
      for(const r of rec.refs){
        const camp = piMap[r.pi];
        if(camp === undefined || !inWin) continue;
        row.refunds += r.amt;
        (camps[camp] = camps[camp] || camp0()).refunds += r.amt;
      }
      if(inWin) days.push(row);
    }

    const fin = o => {
      o.net = o.gross + o.upsell - o.refunds;
      o.commission = Math.round(o.net * RATE);
      return o;
    };
    days.forEach(fin);
    Object.values(camps).forEach(fin);
    const totals = fin(days.reduce((t, r) => ({
      orders: t.orders + r.orders, gross: t.gross + r.gross,
      upsell: t.upsell + r.upsell, refunds: t.refunds + r.refunds
    }), { orders: 0, gross: 0, upsell: 0, refunds: 0 }));

    return res.status(200).json({ ok:true, tz: TZ, rate: RATE, days_window: n,
      src: srcFilter, totals, days: days.reverse(), campaigns: camps,
      days_missing: missing, generated_at: new Date().toISOString() });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 300) });
  }
};
