/* Sell Products AI — DropStart API proxy (/api/ds/<path>).
   The funnel used to call chat.dropstart.app directly with the express key
   embedded in the page — meaning anyone who viewed source could rip a
   WORKING clone of the build flow and burn our quota. The key now lives
   only here; the client calls /api/ds/… keyless and this forwards the
   whitelisted paths with the key attached server-side.

   vercel.json rewrites /api/ds/:path* → /api/ds?p=:path* */

const DS_API = 'https://chat.dropstart.app/api/express';
const DS_KEY = process.env.DS_EXPRESS_KEY || 'ek_c70_42ceb3e0322b33b8fe9f339ded261337f584ed8a75f2918b';

/* only the endpoints the funnel actually uses — never an open proxy */
const ALLOWED = /^(trending|track|build|unlimited-claim|checkout|finalize|verify-checkout|status\/[A-Za-z0-9_\-]{1,80})$/;

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
