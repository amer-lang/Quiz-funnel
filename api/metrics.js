/* Sell Products AI — Stripe-verified funnel money metrics.
   Vercel serverless function at /api/metrics.

   The event beacon (/api/collect) measures the JOURNEY but can undercount
   (ad blockers, dropped beacons). Money must never depend on it — this
   endpoint counts every sale straight from Stripe.

   v3: DAY-PARTITIONED. The account does thousands of Stripe objects per
   month (it also carries DropStart's traffic), so one big range pull hits
   pagination caps and silently truncates — that shipped wrong numbers once.
   Now each UTC day is pulled with created[gte]+created[lt] (a few hundred
   objects — never near any cap), finished days are cached forever in Vercel
   Blob (metrics/d-YYYY-MM-DD.json), and only today is recomputed live.

   GET ?key=<READ_KEY>&days=N            (N default 30, max 90)
   GET ?key=<READ_KEY>&days=N&audit=1    raw classification breakdown (N<=10)
   GET ?key=<READ_KEY>&rebuild=YYYY-MM-DD  force-recompute one cached day

   Sales shapes covered:
   - Checkout Sessions (paid): store_unlock20, image_ads_10, video_ads_5,
     legacy store_unlock ($1 era)
   - PaymentIntents (succeeded, standalone one-clicks): image_ads_10,
     video_ads_5, video_ads_upsell ($299 VSL), store_bump_unlimited,
     store_addons (items split out), legacy store_unlock
   Session-backed PIs carry no metadata.type, so nothing double-counts.
   Refunds are matched to this funnel's own PaymentIntents in the range. */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const ADDON_PRICES = { seo_boost: 2900, unlimited_stores: 3900, profit_emails: 2900, video_ad_1: 3900 };
const MAX_PAGES = 40;   // per shape PER DAY — 4,000 objects/day headroom
const SCHEMA = 4;       // bump to invalidate cached day records (v4 = Pacific days)
const TZ = 'America/Los_Angeles'; // all day boundaries cut at Pacific midnight

const BUCKETS = ['unlock20','ads49','seo29','emails29','video1_39','unlimited39','video299','legacy1'];

let todayCache = null, todayCacheAt = 0;       // live today record, 2-min TTL
const dayMemo = {};                            // past days are immutable

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

const dayStr = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD in Pacific
function dayStartMs(d){
  // Pacific midnight is UTC-7 (PDT) or UTC-8 (PST) — pick whichever offset
  // actually lands on 00:00 of day d (DST-safe, no library needed)
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

function classify(sessions, pis, refunds){
  const zero = () => ({ count: 0, gross: 0 });
  const m = {}; BUCKETS.forEach(b => m[b] = zero());
  const add = (b, cents) => { b.count++; b.gross += cents; };
  const ourPis = [];

  for(const s of sessions){
    if(s.payment_status !== 'paid' || !s.metadata) continue;
    const ty = s.metadata.type;
    if(ty !== 'store_unlock20' && ty !== 'image_ads_10' && ty !== 'video_ads_5' && ty !== 'store_unlock') continue;
    if(s.payment_intent) ourPis.push(s.payment_intent);
    const amt = s.amount_total || 0;
    if(ty === 'store_unlock20'){
      if(amt > 0) add(m.unlock20, Math.min(amt, 2000)); // real charge, not an assumed $20
      // legacy in-checkout bump rode the same session as a 2nd line item
      if(s.metadata.bump === 'unlimited_stores' && amt > 2000) add(m.unlimited39, amt - 2000);
    }
    else if(ty === 'image_ads_10') add(m.ads49, amt || 4900);
    else if(ty === 'video_ads_5') add(m.video299, amt || 29900);
    else if(ty === 'store_unlock'){ if(amt > 0) add(m.legacy1, amt); }
  }

  for(const p of pis){
    if(p.status !== 'succeeded' || !p.metadata) continue;
    const ty = p.metadata.type;
    if(ty === 'image_ads_10') add(m.ads49, p.amount || 4900);
    else if(ty === 'video_ads_5' || ty === 'video_ads_upsell') add(m.video299, p.amount || 29900);
    else if(ty === 'store_bump_unlimited') add(m.unlimited39, p.amount || 3900);
    else if(ty === 'store_unlock'){ if((p.amount || 0) > 0) add(m.legacy1, p.amount); }
    else if(ty === 'store_addons'){
      const items = String(p.metadata.items || '').split(',').map(x => x.trim()).filter(Boolean);
      for(const it of items){
        const cents = ADDON_PRICES[it] || 0;
        if(it === 'seo_boost') add(m.seo29, cents);
        else if(it === 'profit_emails') add(m.emails29, cents);
        else if(it === 'video_ad_1') add(m.video1_39, cents);
        else if(it === 'unlimited_stores') add(m.unlimited39, cents);
      }
    } else continue;
    ourPis.push(p.id);
  }

  return {
    m, ourPis,
    refunds: refunds.map(r => ({ pi: r.payment_intent || '', amount: r.amount || 0 })),
    sessions: sessions.length, pis: pis.length
  };
}

async function computeDay(day){
  const gte = Math.floor(dayStartMs(day) / 1000);
  const lt = Math.floor(nextDayStartMs(day) / 1000); // DST days are 23/25h — never assume 86400
  const [sesR, piR, refR] = await Promise.all([
    pageAll('checkout/sessions?', gte, lt),
    pageAll('payment_intents?', gte, lt),
    pageAll('refunds?', gte, lt)
  ]);
  const rec = classify(sesR.items, piR.items, refR.items);
  rec.v = SCHEMA;
  rec.day = day;
  rec.truncated = sesR.truncated || piR.truncated || refR.truncated;
  return rec;
}

async function cachedDay(day, force){
  if(!force && dayMemo[day]) return dayMemo[day];
  const path = 'metrics/d-' + day + '.json';
  if(!force){
    try{
      const { head } = await import('@vercel/blob');
      const h = await head(path, blobOpts());
      const rec = await bfetch(h.url).then(r => r.json());
      if(rec && rec.v === SCHEMA){ dayMemo[day] = rec; return rec; }
    }catch(e){} // not cached yet (or stale schema) — compute below
  }
  const rec = await computeDay(day);
  try{
    const { put } = await import('@vercel/blob');
    await put(path, JSON.stringify(rec), blobOpts({
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json' }));
  }catch(e){} // cache write failure must not break the response
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

/* small concurrency pool so 90 uncached days don't fire at once */
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
  if(q.key !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
  if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no stripe key' });

  try{
    if(q.rebuild && /^\d{4}-\d{2}-\d{2}$/.test(q.rebuild)){
      delete dayMemo[q.rebuild];
      const rec = await cachedDay(q.rebuild, true);
      return res.status(200).json({ ok: true, rebuilt: q.rebuild,
        sessions: rec.sessions, pis: rec.pis, truncated: rec.truncated });
    }

    /* ?window=1&from=<epoch-sec>&to=<epoch-sec> — raw $20-sale count in any
       window, straight from Stripe. For same-time-of-day pace comparisons. */
    if(q.window){
      const from = parseInt(q.from, 10), to = parseInt(q.to, 10);
      if(!from || !to || to <= from || to - from > 3 * 86400)
        return res.status(400).json({ ok:false, error:'bad window (max 3 days)' });
      const r = await pageAll('checkout/sessions?', from, to);
      let n = 0, gross = 0;
      for(const s of r.items){
        if(s.payment_status === 'paid' && s.metadata && s.metadata.type === 'store_unlock20'){
          n++; gross += s.amount_total || 0;
        }
      }
      return res.status(200).json({ ok:true, from, to, unlock20: n, gross: gross / 100, truncated: r.truncated });
    }

    /* ?daily=N — per-day breakdown straight from the day caches */
    if(q.daily){
      const n = Math.min(90, Math.max(1, parseInt(q.daily, 10) || 14));
      const list = lastNDays(n);
      const recs = await Promise.all([liveToday()].concat(
        list.slice(1).map(d => cachedDay(d).catch(() => null))));
      const rows = recs.map((r, i) => {
        if(!r) return { day: list[i], error: 'load failed' };
        const row = { day: list[i] };
        for(const b of BUCKETS) row[b] = { count: r.m[b].count, gross: r.m[b].gross / 100 };
        return row;
      });
      return res.status(200).json({ ok: true, days: n, tz: TZ, rows });
    }

    if(q.audit){
      const days = Math.min(10, Math.max(1, parseInt(q.days, 10) || 3));
      const gte = Math.floor((Date.now() - days * 864e5) / 1000);
      const lt = Math.floor(Date.now() / 1000) + 300;
      const [sesR, piR, refR] = await Promise.all([
        pageAll('checkout/sessions?', gte, lt),
        pageAll('payment_intents?', gte, lt),
        pageAll('refunds?', gte, lt)
      ]);
      const day = t => dayStr(t * 1000);
      const A = { ok: true, days, tz: TZ,
        truncated: { sessions: sesR.truncated, payment_intents: piR.truncated, refunds: refR.truncated },
        fetched: { sessions: sesR.items.length, payment_intents: piR.items.length, refunds: refR.items.length },
        sessions_by_type: {}, unlock20_amounts: {}, unlock20_by_day: {}, pis_by_type: {}, addon_items: {} };
      for(const s of sesR.items){
        if(s.payment_status !== 'paid') continue;
        const ty = (s.metadata && s.metadata.type) || '(none)';
        A.sessions_by_type[ty] = (A.sessions_by_type[ty] || 0) + 1;
        if(ty === 'store_unlock20'){
          const amt = String(s.amount_total == null ? 'null' : s.amount_total);
          A.unlock20_amounts[amt] = (A.unlock20_amounts[amt] || 0) + 1;
          A.unlock20_by_day[day(s.created)] = (A.unlock20_by_day[day(s.created)] || 0) + 1;
        }
      }
      for(const p of piR.items){
        if(p.status !== 'succeeded') continue;
        const ty = (p.metadata && p.metadata.type) || '(none)';
        A.pis_by_type[ty] = (A.pis_by_type[ty] || 0) + 1;
        if(ty === 'store_addons'){
          const items = String(p.metadata.items || '');
          A.addon_items[items] = (A.addon_items[items] || 0) + 1;
        }
      }
      return res.status(200).json(A);
    }

    const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || 30));
    const pastDays = lastNDays(days).slice(1);

    const [todayRec, pastRecs] = await Promise.all([
      liveToday(),
      pool(pastDays, 8, d => cachedDay(d).catch(() => null))
    ]);
    const recs = [todayRec].concat(pastRecs.filter(Boolean));
    const missing = pastRecs.filter(r => !r).length;

    const zero = () => ({ count: 0, gross: 0 });
    const m = {}; BUCKETS.forEach(b => m[b] = zero());
    const ourPis = new Set();
    let allRefunds = [], truncatedDays = [];
    for(const r of recs){
      for(const b of BUCKETS){ if(r.m[b]){ m[b].count += r.m[b].count; m[b].gross += r.m[b].gross; } }
      for(const pi of r.ourPis || []) ourPis.add(pi);
      allRefunds = allRefunds.concat(r.refunds || []);
      if(r.truncated) truncatedDays.push(r.day);
    }

    const gross = BUCKETS.reduce((s, b) => s + m[b].gross, 0);
    /* This Stripe account also carries non-funnel activity (legacy SKUs,
       DropStart's own charges), so refunds are split: "ours" are refunds whose
       payment_intent matches one of this funnel's sales in the range. */
    const ourRefunds = allRefunds.filter(r => r.pi && ourPis.has(r.pi));
    const refunded = ourRefunds.reduce((s, r) => s + r.amount, 0);
    const refundedAll = allRefunds.reduce((s, r) => s + r.amount, 0);

    const B = b => ({ count: m[b].count, gross: m[b].gross / 100 });
    const out = {
      ok: true, days, source: 'stripe', generated_at: new Date().toISOString(),
      days_missing: missing, truncated_days: truncatedDays,
      money: {
        unlock20: B('unlock20'), ads49: B('ads49'), seo29: B('seo29'),
        emails29: B('emails29'), video1_39: B('video1_39'),
        unlimited39: B('unlimited39'), video299: B('video299'), legacy1: B('legacy1'),
        gross: gross / 100,
        refunds: { count: ourRefunds.length, amount: refunded / 100 },
        refunds_account: { count: allRefunds.length, amount: refundedAll / 100 },
        net: (gross - refunded) / 100,
        aov: m.unlock20.count ? Math.round((gross / 100) / m.unlock20.count * 100) / 100 : 0
      },
      tz: TZ,
      note: 'Read straight from Stripe, one Pacific-time day at a time (immune to pagination caps). Finished days are cached; today is live. Refunds are matched to this funnel\'s own sales; refunds_account is the whole Stripe account incl. legacy/DropStart activity.'
    };
    return res.status(200).json(out);
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 200) });
  }
};
