/* Sell Products AI — Arkansas back-liability report (last-12-months scan).
   Vercel serverless function at /api/artax. Owner-key-gated, read-only.

   Purpose: total FUNNEL sales delivered to Arkansas buyers, by Pacific
   month, so the owner can compute uncollected sales tax owed to AR for the
   period before Stripe Tax collection went live (2026-09-09).

   How AR is determined: the paid checkout session's billing address —
   state === 'AR', else ZIP prefix 716xx–729xx (Arkansas's exact range).
   One-click upsell PIs carry metadata[base_cs]; they attribute to AR when
   their base $20 session is AR (same buyer). Sessions with NO usable
   location are tallied separately as unknown so the estimate is honest.
   Only this funnel's SKU types count — the account also carries partner
   traffic that is not ours to remit.

   Day-partitioned exactly like /api/emailrev: each Pacific day is pulled
   with created[gte/lt], finished days cached forever in Blob
   (artax/d-YYYY-MM-DD.json). Warm the cache with repeated ?warm calls,
   then read the report.

   GET ?key=<READ_KEY>&warm=1&from=YYYY-MM-DD&to=YYYY-MM-DD
       computes uncached days in [from,to] until ~45s elapse;
       returns { computed, remaining } — call again until remaining=0.
   GET ?key=<READ_KEY>&report=1&from=YYYY-MM-DD&to=YYYY-MM-DD
       aggregates cached days by month (missing days listed, not computed). */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const MAX_PAGES = 40;
const SCHEMA = 1;
const TZ = 'America/Los_Angeles';
const FUNNEL_SES = new Set(['store_unlock20', 'store_unlock', 'image_ads_10', 'video_ads_5']);
const FUNNEL_PI = new Set(['image_ads_10', 'video_ads_5', 'video_ads_upsell', 'store_bump_unlimited', 'store_addons', 'store_unlock']);

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
const nextDayStartMs = d => dayStartMs(dayStr(dayStartMs(d) + 30 * 3600 * 1000));
function daysBetween(from, to){ // inclusive, oldest first
  const out = [];
  let d = from;
  for(let i = 0; i < 400 && d <= to; i++){
    out.push(d);
    d = dayStr(dayStartMs(d) + 30 * 3600 * 1000);
  }
  return out;
}

/* ---- WHOLE-ACCOUNT mode (&all=1): every succeeded CHARGE on the account,
   regardless of product or who created it (funnel, partner traffic,
   subscriptions). Charges carry billing_details.address directly and their
   own amount_refunded, so each day reduces to a tiny aggregate. ---- */
function arAddr(a){
  a = a || {};
  const st = String(a.state || '').trim().toUpperCase();
  if(st){
    if(st === 'AR' || st === 'ARKANSAS') return (a.country || 'US') === 'US' ? 'ar' : 'other';
    return 'other';
  }
  const zip = String(a.postal_code || '').trim().slice(0, 3);
  if(/^\d{3}$/.test(zip)){
    const z = parseInt(zip, 10);
    return (z >= 716 && z <= 729) ? 'ar' : 'other';
  }
  return 'unknown';
}

async function computeDayAll(day){
  const gte = Math.floor(dayStartMs(day) / 1000);
  const lt = Math.floor(nextDayStartMs(day) / 1000);
  const chR = await pageAll('charges?', gte, lt);
  const rec = { v: SCHEMA, day, truncated: chR.truncated,
    all_cnt: 0, all_cents: 0, ar_cnt: 0, ar_cents: 0, ar_ref_cents: 0,
    unk_cnt: 0, unk_cents: 0 };
  for(const c of chR.items){
    if(c.status !== 'succeeded' || !c.paid) continue;
    rec.all_cnt++; rec.all_cents += c.amount || 0;
    const loc = arAddr(c.billing_details && c.billing_details.address);
    if(loc === 'ar'){
      rec.ar_cnt++; rec.ar_cents += c.amount || 0;
      rec.ar_ref_cents += c.amount_refunded || 0;
    } else if(loc === 'unknown'){
      rec.unk_cnt++; rec.unk_cents += c.amount || 0;
    }
  }
  return rec;
}

async function readCachedAll(day){
  const k = 'all:' + day;
  if(dayMemo[k]) return dayMemo[k];
  try{
    const { head } = await import('@vercel/blob');
    const h = await head('artax/c-' + day + '.json', blobOpts());
    const rec = await bfetch(h.url).then(r => r.json());
    if(rec && rec.v === SCHEMA){ dayMemo[k] = rec; return rec; }
  }catch(e){}
  return null;
}

async function computeAndCacheAll(day){
  const rec = await computeDayAll(day);
  try{
    const { put } = await import('@vercel/blob');
    await put('artax/c-' + day + '.json', JSON.stringify(rec), blobOpts({
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json' }));
  }catch(e){}
  dayMemo['all:' + day] = rec;
  return rec;
}

/* Is this session's buyer in Arkansas? 'ar' yes · 'other' no · 'unknown' */
function arState(s){
  const a = (s.customer_details && s.customer_details.address) || {};
  const st = String(a.state || '').trim().toUpperCase();
  if(st){
    if(st === 'AR' || st === 'ARKANSAS') return (a.country || 'US') === 'US' ? 'ar' : 'other';
    return 'other';
  }
  const zip = String(a.postal_code || '').trim().slice(0, 3);
  if(/^\d{3}$/.test(zip)){
    const z = parseInt(zip, 10);
    if(z >= 716 && z <= 729) return 'ar';
    return 'other';
  }
  return 'unknown';
}

function distill(sessions, pis, refunds){
  const ar_ses = [], ar_base = [], ups = [], refs = [];
  let unknown_cnt = 0, unknown_cents = 0, funnel_ses = 0;
  for(const s of sessions){
    if(s.payment_status !== 'paid' || !s.metadata) continue;
    const ty = s.metadata.type;
    if(!FUNNEL_SES.has(ty)) continue;
    if((s.amount_total || 0) <= 0) continue;
    funnel_ses++;
    const loc = arState(s);
    if(loc === 'unknown'){ unknown_cnt++; unknown_cents += s.amount_total || 0; continue; }
    if(loc !== 'ar') continue;
    ar_ses.push({ cs: s.id, pi: typeof s.payment_intent === 'string' ? s.payment_intent : '',
      amt: s.amount_total || 0, ty,
      tax: (s.total_details && s.total_details.amount_tax) || 0 });
    ar_base.push(s.id);
  }
  for(const p of pis){
    if(p.status !== 'succeeded' || !p.metadata) continue;
    if(!p.metadata.base_cs) continue;
    if(!FUNNEL_PI.has(p.metadata.type || '')) continue;
    if((p.amount || 0) <= 0) continue;
    ups.push({ id: p.id, base: p.metadata.base_cs, amt: p.amount, ty: p.metadata.type });
  }
  for(const r of refunds){
    if(r.payment_intent) refs.push({ pi: r.payment_intent, amt: r.amount || 0 });
  }
  return { ar_ses, ar_base, ups, refs, funnel_ses, unknown_cnt, unknown_cents };
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

async function readCached(day){
  if(dayMemo[day]) return dayMemo[day];
  try{
    const { head } = await import('@vercel/blob');
    const h = await head('artax/d-' + day + '.json', blobOpts());
    const rec = await bfetch(h.url).then(r => r.json());
    if(rec && rec.v === SCHEMA){ dayMemo[day] = rec; return rec; }
  }catch(e){}
  return null;
}

async function computeAndCache(day){
  const rec = await computeDay(day);
  try{
    const { put } = await import('@vercel/blob');
    await put('artax/d-' + day + '.json', JSON.stringify(rec), blobOpts({
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json' }));
  }catch(e){}
  dayMemo[day] = rec;
  return rec;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if(q.key !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
  if(!process.env.STRIPE_SECRET_KEY)
    return res.status(200).json({ ok:false, error:'no stripe key' });
  const okDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if(!okDay(q.from) || !okDay(q.to) || q.from > q.to)
    return res.status(400).json({ ok:false, error:'need from/to as YYYY-MM-DD' });
  const days = daysBetween(q.from, q.to);

  try{
    const ALL = q.all === '1';
    if(q.warm){
      const t0 = Date.now();
      let computed = 0;
      const remaining = [];
      for(const d of days){
        if(ALL ? await readCachedAll(d) : await readCached(d)) continue;
        if(Date.now() - t0 > 45000){ remaining.push(d); continue; }
        await (ALL ? computeAndCacheAll(d) : computeAndCache(d));
        computed++;
      }
      return res.status(200).json({ ok:true, all: ALL, computed, remaining: remaining.length,
        next: remaining[0] || null });
    }

    if(q.report && ALL){
      const months = {};
      const m0 = () => ({ ar_charges: 0, ar_cents: 0, ar_refund_cents: 0,
        unknown_charges: 0, unknown_cents: 0, all_charges: 0, all_cents: 0 });
      const missing = [];
      for(const d of days){
        const rec = await readCachedAll(d);
        if(!rec){ missing.push(d); continue; }
        const m = months[d.slice(0, 7)] = months[d.slice(0, 7)] || m0();
        m.ar_charges += rec.ar_cnt; m.ar_cents += rec.ar_cents;
        m.ar_refund_cents += rec.ar_ref_cents;
        m.unknown_charges += rec.unk_cnt; m.unknown_cents += rec.unk_cents;
        m.all_charges += rec.all_cnt; m.all_cents += rec.all_cents;
      }
      const rows = Object.keys(months).sort().map(mo =>
        Object.assign({ month: mo, ar_net_cents: months[mo].ar_cents - months[mo].ar_refund_cents }, months[mo]));
      const tot = rows.reduce((t, r) => {
        for(const k of Object.keys(r)) if(k !== 'month') t[k] = (t[k] || 0) + r[k];
        return t;
      }, {});
      return res.status(200).json({ ok:true, scope:'whole-account (every succeeded charge)',
        tz: TZ, from: q.from, to: q.to, months: rows, totals: tot,
        days_missing: missing.length, first_missing: missing[0] || null,
        note: 'ar_net_cents = AR-billing-address charges minus their refunds, account-wide. Includes partner/non-funnel traffic. Tax owed = net × applicable AR rate for each product’s taxability — your tax pro’s call.' });
    }

    if(q.report){
      const months = {};
      const m0 = () => ({ ar_orders: 0, ar_store_cents: 0, ar_upsell_cents: 0,
        ar_refund_cents: 0, ar_stripe_collected_tax_cents: 0,
        unknown_location_orders: 0, unknown_location_cents: 0, funnel_orders: 0 });
      const arBases = new Set(), arPis = new Set();
      const missing = [];
      for(const d of days){ // oldest → newest: bases register before upsells/refunds
        const rec = await readCached(d);
        if(!rec){ missing.push(d); continue; }
        const mo = d.slice(0, 7);
        const m = months[mo] = months[mo] || m0();
        m.funnel_orders += rec.funnel_ses;
        m.unknown_location_orders += rec.unknown_cnt;
        m.unknown_location_cents += rec.unknown_cents;
        for(const s of rec.ar_ses){
          m.ar_orders++; m.ar_store_cents += s.amt;
          m.ar_stripe_collected_tax_cents += s.tax || 0;
          if(s.pi) arPis.add(s.pi);
        }
        (rec.ar_base || []).forEach(cs => arBases.add(cs));
        for(const u of rec.ups){
          if(!arBases.has(u.base)) continue;
          m.ar_upsell_cents += u.amt;
          arPis.add(u.id);
        }
        for(const r of rec.refs){
          if(arPis.has(r.pi)) m.ar_refund_cents += r.amt;
        }
      }
      const rows = Object.keys(months).sort().map(mo => {
        const m = months[mo];
        const net = m.ar_store_cents + m.ar_upsell_cents - m.ar_refund_cents;
        return Object.assign({ month: mo, ar_net_cents: net }, m);
      });
      const tot = rows.reduce((t, r) => ({
        ar_orders: t.ar_orders + r.ar_orders,
        ar_store_cents: t.ar_store_cents + r.ar_store_cents,
        ar_upsell_cents: t.ar_upsell_cents + r.ar_upsell_cents,
        ar_refund_cents: t.ar_refund_cents + r.ar_refund_cents,
        ar_net_cents: t.ar_net_cents + r.ar_net_cents,
        ar_stripe_collected_tax_cents: t.ar_stripe_collected_tax_cents + r.ar_stripe_collected_tax_cents,
        unknown_location_cents: t.unknown_location_cents + r.unknown_location_cents,
        funnel_orders: t.funnel_orders + r.funnel_orders
      }), { ar_orders: 0, ar_store_cents: 0, ar_upsell_cents: 0, ar_refund_cents: 0,
        ar_net_cents: 0, ar_stripe_collected_tax_cents: 0, unknown_location_cents: 0, funnel_orders: 0 });
      return res.status(200).json({ ok:true, tz: TZ, from: q.from, to: q.to,
        months: rows, totals: tot, days_missing: missing.length,
        first_missing: missing[0] || null,
        note: 'ar_net_cents = AR-destination funnel revenue net of refunds. Tax owed = net × the applicable AR rate for YOUR product taxability (6.5% state + local; destination locals vary — your tax pro applies exact rates). ar_stripe_collected_tax is what Stripe Tax already collected (post 2026-09-09) and auto-remits — exclude it from back-liability.' });
    }

    return res.status(400).json({ ok:false, error:'pass warm=1 or report=1' });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 300) });
  }
};
