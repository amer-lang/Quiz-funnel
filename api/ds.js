/* Sell Products AI — DropStart API proxy (/api/ds/<path>).
   The funnel used to call chat.dropstart.app directly with the express key
   embedded in the page — meaning anyone who viewed source could rip a
   WORKING clone of the build flow and burn our quota. The key now lives
   only here; the client calls /api/ds/… keyless and this forwards the
   whitelisted paths with the key attached server-side.

   vercel.json rewrites /api/ds/:path* → /api/ds?p=:path* */

const DS_API = 'https://chat.dropstart.app/api/express';
/* DropStart API key — ROTATED 2026-09-27: the previous key sat in the public page
   source Jul 22–Sep 23, so it was replaced and no longer works. Do NOT paste an
   older key back. Keep this identical in api/ds.js, api/lead.js, api/adpack.js and
   api/adsorder.js. Key changes → coordinate with DropStart (Leighton). */
const DS_KEY = 'ek_c70_982dd6374dd3c7bebcd1ff89bf1c7f3091c8b6b413114652'; // not read from Vercel env on purpose — an old env value would override it

/* The card snapshot is a safety net only: if its module ever failed to load, every other proxy path must still work. */
let loadSnapshot = async () => null;
try{ ({ loadSnapshot } = require('../lib/cards')); }catch(e){ console.error('ds: lib/cards failed to load — ' + String(e && e.message || e)); }
const liveCards = text => { try{ const j = JSON.parse(text); return Array.isArray(j && j.products) && j.products.length > 0; }catch(e){ return false; } };

/* only the endpoints the funnel actually uses — never an open proxy */
const ALLOWED = /^(trending|track|build|unlimited-claim|checkout|finalize|verify-checkout|status\/[A-Za-z0-9_\-]{1,80})$/;

/* Every visitor reaches DropStart through this proxy, so DropStart sees a
   Vercel server IP for all of them — and its "5 builds per visitor per hour"
   limit lumped every customer behind a few Vercel IPs together, turning real
   first-time buyers away with a 429. Pass the real visitor IP on /build as
   client_ip (DropStart keys the limit on it). Always overwritten here, so a
   browser can't supply its own. */
function visitorIp(req){
  const h = req.headers || {};
  const ip = String(h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || '').trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : '';
}

function readBody(req){
  if(req.body && typeof req.body === 'object') return Promise.resolve(JSON.stringify(req.body));
  if(typeof req.body === 'string') return Promise.resolve(req.body);
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => resolve(raw || ''));
  });
}

/* The card list is the same for every visitor, so let Vercel's edge cache it for a minute (and serve a slightly older copy while it
   refreshes in the background). Without this every visit made its own ~84 KB call to DropStart (8-10k a day normally, 98k-188k on the busiest days). Only a LIVE, validated list is cached
   that long; the snapshot fallback is cached for seconds and errors never. TG14774. */
const EDGE_LIVE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
const EDGE_SNAPSHOT = 'public, max-age=0, s-maxage=10';

async function serveTrending(res){
  try{
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    let r, text;
    try{
      r = await fetch(DS_API + '/trending', { headers: { 'X-Express-Key': DS_KEY }, signal: ctl.signal });
      text = await r.text();
    }finally{ clearTimeout(timer); }
    if(r.ok && liveCards(text)){
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Cards-Source', 'live');
      res.setHeader('Cache-Control', EDGE_LIVE);
      return res.status(200).send(text);
    }
  }catch(e){ /* fall through to the snapshot */ }
  const snap = await loadSnapshot();
  if(snap){
    console.warn('ds: /trending served from the snapshot (' + snap.cards + ' cards, ' + Math.round(snap.ageMs / 60000) + ' min old) — live list unavailable');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cards-Source', 'snapshot');
    res.setHeader('Cache-Control', EDGE_SNAPSHOT);
    res.setHeader('X-Cards-Age-Min', String(Math.round(snap.ageMs / 60000)));
    return res.status(200).send(snap.body);
  }
  return res.status(502).json({ ok:false, error:'upstream' });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'OPTIONS') return res.status(204).end();

  const p = String((req.query && req.query.p) || '').replace(/^\/+|\/+$/g, '');
  if(!ALLOWED.test(p)) return res.status(404).json({ ok:false, error:'unknown_path' });
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok:false });

  /* The product cards: live from DropStart, else the last good copy (lib/cards.js) — so a DropStart
     hiccup never turns the picker into the six built-in placeholders. */
  if(p === 'trending' && req.method === 'GET') return serveTrending(res);

  try{
    const opts = { method: req.method, headers: { 'X-Express-Key': DS_KEY } };
    if(req.method === 'POST'){
      opts.headers['Content-Type'] = 'application/json';
      opts.body = await readBody(req);
      const ip = p === 'build' ? visitorIp(req) : '';
      if(ip){
        try{
          const b = JSON.parse(opts.body || '{}');
          if(b && typeof b === 'object' && !Array.isArray(b)){
            b.client_ip = ip;
            opts.body = JSON.stringify(b);
          }
        }catch(e){ /* not JSON — forward untouched */ }
      }
    }
    const r = await fetch(DS_API + '/' + p, opts);
    const text = await r.text();
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    return res.send(text);
  }catch(e){
    return res.status(502).json({ ok:false, error:'upstream', detail: String(e && e.message || e).slice(0, 120) });
  }
};

/* shared with api/cardsnap.js (the card-snapshot cron) so the key stays defined in one place */
module.exports.DS_KEY = DS_KEY;
