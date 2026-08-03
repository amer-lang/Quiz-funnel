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

const READ_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';
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
    'Minimal bright studio ad: the product hero-lit on a clean white-to-light-gray backdrop with a soft realistic shadow, generous negative space, a bold modern sans-serif headline "50% OFF" and a small black pill button reading "SHOP NOW".' },
  { size: '1024x1024', label: 'Black & Gold', style:
    'Luxury ad: the product on a deep matte-black backdrop with elegant gold rim lighting, thin gold frame lines in the corners, refined serif text "LIMITED EDITION" at the top and a small gold-outlined button reading "SHOP NOW".' },
  { size: '1024x1024', label: 'Flash Sale', style:
    'High-energy sale ad: the product popping off a vivid red-to-orange diagonal gradient, dynamic angled white banner shouting "FLASH SALE", a smaller badge reading "TODAY ONLY", bold drop shadows, energetic retail style.' },
  { size: '1024x1024', label: 'Brand Gradient', style:
    'Modern e-commerce ad: the product floating with a soft levitation shadow over a smooth electric-blue #3B82F6 to emerald-green #22C55E gradient, subtle glow behind the product, a clean white badge reading "FREE SHIPPING".' },
  { size: '1024x1024', label: 'Customer Favorite', style:
    'Social-proof ad: the product on a warm cream card-style background, a row of five gold stars above it, understated text "CUSTOMER FAVORITE" in tasteful small caps, soft shadows, trustworthy premium feel.' },
  { size: '1024x1024', label: 'Lifestyle', style:
    'Cozy lifestyle ad: the product staged naturally in a beautiful warmly-lit modern home interior scene (shelf, table or countertop that suits the product), golden-hour window light, a small white corner tag reading "NEW".' },
  { size: '1024x1536', label: 'Tonight Only', style:
    'Urgent story ad: the product spotlighted on deep dark navy with electric neon-blue glow accents, bold glowing headline "SALE ENDS TONIGHT" and a bright pill button reading "SHOP NOW" near the bottom, dramatic nighttime energy.' },
  { size: '1024x1536', label: 'Just Dropped', style:
    'Minimal pastel story ad: the product centered on a soft pastel backdrop with one simple geometric arch shape behind it, airy negative space, small refined text "JUST DROPPED" at the top, gentle studio shadow.' },
  { size: '1024x1536', label: 'Big Type', style:
    'Bold typographic story ad: oversized cropped "-50%" typography layered BEHIND the product in a high-contrast duotone palette, the product overlapping the letters, strong modern editorial design, small "SHOP NOW" button at the bottom.' },
  { size: '1024x1536', label: 'Perfect Gift', style:
    'Gift-theme story ad: the product presented like a premium gift with a subtle ribbon element and soft golden bokeh lights in the background, headline "THE PERFECT GIFT" in elegant type, warm celebratory mood, small "SHOP NOW" pill.' }
];

const PROMPT = (name, style) => (
  'A professional social-media image advertisement featuring the exact product from the reference image (' + name + '). ' +
  style + ' ' +
  'Photorealistic product rendering true to the reference, polished commercial retouching, crisp lighting, ' +
  'zero clutter, agency-quality composition. The ONLY text in the image is the short phrases specified above — ' +
  'no other words, no watermarks, no logos, no browser UI, no people.'
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

async function stripeSession(cs){
  const sk = process.env.STRIPE_SECRET_KEY || '';
  if(!sk) return null;
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(cs), {
    headers: { Authorization: 'Bearer ' + sk }
  });
  const s = await r.json().catch(() => ({}));
  return r.ok ? s : null;
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
    fd.append('quality', 'medium');
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
        quality: 'medium', output_format: 'webp', output_compression: 85 })
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
      if(!/^cs_/.test(cs)) return res.status(400).json({ ok:false, status:'no_cs' });
      key = keyOf(cs);
      authQS = 'cs=' + encodeURIComponent(cs);
      /* serve streams already-generated files: possessing the session id is the
         capability (the path key is derived from it), so skip the Stripe round
         trip. status/make hit Stripe every time — make spends real money. */
      if(q.serve === undefined){
        const s = await stripeSession(cs);
        const paid = s && s.payment_status === 'paid' && (s.metadata && s.metadata.type) === 'image_ads_10';
        if(!paid) return res.status(200).json({ ok:false, status:'not_paid' });
        product = (s.metadata && s.metadata.product) || '';
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
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable');
        if(q.dl === '1') res.setHeader('Content-Disposition', 'attachment; filename="ad-' + (i + 1) + '-' + slugOf(ADS[i].label) + '.webp"');
        return res.status(200).send(buf);
      }catch(e){
        return res.status(404).json({ ok:false });
      }
    }

    const st = await orderState(key);

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
