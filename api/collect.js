/* Sell Products AI — first-party funnel event collector.
   Runs as a Vercel serverless function at /api/collect on the funnel's own
   origin. Storage: jsonblob.com day-sharded blobs behind one index blob.

   POST  {sid, events:[{t,e,v}]}         — append a visitor's batched events
   GET   ?key=<READ_KEY>&days=N          — return events for the last N days
   GET   ?selftest=<READ_KEY>            — write one synthetic event end-to-end
   GET   ?init=<READ_KEY>                — one-time: create the index blob

   READ_KEY is sha256('read:' + dashboard password) — the dashboard derives it
   from the password at unlock, so it never appears in public page source. */

const JB = 'https://jsonblob.com/api/jsonBlob';
const READ_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';
const INDEX_ID = '019fad32-d106-7cf6-adc7-8dbaf3821122';

const EV_OK = new Set(['screen','answer','product_view','product_choose',
  'email_submitted','claim_click','paid_1dollar','upsell_click','upsell_decline','paid_upsell']);
const MAX_BATCH = 200, MAX_DAY_EVENTS = 60000, MAX_DAYS_READ = 60;

let idxCache = null, idxCacheAt = 0; // per-instance, 60s TTL

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
  const loc = r.headers.get('location') || '';
  const id = loc.split('/').pop();
  if(!id) throw new Error('jb create: no id');
  return id;
}

const dayKey = t => new Date(t).toISOString().slice(0, 10);

async function loadIndex(){
  if(idxCache && Date.now() - idxCacheAt < 60000) return idxCache;
  idxCache = await jbGet(INDEX_ID);
  if(!idxCache.days) idxCache.days = {};
  idxCacheAt = Date.now();
  return idxCache;
}

async function dayBlobId(day){
  const idx = await loadIndex();
  if(idx.days[day]) return idx.days[day];
  const id = await jbCreate([]);
  // re-read before writing so a concurrent creator doesn't get clobbered
  const fresh = await jbGet(INDEX_ID);
  if(!fresh.days) fresh.days = {};
  if(fresh.days[day]){ idxCache = fresh; idxCacheAt = Date.now(); return fresh.days[day]; }
  fresh.days[day] = id;
  await jbPut(INDEX_ID, fresh);
  idxCache = fresh; idxCacheAt = Date.now();
  return id;
}

function cleanEvents(body){
  const sid = String(body.sid || '').slice(0, 24);
  if(!sid || !Array.isArray(body.events)) return null;
  const now = Date.now();
  const out = [];
  for(const e of body.events.slice(0, MAX_BATCH)){
    if(!e || !EV_OK.has(e.e)) continue;
    const t = Number(e.t);
    if(!isFinite(t) || t > now + 300000 || t < now - 7 * 864e5) continue;
    out.push({ t: Math.round(t), sid, e: e.e, v: e.v == null ? null : String(e.v).slice(0, 80) });
  }
  return out.length ? out : null;
}

async function appendEvents(events){
  const byDay = {};
  for(const e of events) (byDay[dayKey(e.t)] = byDay[dayKey(e.t)] || []).push(e);
  for(const day of Object.keys(byDay)){
    const id = await dayBlobId(day);
    let arr;
    try{ arr = await jbGet(id); }catch(err){ arr = []; }
    if(!Array.isArray(arr)) arr = [];
    arr.push(...byDay[day]);
    if(arr.length > MAX_DAY_EVENTS) arr.splice(0, arr.length - MAX_DAY_EVENTS);
    await jbPut(id, arr);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'OPTIONS') return res.status(204).end();

  try{
    if(req.method === 'GET'){
      const q = req.query || {};

      if(q.init){
        if(q.init !== READ_KEY) return res.status(403).json({ error: 'bad key' });
        if(INDEX_ID !== '__UNSET__') return res.status(200).json({ ok: true, indexId: INDEX_ID, note: 'already configured' });
        const id = await jbCreate({ created: Date.now(), days: {} });
        return res.status(200).json({ ok: true, indexId: id, note: 'bake this into INDEX_ID and redeploy' });
      }

      if(INDEX_ID === '__UNSET__') return res.status(503).json({ error: 'collector not initialized' });

      if(q.selftest){
        if(q.selftest !== READ_KEY) return res.status(403).json({ error: 'bad key' });
        await appendEvents([{ t: Date.now(), sid: 'selftest', e: 'screen', v: 's-landing' }]);
        return res.status(200).json({ ok: true, wrote: 1 });
      }

      if(q.stats === READ_KEY){
        const days = Math.min(MAX_DAYS_READ, Math.max(1, parseInt(q.days, 10) || 1));
        const idx = await loadIndex();
        const wanted = [];
        for(let i = 0; i < days; i++){
          const d = dayKey(Date.now() - i * 864e5);
          if(idx.days[d]) wanted.push(idx.days[d]);
        }
        const parts = await Promise.all(wanted.map(id => jbGet(id).catch(() => [])));
        const evs = parts.flat().filter(e => e && e.t && e.e && e.sid !== 'selftest');
        const uniq = pred => new Set(evs.filter(pred).map(e => e.sid)).size;
        const S = id => uniq(e => e.e === 'screen' && e.v === id);
        const E = n => uniq(e => e.e === n);
        const steps = {};
        ['s-landing','s-intro','s-q1','s-q2','s-q3','s-q4','s-q5','s-reality','s-blueprint',
         's-scan','s-pick','s-email','s-build','s-preview','s-upsell'].forEach(id => steps[id] = S(id));
        return res.status(200).json({
          ok: true, days, totalEvents: evs.length,
          visitors: new Set(evs.map(e => e.sid)).size,
          steps,
          emails: E('email_submitted'),
          claims: E('claim_click'),
          paid1: E('paid_1dollar'),
          upsellClicks: E('upsell_click'),
          paid299: E('paid_upsell')
        });
      }

      if(q.key !== READ_KEY) return res.status(403).json({ error: 'bad key' });
      const days = Math.min(MAX_DAYS_READ, Math.max(1, parseInt(q.days, 10) || 30));
      const idx = await loadIndex();
      const wanted = [];
      for(let i = 0; i < days; i++){
        const d = dayKey(Date.now() - i * 864e5);
        if(idx.days[d]) wanted.push(idx.days[d]);
      }
      const parts = await Promise.all(wanted.map(id => jbGet(id).catch(() => [])));
      const events = parts.flat().filter(e => e && e.t && e.e);
      return res.status(200).json(events);
    }

    if(req.method === 'POST'){
      if(INDEX_ID === '__UNSET__') return res.status(503).json({ error: 'collector not initialized' });
      let body = req.body;
      if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = null; } }
      const events = body && cleanEvents(body);
      if(!events) return res.status(204).end(); // silently drop junk
      await appendEvents(events);
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'method' });
  }catch(err){
    return res.status(500).json({ error: 'collector error' });
  }
};
