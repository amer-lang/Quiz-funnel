/* Sell Products AI — Stripe-verified funnel money metrics.
   Vercel serverless function at /api/metrics.

   The event beacon (/api/collect) measures the JOURNEY but can undercount
   (ad blockers, dropped beacons, and one storage purge already). Money must
   never depend on it — this endpoint counts every sale straight from Stripe,
   the system that moved the money.

   GET ?key=<READ_KEY>&days=N   (N default 30, max 90)

   Sales shapes covered:
   - Checkout Sessions (paid): store_unlock20 ($20 unlock, incl. any legacy
     bump-in-session), image_ads_10 / video_ads_5 embedded fallbacks
   - PaymentIntents (succeeded, standalone one-clicks): image_ads_10,
     video_ads_5, store_bump_unlimited, store_addons (items split out)
   Session-backed PIs carry no metadata.type, so nothing double-counts.
   Refunds are totaled account-wide for the range (not per-SKU). */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const ADDON_PRICES = { seo_boost: 2900, unlimited_stores: 3900, profit_emails: 2900, video_ad_1: 3900 };
const MAX_PAGES = 8; // 8 x 100 objects per shape per range

let cache = null, cacheKey = '', cacheAt = 0;

async function sget(path){
  const sk = process.env.STRIPE_SECRET_KEY || '';
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + sk }
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

async function pageAll(base, gte){
  const out = [];
  let after = '';
  for(let p = 0; p < MAX_PAGES; p++){
    const j = await sget(base + '&limit=100&created[gte]=' + gte + (after ? '&starting_after=' + after : ''));
    const data = (j && j.data) || [];
    out.push(...data);
    if(!j.has_more || !data.length) break;
    after = data[data.length - 1].id;
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if(q.key !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
  if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no stripe key' });

  try{
    const days = Math.min(90, Math.max(1, parseInt(q.days, 10) || 30));
    const ck = 'd' + days;
    if(cache && cacheKey === ck && Date.now() - cacheAt < 120000) return res.status(200).json(cache);
    const gte = Math.floor((Date.now() - days * 864e5) / 1000);

    const [sessions, pis, refunds] = await Promise.all([
      pageAll('checkout/sessions?', gte),
      pageAll('payment_intents?', gte),
      pageAll('refunds?', gte)
    ]);

    const zero = () => ({ count: 0, gross: 0 });
    const m = { unlock20: zero(), ads49: zero(), video299: zero(),
      seo29: zero(), emails29: zero(), video1_39: zero(), unlimited39: zero() };
    const add = (b, cents) => { b.count++; b.gross += cents; };

    for(const s of sessions){
      if(s.payment_status !== 'paid' || !s.metadata) continue;
      const ty = s.metadata.type;
      if(ty === 'store_unlock20'){
        add(m.unlock20, 2000);
        // legacy in-checkout bump rode the same session as a 2nd line item
        if(s.metadata.bump === 'unlimited_stores' && (s.amount_total || 0) > 2000)
          add(m.unlimited39, (s.amount_total || 0) - 2000);
      }
      else if(ty === 'image_ads_10') add(m.ads49, s.amount_total || 4900);
      else if(ty === 'video_ads_5') add(m.video299, s.amount_total || 29900);
    }

    for(const p of pis){
      if(p.status !== 'succeeded' || !p.metadata) continue;
      const ty = p.metadata.type;
      if(ty === 'image_ads_10') add(m.ads49, p.amount || 4900);
      else if(ty === 'video_ads_5') add(m.video299, p.amount || 29900);
      else if(ty === 'store_bump_unlimited') add(m.unlimited39, p.amount || 3900);
      else if(ty === 'store_addons'){
        const items = String(p.metadata.items || '').split(',').map(x => x.trim()).filter(Boolean);
        for(const it of items){
          const cents = ADDON_PRICES[it] || 0;
          if(it === 'seo_boost') add(m.seo29, cents);
          else if(it === 'profit_emails') add(m.emails29, cents);
          else if(it === 'video_ad_1') add(m.video1_39, cents);
          else if(it === 'unlimited_stores') add(m.unlimited39, cents);
        }
      }
    }

    const gross = Object.values(m).reduce((s, b) => s + b.gross, 0);
    const refunded = refunds.reduce((s, r) => s + (r.amount || 0), 0);

    const out = {
      ok: true, days, source: 'stripe', generated_at: new Date().toISOString(),
      money: {
        unlock20:   { count: m.unlock20.count,   gross: m.unlock20.gross / 100 },
        ads49:      { count: m.ads49.count,      gross: m.ads49.gross / 100 },
        seo29:      { count: m.seo29.count,      gross: m.seo29.gross / 100 },
        emails29:   { count: m.emails29.count,   gross: m.emails29.gross / 100 },
        video1_39:  { count: m.video1_39.count,  gross: m.video1_39.gross / 100 },
        unlimited39:{ count: m.unlimited39.count,gross: m.unlimited39.gross / 100 },
        video299:   { count: m.video299.count,   gross: m.video299.gross / 100 },
        gross: gross / 100,
        refunds: { count: refunds.length, amount: refunded / 100 },
        net: (gross - refunded) / 100,
        aov: m.unlock20.count ? Math.round((gross / 100) / m.unlock20.count * 100) / 100 : 0
      },
      note: 'Counts and revenue read directly from Stripe (sessions + one-click charges, deduped by metadata shape). Refunds are account-wide for the range, not per-SKU.'
    };
    cache = out; cacheKey = ck; cacheAt = Date.now();
    return res.status(200).json(out);
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 200) });
  }
};
