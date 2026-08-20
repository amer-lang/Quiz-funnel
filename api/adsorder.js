/* Sell Products AI — $49 order fulfillment: generates the buyer's 10 REAL
   image ads (6 feed squares + 4 story portraits) from their product's photo
   with OpenAI gpt-image-1, and stores them in Vercel Blob under a key derived
   from their PAID $49 checkout session. The /ads delivery page drives this.

   GET ?cs=<upsell_cs>&status=1      — verify paid → per-ad ready/src map
   GET ?cs=<upsell_cs>&make=1[&i=N]  — verify paid → generate one missing ad
   GET ?cs=<upsell_cs>&serve=N[&dl=1]— stream ad N (dl adds attachment header)
   GET ?demo=<READ_KEY>&product=<x>  — key-gated test lane (same routes, no
                                       Stripe check, path adsorder/demo-<slug>/)

   Paid sessions are verified directly with Stripe: payment_status=paid AND
   metadata.type=image_ads_10 (only /api/upsell49 creates those). The blob
   path key is sha256(cs) so possession of the session id IS the capability.
   Env: STRIPE_SECRET_KEY, OPENAI_API_KEY + connected Blob store. */

const crypto = require('crypto');

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const DS_API = 'https://chat.dropstart.app/api/express';
const DS_KEY = 'ek_c70_42ceb3e0322b33b8fe9f339ded261337f584ed8a75f2918b';
const TOTAL = 10;
const PENDING_TTL = 180000; // ms — ignore generating-markers older than this

const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const keyOf = cs => crypto.createHash('sha256').update('adsorder:' + cs).digest('hex').slice(0, 24);

function blobToken(){
  if(process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find(key =>
    /READ_WRITE_TOKEN/i.test(key) && String(process.env[key]).startsWith('vercel_blob_rw'));
  return k ? process.env[k] : '';
}
function blobReady(){ return !!(blobToken() || process.env.BLOB_STORE_ID); }
function blobOpts(extra){
  const t = blobToken();
  return t ? Object.assign({ token: t }, extra || {}) : (extra || {});
}

/* The ten deliverable designs. Each is a complete, distinct ad concept; the
   buyer's product photo is passed as the reference image for all of them. */
const ADS = [
  { size: '1024x1024', label: 'Clean Studio', style:
    'Premium white-studio hero shot. Background: seamless white sweeping to very light gray #F3F4F6. The product is the star at about 60% of frame height, positioned right-of-center on the rule of thirds, lit by a large soft key light with a crisp natural contact shadow and a faint floor reflection. In the upper-left negative space, the headline "50% OFF" in a very bold modern geometric sans-serif, near-black #111111, on two stacked lines. Below the headline, a solid black rounded pill button with white text "SHOP NOW". Balanced, expensive, Apple-ad-level restraint.' },
  { size: '1024x1024', label: 'Black & Gold', style:
    'Luxury editorial ad. Background: deep matte black #0A0A0A with a subtle radial vignette. The product centered, sculpted by warm golden rim light along both edges, standing on a glossy black surface with a soft gold-tinted reflection. A thin elegant gold hairline rectangle frames the composition, inset well inside the canvas so it is fully visible. Top-center inside the frame: "LIMITED EDITION" in refined letterspaced gold serif capitals. Bottom-center: a slim gold-outlined pill button "SHOP NOW". Faint golden dust particles in the dark background. Quiet, expensive, dramatic.' },
  { size: '1024x1024', label: 'Flash Sale', style:
    'High-energy retail sale ad. Background: vivid red #E11D48 to orange #F97316 diagonal gradient with subtle radial burst rays. The product pops forward sticker-style with a clean bold white outline and a hard offset drop shadow, tilted 5 degrees for energy. Across the upper third, a slightly angled solid-white banner with huge red block letters "FLASH SALE". Near it a small yellow starburst badge with black text "TODAY ONLY". A few tiny confetti flecks. Loud, urgent, but professionally art-directed — zero clutter.' },
  { size: '1024x1024', label: 'Brand Gradient', style:
    'Modern DTC brand ad. Background: smooth 135-degree gradient from electric blue #3B82F6 to emerald green #22C55E. The product floats weightlessly at center with a soft glowing halo behind it and a gentle levitation shadow far below. Bottom-center: a clean white rounded badge with dark text "FREE SHIPPING". Minimal, glossy, futuristic e-commerce aesthetic with generous breathing room around the product.' },
  { size: '1024x1024', label: 'Customer Favorite', style:
    'Warm social-proof ad. Background: soft cream #F7F3EC with a subtle large rounded-card feel. Centered composition: a neat horizontal row of five glossy gold five-pointed stars above the product, and beneath the product the words "CUSTOMER FAVORITE" in tasteful small-caps charcoal lettering with wide letterspacing. Soft warm daylight, gentle realistic shadow. Calm, trustworthy, premium boutique feel.' },
  { size: '1024x1024', label: 'Lifestyle', style:
    'Editorial lifestyle photograph. The product staged naturally in a beautiful bright modern home setting that genuinely suits it (kitchen counter, desk, shelf or nightstand), styled with two or three tasteful real props, golden-hour sunlight streaming from a window with soft shadows, shallow depth of field with a creamy background blur. In one upper corner, a small clean white rectangular tag with black text "NEW". Looks shot for a premium interiors magazine.' },
  { size: '1024x1536', label: 'Tonight Only', style:
    'Urgent nighttime story ad. Background: deep dark navy #0B1120. A theatrical spotlight cone shines down on the product at center, with an electric neon-blue glow ring on the floor beneath it and soft blue ambient haze. In the upper third: the glowing headline "SALE ENDS TONIGHT" in bold condensed uppercase with a neon-blue outer glow, split across two lines. In the lower area: a bright solid blue pill button with white text "SHOP NOW". Cinematic, dramatic, midnight-drop energy.' },
  { size: '1024x1536', label: 'Just Dropped', style:
    'Minimal pastel story ad. Background: soft sage or blush pastel with ONE simple tall geometric arch shape in a slightly deeper tone directly behind the product. The product rests on a low matte pedestal at center with a soft studio shadow. Top-center: "JUST DROPPED" in refined dark small-caps with wide letterspacing. Enormous airy negative space, gallery-like calm, high-end minimalist design.' },
  { size: '1024x1536', label: 'Big Type', style:
    'Bold editorial typography story ad in a striking two-color duotone. The oversized text "-50%" is set in ultra-heavy type filling the middle of the composition, with the ENTIRE text fully visible — every character complete with clear space around it, nothing running past any edge. The product stands in front, overlapping the lower half of the letters, creating crisp depth. High-contrast palette (for example off-white background, ink-black type). At the bottom-center: a small solid chip button "SHOP NOW". Fashion-magazine layout discipline.' },
  { size: '1024x1536', label: 'Perfect Gift', style:
    'Premium gift story ad. The product presented on a soft elevated surface beside an elegant curl of satin ribbon (next to the product, never covering it), against a warm dark background filled with soft golden bokeh lights. Top area: "THE PERFECT GIFT" in elegant cream serif capitals on two lines. Bottom: a small warm-gold pill button "SHOP NOW". Rich, celebratory, holiday-luxury mood.' }
];

const PROMPT = (name, style) => (
  'Design a premium social-media advertisement image. ' +
  'THE PRODUCT — reproduce the product from the attached reference photo with EXACT fidelity: identical shape, proportions, colors, materials, buttons, ports, labels and any screens or control panels. Never redraw, restyle or decorate the product. Never add icons, symbols, graphics or text onto the product or its display — if the product has a screen or panel, it must look exactly as it does in the reference. The result must read as the same physical item professionally re-photographed for an ad. Product: ' + name + '. ' +
  'THE AD — ' + style + ' ' +
  'HARD RULES — (1) SAFE MARGINS: every text element, badge, button, frame and the product itself must sit fully inside the canvas with at least 10% padding from every edge; nothing may touch, bleed past, or be cut off by any edge of the image. (2) TEXT: render ONLY the short phrases quoted above, spelled EXACTLY as written, in genuinely professional typography — no other words anywhere. (3) QUALITY: photorealistic commercial product photography with flawless retouching, controlled lighting and agency-grade composition. (4) NEVER include watermarks, third-party logos, browser or app UI, people, or clutter.'
);

let catCache = null, catAt = 0;
async function catalogue(){
  if(catCache && Date.now() - catAt < 600000) return catCache;
  const r = await fetch(DS_API + '/trending', { headers: { 'X-Express-Key': DS_KEY } });
  if(!r.ok) throw new Error('catalogue ' + r.status);
  const j = await r.json();
  catCache = ((j && j.products) || []).filter(p => p && p.label);
  catAt = Date.now();
  return catCache;
}

/* the $49 order id is a Checkout Session (cs_…) from the fallback popup or a
   PaymentIntent (pi_…) from the one-click charge — verify whichever it is */
async function paidOrder(id){
  const sk = process.env.STRIPE_SECRET_KEY || '';
  if(!sk) return null;
  const path = /^pi_/.test(id) ? 'payment_intents/' : 'checkout/sessions/';
  const r = await fetch('https://api.stripe.com/v1/' + path + encodeURIComponent(id), {
    headers: { Authorization: 'Bearer ' + sk }
  });
  const s = await r.json().catch(() => ({}));
  if(!r.ok) return null;
  const paid = /^pi_/.test(id) ? s.status === 'succeeded' : s.payment_status === 'paid';
  if(!(paid && (s.metadata && s.metadata.type) === 'image_ads_10')) return null;
  return { product: (s.metadata && s.metadata.product) || '' };
}

/* one Blob listing per request = full order state */
async function orderState(key){
  const { list } = await import('@vercel/blob');
  const out = { ads: {}, pending: {} };
  let cursor;
  do{
    const page = await list(blobOpts({ prefix: 'adsorder/' + key + '/', limit: 1000, cursor }));
    for(const b of page.blobs){
      const m = b.pathname.match(/\/\.pending-(\d+)$/);
      if(m){ out.pending[m[1]] = new Date(b.uploadedAt).getTime(); continue; }
      const s = b.pathname.match(/\/ad-(\d+)\.webp$/);
      if(s) out.ads[s[1]] = b.url;
    }
    cursor = page.cursor;
  }while(cursor);
  return out;
}

async function generate(name, spec, imgUrl){
  const key = process.env.OPENAI_API_KEY;
  if(!key) return { error: 'no_key' };

  let out;
  const imgRes = imgUrl ? await fetch(imgUrl).catch(() => null) : null;
  if(imgRes && imgRes.ok){
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ct = imgRes.headers.get('content-type') || 'image/png';
    const fd = new FormData();
    fd.append('model', 'gpt-image-1');
    fd.append('image', new Blob([buf], { type: ct }), 'product.' + (ct.includes('webp') ? 'webp' : ct.includes('jpeg') ? 'jpg' : 'png'));
    fd.append('prompt', PROMPT(name, spec.style));
    fd.append('size', spec.size);
    fd.append('quality', 'high');
    fd.append('output_format', 'webp');
    fd.append('output_compression', '85');
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd
    });
    out = await r.json();
    if(!r.ok) out = null;
  }
  if(!out || !out.data || !out.data[0] || !out.data[0].b64_json){
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt: PROMPT(name, spec.style), size: spec.size,
        quality: 'high', output_format: 'webp', output_compression: 85 })
    });
    out = await r.json();
    if(!r.ok || !out.data || !out.data[0] || !out.data[0].b64_json){
      return { error: 'gen_failed', detail: (out && out.error && out.error.message) || '' };
    }
  }
  return { b64: out.data[0].b64_json };
}

async function makeAd(key, name, i, imgUrl){
  const { put, del } = await import('@vercel/blob');
  const base = 'adsorder/' + key + '/';
  await put(base + '.pending-' + i, String(Date.now()), blobOpts({
    access: 'private', contentType: 'text/plain', addRandomSuffix: false
  })).catch(() => {});
  const g = await generate(name, ADS[i], imgUrl);
  if(g.error){
    del(base + '.pending-' + i, blobOpts()).catch(() => {});
    return g;
  }
  await put(base + 'ad-' + i + '.webp', Buffer.from(g.b64, 'base64'), blobOpts({
    access: 'private', contentType: 'image/webp',
    addRandomSuffix: false, cacheControlMaxAge: 31536000
  }));
  del(base + '.pending-' + i, blobOpts()).catch(() => {});
  return { ok: true };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  const q = req.query || {};

  try{
    if(!blobReady()) return res.status(200).json({ ok:false, status:'no_blob_store' });

    /* ---- key-gated heal sweep: after an OpenAI outage, find every recent
       ad-pack order with missing images and regenerate them server-side
       (parallel self-calls, one image each). Re-run until healed:0. ---- */
    if(q.heal){
      if(q.heal !== READ_KEY) return res.status(403).json({ ok:false });
      const sk = process.env.STRIPE_SECRET_KEY || '';
      if(!sk || !process.env.OPENAI_API_KEY) return res.status(200).json({ ok:false, status:'no_keys' });
      const days = Math.min(7, Math.max(1, parseInt(q.days, 10) || 3));
      const gte = Math.floor(Date.now() / 1000) - days * 86400;
      const sget = p => fetch('https://api.stripe.com/v1/' + p, { headers: { Authorization: 'Bearer ' + sk } })
        .then(r => r.json()).catch(() => ({}));
      const page2 = async base => {
        const out = []; let after = '';
        for(let p = 0; p < 6; p++){
          const j = await sget(base + '&limit=100&created[gte]=' + gte + (after ? '&starting_after=' + after : ''));
          const data = (j && j.data) || [];
          out.push(...data);
          if(!j.has_more || !data.length) break;
          after = data[data.length - 1].id;
        }
        return out;
      };
      const [pis, sessions] = await Promise.all([page2('payment_intents?'), page2('checkout/sessions?')]);
      const orders = [];
      for(const p of pis) if(p.status === 'succeeded' && p.metadata && p.metadata.type === 'image_ads_10') orders.push(p.id);
      for(const s of sessions) if(s.payment_status === 'paid' && s.metadata && s.metadata.type === 'image_ads_10') orders.push(s.id);

      const report = [], tasks = [];
      for(const id of orders){
        const st2 = await orderState(keyOf(id));
        const missing = [];
        for(let i = 0; i < TOTAL; i++)
          if(!st2.ads[i] && !(st2.pending[i] && Date.now() - st2.pending[i] < PENDING_TTL)) missing.push(i);
        if(missing.length) report.push({ order: id.slice(0, 14) + '…', missing: missing.length });
        for(const i of missing) tasks.push({ id, i });
      }
      if(q.dry === '1') return res.status(200).json({ ok: true, dry: true, days,
        orders_scanned: orders.length, incomplete_orders: report, images_missing: tasks.length });

      const batch = tasks.slice(0, 14); // parallel lambdas, one image each
      const results = await Promise.all(batch.map(t =>
        fetch('https://www.sellproducts.ai/api/adsorder?cs=' + encodeURIComponent(t.id) + '&make=1&i=' + t.i)
          .then(r => r.json()).catch(() => ({ ok: false }))));
      const made = results.filter(r => r && r.ok).length;

      /* email packs regenerate on page-load; warm the most recent ones too */
      let emailsWarmed = 0;
      if(q.emails !== '0'){
        const epis = pis.filter(p => p.status === 'succeeded' && p.metadata &&
          p.metadata.type === 'store_addons' && String(p.metadata.items || '').includes('profit_emails')).slice(0, 2);
        for(const p of epis){
          try{ const j = await fetch('https://www.sellproducts.ai/api/emailpack?cs=' + p.id).then(r => r.json());
            if(j && j.ready) emailsWarmed++; }catch(e){}
        }
      }

      return res.status(200).json({ ok: true, days, orders_scanned: orders.length,
        incomplete_orders: report, images_missing: tasks.length,
        kicked_this_run: batch.length, generated_ok: made, email_packs_warmed: emailsWarmed,
        note: tasks.length > batch.length || made < batch.length
          ? 'Not finished — run this same URL again until images_missing is 0.'
          : 'All caught up.' });
    }

    /* ---- resolve the order: demo lane (key-gated) or a paid $49 session ---- */
    let key, product = '', authQS;
    if(q.demo){
      if(q.demo !== READ_KEY) return res.status(403).json({ ok:false });
      product = String(q.product || '').slice(0, 120);
      if(!product) return res.status(400).json({ ok:false, status:'no_product' });
      key = 'demo-' + slugOf(product);
      authQS = 'demo=' + q.demo + '&product=' + encodeURIComponent(product);
    }else{
      const cs = String(q.cs || '').slice(0, 300);
      if(!/^(cs|pi)_/.test(cs)) return res.status(400).json({ ok:false, status:'no_cs' });
      key = keyOf(cs);
      authQS = 'cs=' + encodeURIComponent(cs);
      /* serve streams already-generated files: possessing the order id is the
         capability (the path key is derived from it), so skip the Stripe round
         trip. status/make hit Stripe every time — make spends real money. */
      if(q.serve === undefined){
        const o = await paidOrder(cs);
        if(!o) return res.status(200).json({ ok:false, status:'not_paid' });
        product = o.product;
      }
    }

    /* ---- serve ad N ---- */
    if(q.serve !== undefined){
      const i = parseInt(q.serve, 10);
      if(!(i >= 0 && i < TOTAL)) return res.status(400).json({ ok:false });
      try{
        const { head } = await import('@vercel/blob');
        const h = await head('adsorder/' + key + '/ad-' + i + '.webp', blobOpts());
        const t = blobToken();
        let r = await fetch(h.downloadUrl || h.url, t ? { headers: { authorization: 'Bearer ' + t } } : undefined);
        if(!r.ok) r = await fetch(h.url, t ? { headers: { authorization: 'Bearer ' + t } } : undefined);
        if(!r.ok) return res.status(404).json({ ok:false });
        const buf = Buffer.from(await r.arrayBuffer());
        if(q.b64 === '1'){ // QA: text-safe payload for tooling that mangles binary
          res.setHeader('Content-Type', 'text/plain');
          return res.status(200).send(buf.toString('base64'));
        }
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable');
        if(q.dl === '1') res.setHeader('Content-Disposition', 'attachment; filename="ad-' + (i + 1) + '-' + slugOf(ADS[i].label) + '.webp"');
        return res.status(200).send(buf);
      }catch(e){
        return res.status(404).json({ ok:false });
      }
    }

    const st = await orderState(key);

    /* ---- key-gated: wipe an order's cached ads so they regenerate under
       the current (upgraded) prompts on the buyer's next /ads visit ---- */
    if(q.redo){
      if(q.redo !== READ_KEY) return res.status(403).json({ ok:false });
      const { del } = await import('@vercel/blob');
      const base = 'adsorder/' + key + '/';
      const targets = Object.keys(st.ads).map(i => base + 'ad-' + i + '.webp')
        .concat(Object.keys(st.pending).map(i => base + '.pending-' + i));
      for(const t of targets) await del(t, blobOpts()).catch(() => {});
      return res.status(200).json({ ok:true, cleared: targets.length,
        note: 'open /ads?cs=<order> (or hit &make=1 repeatedly) to regenerate with the new prompts' });
    }

    /* ---- status ---- */
    if(q.status === '1'){
      const ads = ADS.map((a, i) => ({
        i, label: a.label, format: a.size === '1024x1024' ? 'feed' : 'story',
        ready: !!st.ads[i],
        src: st.ads[i] ? '/api/adsorder?' + authQS + '&serve=' + i : null,
        generating: !st.ads[i] && !!st.pending[i] && Date.now() - st.pending[i] < PENDING_TTL
      }));
      return res.status(200).json({ ok:true, product, total: TOTAL,
        done: ads.filter(a => a.ready).length, ads });
    }

    /* ---- make one missing ad ---- */
    if(q.make === '1'){
      if(!process.env.OPENAI_API_KEY) return res.status(200).json({ ok:false, status:'no_key' });
      let i = q.i !== undefined ? parseInt(q.i, 10) : NaN;
      if(!(i >= 0 && i < TOTAL)){
        i = ADS.findIndex((a, n) =>
          !st.ads[n] && !(st.pending[n] && Date.now() - st.pending[n] < PENDING_TTL));
      }
      if(i < 0 || st.ads[i]) return res.status(200).json({ ok:true, done:true,
        made: Object.keys(st.ads).length });
      if(st.pending[i] && Date.now() - st.pending[i] < PENDING_TTL)
        return res.status(200).json({ ok:true, status:'generating', i });

      /* reference photo: the catalogue product whose name matches */
      let img = '';
      try{
        const cat = await catalogue();
        const p = cat.find(c => slugOf(c.label) === slugOf(product));
        if(p) img = p.image_card || p.image || '';
      }catch(e){ /* generate without reference */ }

      const r = await makeAd(key, product || 'the product', i, img);
      if(r.error) return res.status(200).json({ ok:false, status:r.error, detail:r.detail || '', i });
      return res.status(200).json({ ok:true, i, src: '/api/adsorder?' + authQS + '&serve=' + i });
    }

    return res.status(400).json({ ok:false, status:'bad_request' });
  }catch(e){
    return res.status(200).json({ ok:false, status:'error', detail: String(e && e.message || e).slice(0, 300) });
  }
};
