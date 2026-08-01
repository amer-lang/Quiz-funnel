/* Sell Products AI — "10-Ad Pack" teaser image generator.
   Vercel serverless function at /api/adpack.

   Generates ONE premium pack-shot mockup per catalogue product (the fanned
   deck of ad cards with a gold "10-AD PACK" ribbon) using OpenAI gpt-image-1
   with the product's real photo as the reference, then caches it forever in
   jsonblob storage. Every future buyer of that product gets the cached image
   instantly — each product costs one generation, ever.

   GET ?product=<name>&warm=1     — ensure the pack shot exists (generate if
                                    missing; ~20-40s on first call per product)
   GET ?product=<name>&fast=1     — report only, never generates (upsell UI)
   GET ?serve=<slug>              — serve the cached image (immutable cache)
   GET ?init=<READ_KEY>           — one-time: create the index blob

   Products are validated against the live DropStart catalogue, so strangers
   can't burn generation credits on made-up names. Requires OPENAI_API_KEY in
   the environment; until it's set every response is {ready:false,
   status:'no_key'} and the funnel shows its built-in fallback. */

const JB = 'https://jsonblob.com/api/jsonBlob';
const READ_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';
const INDEX_ID = '019fbc07-ee55-7e05-b141-00d139a13064';

const DS_API = 'https://chat.dropstart.app/api/express';
const DS_KEY = 'ek_c70_42ceb3e0322b33b8fe9f339ded261337f584ed8a75f2918b';

const PENDING_TTL = 150000; // ms — treat older "generating" marks as stale

async function jbGet(id){
  const r = await fetch(JB + '/' + id, { headers: { Accept: 'application/json' } });
  if(!r.ok) throw new Error('jb get ' + r.status);
  return r.json();
}
async function jbPut(id, data){
  const r = await fetch(JB + '/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  if(!r.ok) throw new Error('jb put ' + r.status);
}
async function jbCreate(data){
  const r = await fetch(JB, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(data)
  });
  if(!r.ok) throw new Error('jb create ' + r.status);
  const id = (r.headers.get('location') || '').split('/').pop();
  if(!id) throw new Error('jb create: no id');
  return id;
}

const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/* live catalogue (per-instance cache, 10 min) — the allow-list */
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
    // reference-based: the pack shot shows THEIR product
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
    // no usable reference image — generate from the description alone
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const q = req.query || {};

  try{
    /* one-time init */
    if(q.init){
      if(q.init !== READ_KEY) return res.status(403).json({ ok:false, error:'bad key' });
      if(INDEX_ID) return res.status(200).json({ ok:true, index: INDEX_ID, note:'already set' });
      const id = await jbCreate({ packs:{}, pending:{} });
      return res.status(200).json({ ok:true, index:id, note:'paste into INDEX_ID and redeploy' });
    }

    if(!INDEX_ID) return res.status(200).json({ ready:false, status:'not_initialized' });

    /* serve a cached pack shot */
    if(q.serve){
      const idx = await jbGet(INDEX_ID);
      const rec = idx.packs && idx.packs[slugOf(q.serve)];
      if(!rec || !rec.blob) return res.status(404).json({ ok:false });
      const img = await jbGet(rec.blob);
      if(!img || !img.b64) return res.status(404).json({ ok:false });
      res.setHeader('Content-Type', img.ct || 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      return res.status(200).send(Buffer.from(img.b64, 'base64'));
    }

    /* status / generation */
    const name = String(q.product || '').slice(0, 120);
    if(!name) return res.status(400).json({ ready:false, status:'no_product' });
    const slug = slugOf(name);

    const idx = await jbGet(INDEX_ID);
    idx.packs = idx.packs || {}; idx.pending = idx.pending || {};

    if(idx.packs[slug]) return res.status(200).json({ ready:true, src:'/api/adpack?serve=' + slug });

    const pendingAt = idx.pending[slug] || 0;
    if(q.fast === '1' || (pendingAt && Date.now() - pendingAt < PENDING_TTL)){
      return res.status(200).json({ ready:false, status: pendingAt ? 'generating' : 'missing' });
    }

    /* generate — but only for real catalogue products */
    const cat = await catalogue();
    const prod = cat.find(p => slugOf(p.label) === slug);
    if(!prod) return res.status(404).json({ ready:false, status:'unknown_product' });

    if(!process.env.OPENAI_API_KEY) return res.status(200).json({ ready:false, status:'no_key' });

    idx.pending[slug] = Date.now();
    await jbPut(INDEX_ID, idx);

    const g = await generate(prod.label, prod.image_card || prod.image || '');
    if(g.error){
      const idx2 = await jbGet(INDEX_ID);
      if(idx2.pending) delete idx2.pending[slug];
      await jbPut(INDEX_ID, idx2);
      return res.status(200).json({ ready:false, status:g.error, detail:g.detail || '' });
    }

    const blobId = await jbCreate({ b64: g.b64, ct: 'image/webp', name: prod.label, at: Date.now() });
    const idx3 = await jbGet(INDEX_ID);
    idx3.packs = idx3.packs || {}; idx3.pending = idx3.pending || {};
    idx3.packs[slug] = { blob: blobId, at: Date.now() };
    delete idx3.pending[slug];
    await jbPut(INDEX_ID, idx3);

    return res.status(200).json({ ready:true, src:'/api/adpack?serve=' + slug });
  }catch(e){
    return res.status(200).json({ ready:false, status:'error', detail: String(e && e.message || e).slice(0, 200) });
  }
};
