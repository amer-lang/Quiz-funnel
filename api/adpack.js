/* Sell Products AI — "10-Ad Pack" teaser image generator.
   Vercel serverless function at /api/adpack.

   Generates ONE premium pack-shot mockup per catalogue product (fanned deck
   of ad cards, gold "10-AD PACK" ribbon) with OpenAI gpt-image-1, using the
   product's real photo as reference, and stores it in Vercel Blob at a
   deterministic path (adpack/<slug>.webp). The Blob listing itself is the
   cache index — no external index service. Each product costs one
   generation, ever; every future buyer gets the CDN-cached image.

   GET ?product=<name>&warm=1   — ensure the pack shot exists (generates if
                                  missing, ~20-40s first time per product)
   GET ?product=<name>&fast=1   — report only, never generates (upsell UI)
   GET ?list=<READ_KEY>         — admin: catalogue + cache state
   GET ?warmall=<READ_KEY>&n=2  — admin: generate up to n missing per call

   Products are validated against the live DropStart catalogue so strangers
   can't burn generation credits. Requires OPENAI_API_KEY and a connected
   Vercel Blob store; degrades to {ready:false} so the funnel's built-in
   fallback shows. */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const DS_API = 'https://chat.dropstart.app/api/express';
const DS_KEY = 'ek_c70_42ceb3e0322b33b8fe9f339ded261337f584ed8a75f2918b';
const PENDING_TTL = 180000; // ms — ignore generating-markers older than this

const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function blobToken(){
  if(process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const k = Object.keys(process.env).find(key =>
    /READ_WRITE_TOKEN/i.test(key) && String(process.env[key]).startsWith('vercel_blob_rw'));
  return k ? process.env[k] : '';
}
/* new-style store connections inject BLOB_STORE_ID and the SDK auths via the
   deployment's OIDC identity — no token env var at all */
function blobReady(){ return !!(blobToken() || process.env.BLOB_STORE_ID); }
function blobOpts(extra){
  const t = blobToken();
  return t ? Object.assign({ token: t }, extra || {}) : (extra || {});
}

/* one Blob listing per request = the whole cache state */
async function packState(){
  const { list } = await import('@vercel/blob');
  const out = { packs: {}, pending: {} };
  let cursor;
  do{
    const page = await list(blobOpts({ prefix: 'adpack/', limit: 1000, cursor }));
    for(const b of page.blobs){
      const m = b.pathname.match(/^adpack\/\.pending-(.+)$/);
      if(m){ out.pending[m[1]] = new Date(b.uploadedAt).getTime(); continue; }
      const s = b.pathname.match(/^adpack\/(.+)\.webp$/);
      if(s) out.packs[s[1]] = b.url;
    }
    cursor = page.cursor;
  }while(cursor);
  return out;
}

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

const PROMPT = name => (
  'A premium 4:5 portrait product mockup for a dark-themed checkout page. A bundle of 10 ' +
  'social-media image ads presented as a luxury "ad pack": a fanned, overlapping stack of ' +
  'rounded-corner ad cards floating at a slight 3D angle, like a hand of premium trading cards. ' +
  'Every card is a polished Instagram/Facebook-style ad featuring the exact product from the ' +
  'reference image (' + name + '). The FRONT card is fully visible and crisp: the product hero ' +
  'photo on a clean bright studio backdrop, a bold "50% OFF" headline and a small white ' +
  '"SHOP NOW" pill button. Behind it, 5-6 more cards fan out at varied angles - each a visibly ' +
  'DIFFERENT ad design (one minimal white, one black-and-gold luxury, one bright red sale ' +
  'banner, one tall Instagram-story format) but partially hidden by the overlap, cropped by the ' +
  'frame edge, or softly out of focus - teasing the designs without revealing them. A thin gold ' +
  'ribbon wraps the stack near the bottom with clean text "10-AD PACK"; a small gold sparkle ' +
  'badge floats top right. Background: deep dark navy #0A1020 with a soft radial glow behind ' +
  'the cards blending electric blue #3B82F6 into emerald green #22C55E; faint golden dust ' +
  'particles; deep soft shadows; subtle rim light on card edges. Modern SaaS 3D mockup style, ' +
  'ultra-clean, glossy, highly detailed, zero clutter. The ONLY text anywhere: "50% OFF", ' +
  '"SHOP NOW", "10-AD PACK". No other words, no watermarks, no browser UI, no people.'
);

async function generate(name, imgUrl){
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
    fd.append('prompt', PROMPT(name));
    fd.append('size', '1024x1536');
    fd.append('quality', 'medium');
    fd.append('output_format', 'webp');
    fd.append('output_compression', '80');
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
      body: JSON.stringify({ model: 'gpt-image-1', prompt: PROMPT(name), size: '1024x1536',
        quality: 'medium', output_format: 'webp', output_compression: 80 })
    });
    out = await r.json();
    if(!r.ok || !out.data || !out.data[0] || !out.data[0].b64_json){
      return { error: 'gen_failed', detail: (out && out.error && out.error.message) || '' };
    }
  }
  return { b64: out.data[0].b64_json };
}

async function makePack(prod){
  const slug = slugOf(prod.label);
  const { put, del } = await import('@vercel/blob');
  await put('adpack/.pending-' + slug, String(Date.now()), blobOpts({
    access: 'private', contentType: 'text/plain', addRandomSuffix: false
  })).catch(() => {});
  const g = await generate(prod.label, prod.image_card || prod.image || '');
  if(g.error){
    del('adpack/.pending-' + slug, blobOpts()).catch(() => {});
    return g;
  }
  await put('adpack/' + slug + '.webp', Buffer.from(g.b64, 'base64'), blobOpts({
    access: 'private', contentType: 'image/webp',
    addRandomSuffix: false, cacheControlMaxAge: 31536000
  }));
  del('adpack/.pending-' + slug, blobOpts()).catch(() => {});
  return { url: '/api/adpack?serve=' + slug };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = req.query || {};

  try{
    /* serve a pack shot: stream the private blob through our own origin so
       buyers never depend on the store's URL signing. Edge-cached hard. */
    if(q.serve){
      const slug = slugOf(q.serve);
      try{
        const { head } = await import('@vercel/blob');
        const h = await head('adpack/' + slug + '.webp', blobOpts());
        const t = blobToken();
        let r = await fetch(h.downloadUrl || h.url, t ? { headers: { authorization: 'Bearer ' + t } } : undefined);
        if(!r.ok) r = await fetch(h.url, t ? { headers: { authorization: 'Bearer ' + t } } : undefined);
        if(!r.ok) return res.status(404).json({ ok:false, status: 'blob_fetch_' + r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable');
        return res.status(200).send(buf);
      }catch(e){
        return res.status(404).json({ ok:false });
      }
    }

    /* admin: catalogue + cache state */
    if(q.list){
      if(q.list !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
      const cat = await catalogue();
      const st = blobReady() ? await packState() : { packs:{} };
      return res.status(200).json({ ok:true, hasKey: !!process.env.OPENAI_API_KEY, hasBlob: blobReady(),
        // env KEY NAMES only (never values) — shows what the store connection injected
        envKeys: Object.keys(process.env).filter(k => /BLOB|READ_WRITE|STORE/i.test(k)),
        products: cat.map(p => ({ name: p.label, cached: !!st.packs[slugOf(p.label)],
          url: st.packs[slugOf(p.label)] ? '/api/adpack?serve=' + slugOf(p.label) : null })) });
    }

    /* admin: warm the whole catalogue, n generations per call */
    if(q.warmall){
      if(q.warmall !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
      if(!blobReady()) return res.status(200).json({ ok:false, status:'no_blob_store' });
      if(!process.env.OPENAI_API_KEY) return res.status(200).json({ ok:false, status:'no_key' });
      const n = Math.max(1, Math.min(3, parseInt(q.n || '2', 10) || 2));
      const cat = await catalogue();
      const st = await packState();
      const missing = cat.filter(p => !st.packs[slugOf(p.label)]);
      const done = [], failed = [];
      for(const prod of missing.slice(0, n)){
        const r = await makePack(prod);
        if(r.error) failed.push({ name: prod.label, error: r.error, detail: r.detail || '' });
        else done.push({ name: prod.label, url: r.url });
      }
      return res.status(200).json({ ok:true, generated: done, failed,
        remaining: Math.max(0, missing.length - done.length - failed.length) });
    }

    /* buyer-facing: status / warm */
    const name = String(q.product || '').slice(0, 120);
    if(!name) return res.status(400).json({ ready:false, status:'no_product' });
    if(!blobReady()) return res.status(200).json({ ready:false, status:'no_blob_store' });
    const slug = slugOf(name);

    const st = await packState();
    if(st.packs[slug]) return res.status(200).json({ ready:true, src: '/api/adpack?serve=' + slug });

    const pendingAt = st.pending[slug] || 0;
    if(q.fast === '1' || (pendingAt && Date.now() - pendingAt < PENDING_TTL)){
      return res.status(200).json({ ready:false, status: pendingAt ? 'generating' : 'missing' });
    }

    const cat = await catalogue();
    const prod = cat.find(p => slugOf(p.label) === slug);
    if(!prod) return res.status(404).json({ ready:false, status:'unknown_product' });
    if(!process.env.OPENAI_API_KEY) return res.status(200).json({ ready:false, status:'no_key' });

    const r = await makePack(prod);
    if(r.error) return res.status(200).json({ ready:false, status:r.error, detail:r.detail || '' });
    return res.status(200).json({ ready:true, src: r.url });
  }catch(e){
    return res.status(200).json({ ready:false, status:'error', detail: String(e && e.message || e).slice(0, 200) });
  }
};
