/* Sell Products AI — first-party funnel event collector.
   Runs as a Vercel serverless function at /api/collect on the funnel's own
   origin. Storage: Vercel Blob (same store the ad packs and email packs
   already live in) — replaced jsonblob.com after it purged our data twice.

   Layout (append-only, no shared index to lose):
     ev/<YYYY-MM-DD>/c-<ts>-<rand>.json   one chunk per POST batch
     ev/<YYYY-MM-DD>.json                 compacted file, written once when a
                                          PAST day is first read; late chunks
                                          (clock-skewed beacons) stay alongside
                                          and are always merged in on read.

   POST  {sid, events:[{t,e,v}]}          — append a visitor's batched events
   GET   ?key=<READ_KEY>&days=N           — return events for the last N days
   GET   ?stats=<READ_KEY>&days=N         — aggregate step/uniques summary
   GET   ?live=1                          — public PII-free counters (today)
   GET   ?selftest=<READ_KEY>             — write one synthetic event end-to-end
   GET   ?jbrescue=<READ_KEY>             — one-time: import legacy jsonblob days

   READ_KEY is sha256('read:' + dashboard password) — the dashboard derives it
   from the password at unlock, so it never appears in public page source. */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const LEGACY_JB = 'https://jsonblob.com/api/jsonBlob';
const LEGACY_INDEX = '019fec64-66e4-7f84-a403-a0ee20137ede';

const EV_OK = new Set([
  // journey
  'screen','answer','product_view','product_choose','email_submitted','pick_link',
  // money moments (beacon-side; Stripe is the source of truth for revenue)
  'claim_click','paid_1dollar','paid_20','upsell_click','upsell_decline','paid_upsell',
  'seo_click','paid_seo','seo_skip','addons_skip','paid_addons','claim_unlimited',
  // reservation + diagnostics
  'resv_expired','resv_restored','checkout_mode','finalize_fail',
  'seo_fail','addons_fail','custom_mode_err','custom_mount_err'
]);
const MAX_BATCH = 200, MAX_DAY_EVENTS = 60000, MAX_DAYS_READ = 60, MAX_CHUNK_FETCH = 1500;

let liveCache = null, liveCacheAt = 0; // public live counters, 2-min TTL

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

const TZ = 'America/Los_Angeles'; // day shards cut at Pacific midnight (owner's clock)
const dayKey = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
function prevDayKey(d){
  // walk back one Pacific day, DST-safe: last ms of day d is 07:59/08:59 UTC
  for(const off of ['-07:00', '-08:00']){
    const e = Date.parse(d + 'T00:00:00' + off);
    if(dayKey(e) === d && dayKey(e - 1) !== d) return dayKey(e - 1);
  }
  return dayKey(Date.parse(d + 'T00:00:00-08:00') - 1);
}
function lastNDayKeys(n){
  const list = [dayKey(Date.now())];
  for(let i = 1; i < n; i++) list.push(prevDayKey(list[i - 1]));
  return list;
}

/* private store: blob content fetches must carry the RW token */
function bfetch(url){
  return fetch(url, { headers: { Authorization: 'Bearer ' + blobToken() } });
}

async function listDay(day){
  const { list } = await import('@vercel/blob');
  const blobs = [];
  let cursor;
  do{
    const page = await list(blobOpts({ prefix: 'ev/' + day, limit: 1000, cursor }));
    blobs.push(...(page.blobs || []));
    cursor = page.cursor;
  }while(cursor);
  return blobs;
}

/* Merge the day's compacted file (if any) with every outstanding chunk.
   First read of a finished day compacts it down to one file. */
async function readDay(day, compactPast){
  const blobs = await listDay(day);
  const fileB = blobs.find(b => b.pathname === 'ev/' + day + '.json');
  const chunkBs = blobs.filter(b => b.pathname.startsWith('ev/' + day + '/')).slice(0, MAX_CHUNK_FETCH);
  const [base, parts] = await Promise.all([
    fileB ? bfetch(fileB.url).then(r => r.json()).catch(() => []) : [],
    Promise.all(chunkBs.map(b => bfetch(b.url).then(r => r.json()).catch(() => [])))
  ]);
  let all = (Array.isArray(base) ? base : []).concat(parts.flat().filter(Boolean));
  if(all.length > MAX_DAY_EVENTS) all = all.slice(all.length - MAX_DAY_EVENTS);
  if(compactPast && !fileB && chunkBs.length && day !== dayKey(Date.now())){
    try{
      const { put, del } = await import('@vercel/blob');
      await put('ev/' + day + '.json', JSON.stringify(all), blobOpts({
        access: 'private', addRandomSuffix: false, contentType: 'application/json' }));
      await del(chunkBs.map(b => b.url), blobOpts());
    }catch(e){} // compaction is an optimization — never let it break a read
  }
  return all;
}

async function readRange(days, compactPast){
  const wanted = lastNDayKeys(days);
  const parts = await Promise.all(wanted.map(d => readDay(d, compactPast).catch(() => [])));
  return parts.flat();
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
  const { put } = await import('@vercel/blob');
  const byDay = {};
  for(const e of events) (byDay[dayKey(e.t)] = byDay[dayKey(e.t)] || []).push(e);
  for(const day of Object.keys(byDay)){
    const name = 'ev/' + day + '/c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
    await put(name, JSON.stringify(byDay[day]), blobOpts({
      access: 'private', addRandomSuffix: false, contentType: 'application/json' }));
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
      if(!blobToken()) return res.status(503).json({ error: 'blob store not configured' });

      if(q.selftest){
        if(q.selftest !== READ_KEY) return res.status(403).json({ error: 'bad key' });
        try{
          await appendEvents([{ t: Date.now(), sid: 'selftest', e: 'screen', v: 's-landing' }]);
        }catch(e){
          return res.status(200).json({ ok: false, stage: 'write', error: String(e && e.message || e).slice(0, 300) });
        }
        // full roundtrip: list the day, fetch the newest chunk back
        const day = dayKey(Date.now());
        const blobs = await listDay(day).catch(() => []);
        const chunks = blobs.filter(b => b.pathname.startsWith('ev/' + day + '/'));
        const last = chunks[chunks.length - 1];
        let readBack = null;
        if(last){
          const r = await bfetch(last.url).catch(() => null);
          readBack = { status: r ? r.status : 'fetch_failed' };
          if(r && r.ok){ try{ readBack.events = (await r.json()).length; }catch(e){ readBack.parse = 'failed'; } }
        }
        return res.status(200).json({ ok: true, wrote: 1, store: 'vercel-blob',
          dayBlobs: blobs.length, chunks: chunks.length, readBack });
      }

      /* one-time: pull whatever survives of the legacy jsonblob days into Blob */
      if(q.jbrescue){
        if(q.jbrescue !== READ_KEY) return res.status(403).json({ error: 'bad key' });
        const idx = await fetch(LEGACY_JB + '/' + LEGACY_INDEX)
          .then(r => r.ok ? r.json() : null).catch(() => null);
        if(!idx || !idx.days || !Object.keys(idx.days).length)
          return res.status(200).json({ ok: false, note: 'legacy index unreachable — those events are gone' });
        const { put } = await import('@vercel/blob');
        const imported = {};
        for(const day of Object.keys(idx.days)){
          const arr = await fetch(LEGACY_JB + '/' + idx.days[day])
            .then(r => r.ok ? r.json() : []).catch(() => []);
          if(!Array.isArray(arr) || !arr.length) continue;
          await put('ev/' + day + '/c-rescue.json', JSON.stringify(arr), blobOpts({
            access: 'private', addRandomSuffix: false, allowOverwrite: true,
            contentType: 'application/json' }));
          imported[day] = arr.length;
        }
        return res.status(200).json({ ok: true, imported });
      }

      /* public, PII-free live counters for on-page social proof — REAL
         numbers only (unique visitors per event, today). Cached 2 min. */
      if(q.live === '1'){
        if(liveCache && Date.now() - liveCacheAt < 120000) return res.status(200).json(liveCache);
        const evs = await readDay(dayKey(Date.now()), false).catch(() => []);
        const uniq = n => new Set(evs.filter(e => e && e.e === n && e.sid !== 'selftest').map(e => e.sid)).size;
        liveCache = { ok: true, reserved_today: uniq('product_choose'), optins_today: uniq('email_submitted') };
        liveCacheAt = Date.now();
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.status(200).json(liveCache);
      }

      if(q.stats === READ_KEY){
        const days = Math.min(MAX_DAYS_READ, Math.max(1, parseInt(q.days, 10) || 1));
        const evs = (await readRange(days, true)).filter(e => e && e.t && e.e && e.sid !== 'selftest');
        res.setHeader('X-Day-TZ', TZ);
        const uniq = pred => new Set(evs.filter(pred).map(e => e.sid)).size;
        const S = id => uniq(e => e.e === 'screen' && e.v === id);
        const E = n => uniq(e => e.e === n);
        const steps = {};
        ['s-landing','s-intro','s-q1','s-q2','s-q3','s-q4','s-q5','s-reality','s-blueprint',
         's-cost','s-scan','s-pick','s-email','s-build','s-preview','s-upsell'].forEach(id => steps[id] = S(id));
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
      const events = (await readRange(days, true)).filter(e => e && e.t && e.e);
      return res.status(200).json(events);
    }

    if(req.method === 'POST'){
      if(!blobToken()) return res.status(204).end();
      let body = req.body;
      if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = null; } }
      const events = body && cleanEvents(body);
      if(!events) return res.status(204).end(); // silently drop junk
      // A storage hiccup must NEVER 500 the page's event beacon —
      // drop the batch and move on. TG12120.
      try{ await appendEvents(events); }catch(e){ console.error('collect append failed:', e && e.message); }
      return res.status(204).end();
    }

    return res.status(405).json({ error: 'method' });
  }catch(err){
    console.error('collect error:', err && err.message);
    return res.status(500).json({ error: 'collector error' });
  }
};
