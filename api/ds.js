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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'OPTIONS') return res.status(204).end();

  const p = String((req.query && req.query.p) || '').replace(/^\/+|\/+$/g, '');
  if(!ALLOWED.test(p)) return res.status(404).json({ ok:false, error:'unknown_path' });
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok:false });

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
