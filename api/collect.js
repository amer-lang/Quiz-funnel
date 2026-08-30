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
const MAX_BATCH = 200, MAX_DAY_EVENTS = 150000, MAX_DAYS_READ = 60, MAX_CHUNK_FETCH = 1500;

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

/* Pacific hour '00'-'23' for a timestamp — the intra-day shard key. */
function hourKey(t){
  return new Date(t).toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).slice(0, 2);
}
/* Which hour a chunk belongs to: new layout ev/<day>/<hh>/c-...; legacy
   layout ev/<day>/c-<ms>-... falls back to the hour of its write time. */
function chunkHour(pathname){
  let m = pathname.match(/^ev\/[^/]+\/(\d{2})\/c-/);
  if(m) return m[1];
  m = pathname.match(/^ev\/[^/]+\/c-(\d+)-/);
  if(m) return hourKey(Number(m[1]));
  return '99';
}
const fetchJsonBatch = async (blobs, par) => {
  const out = [];
  for(let i = 0; i < blobs.length; i += par){
    const part = await Promise.all(blobs.slice(i, i + par).map(b =>
      bfetch(b.url).then(r => r.json()).catch(() => [])));
    out.push(...part);
  }
  return out;
};

/* Read one day: compacted day file + compacted hour files + the NEWEST
   outstanding chunks (newest first so live dashboards always see the present
   even while a backlog exists). High-traffic scale: finished hours are rolled
   into single h-<hh>.json files by compactDayPass, so steady-state reads are
   ~25 files + the current hour's chunks. */
async function readDay(day, compactPast){
  const blobs = await listDay(day);
  const fileB = blobs.find(b => b.pathname === 'ev/' + day + '.json');
  const hourFiles = blobs.filter(b => /^ev\/[^/]+\/h-\d{2}\.json$/.test(b.pathname));
  const chunkBs = blobs.filter(b => b.pathname.includes('/c-'))
    .sort((a, b) => (chunkHour(b.pathname) + b.pathname).localeCompare(chunkHour(a.pathname) + a.pathname))
    .slice(0, MAX_CHUNK_FETCH);
  const [base, hourParts, chunkParts] = await Promise.all([
    fileB ? bfetch(fileB.url).then(r => r.json()).catch(() => []) : [],
    fetchJsonBatch(hourFiles, 30),
    fetchJsonBatch(chunkBs, 120)
  ]);
  let all = (Array.isArray(base) ? base : [])
    .concat(hourParts.flat().filter(Boolean))
    .concat(chunkParts.flat().filter(Boolean));
  if(all.length > MAX_DAY_EVENTS) all = all.slice(all.length - MAX_DAY_EVENTS);
  if(compactPast) compactDayPass(day, 1200).catch(() => {}); // fire-and-forget tidy
  return all;
}

/* One bounded compaction pass: merge finished-hour chunks (and, for past
   days, everything) into h-<hh>.json / <day>.json files and delete the
   merged chunks. Budgeted so it can run inside a read or be looped via
   ?compact=KEY to digest a backlog. Returns chunks remaining afterwards. */
async function compactDayPass(day, chunkBudget){
  const { put, del } = await import('@vercel/blob');
  const isToday = day === dayKey(Date.now());
  const curHour = hourKey(Date.now());
  let blobs = await listDay(day);
  // single-compactor lease: overlapping passes on one hour can overwrite each
  // other's merges and lose events, so a fresh lease marker means back off
  const lease = blobs.find(b => b.pathname === 'ev/' + day + '/.compacting');
  if(lease && Date.now() - new Date(lease.uploadedAt).getTime() < 90000)
    return { remaining: -1, compacted: 0, busy: true };
  await put('ev/' + day + '/.compacting', String(Date.now()), blobOpts({
    access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain' }));
  blobs = blobs.filter(b => b.pathname !== 'ev/' + day + '/.compacting');
  const chunkAll = blobs.filter(b => b.pathname.includes('/c-'));
  const groups = {};
  for(const b of chunkAll){
    const h = chunkHour(b.pathname);
    if(isToday && h >= curHour) continue; // never compact the live hour
    (groups[h] = groups[h] || []).push(b);
  }
  let spent = 0;
  const hours = Object.keys(groups).sort(); // oldest first
  for(const h of hours){
    if(spent >= chunkBudget) break;
    const batch = groups[h].slice(0, Math.max(50, chunkBudget - spent));
    spent += batch.length;
    const hourPath = 'ev/' + day + '/h-' + h + '.json';
    const hourFile = blobs.find(b => b.pathname === hourPath);
    const [baseArr, parts] = await Promise.all([
      hourFile ? bfetch(hourFile.url).then(r => r.json()).catch(() => []) : [],
      fetchJsonBatch(batch, 120)
    ]);
    const merged = (Array.isArray(baseArr) ? baseArr : []).concat(parts.flat().filter(Boolean));
    await put(hourPath, JSON.stringify(merged), blobOpts({
      access: 'private', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json' }));
    await del(batch.map(b => b.url), blobOpts());
  }
  // past day fully chunk-free → collapse hour files into the single day file
  if(!isToday && !blobs.find(b => b.pathname === 'ev/' + day + '.json')){
    const after = await listDay(day);
    const remChunks = after.filter(b => b.pathname.includes('/c-'));
    const hFiles = after.filter(b => /^ev\/[^/]+\/h-\d{2}\.json$/.test(b.pathname));
    if(!remChunks.length && hFiles.length){
      const parts = await fetchJsonBatch(hFiles, 30);
      await put('ev/' + day + '.json', JSON.stringify(parts.flat().filter(Boolean)), blobOpts({
        access: 'private', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json' }));
      await del(hFiles.map(b => b.url), blobOpts());
    }
  }
  try{ await del('ev/' + day + '/.compacting', blobOpts()); }catch(e){}
  const left = (await listDay(day)).filter(b => b.pathname.includes('/c-'));
  return { remaining: left.length, compacted: spent };
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
  const byShard = {}; // day/hour shard → events
  for(const e of events){
    const k = dayKey(e.t) + '/' + hourKey(e.t);
    (byShard[k] = byShard[k] || []).push(e);
  }
  for(const shard of Object.keys(byShard)){
    const name = 'ev/' + shard + '/c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
    await put(name, JSON.stringify(byShard[shard]), blobOpts({
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

      /* key-gated: one bounded compaction pass on a day's chunk backlog.
         Loop until remaining is ~0. ?day=YYYY-MM-DD targets a specific day
         (default today). */
      if(q.compact){
        if(q.compact !== READ_KEY) return res.status(403).json({ error: 'bad key' });
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(q.day || '')) ? String(q.day) : dayKey(Date.now());
        try{
          const r = await compactDayPass(day, Math.min(6000, parseInt(q.budget, 10) || 2500));
          return res.status(200).json({ ok: true, day, compacted: r.compacted,
            chunks_remaining: r.remaining, busy: !!r.busy });
        }catch(e){
          return res.status(200).json({ ok: false, day, error: String(e && e.message || e).slice(0, 200) });
        }
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

      /* per-Pacific-day step funnel — for day-vs-day drop diagnosis */
      if(q.funnel === READ_KEY){
        const days = Math.min(14, Math.max(1, parseInt(q.days, 10) || 3));
        const out = [];
        for(const d of lastNDayKeys(days)){
          const evs = (await readDay(d, true).catch(() => [])).filter(e => e && e.sid !== 'selftest');
          const uniq = pred => new Set(evs.filter(pred).map(e => e.sid)).size;
          const S = id => uniq(e => e.e === 'screen' && e.v === id);
          const E = n => uniq(e => e.e === n);
          out.push({ day: d, visitors: new Set(evs.map(e => e.sid)).size,
            landing: S('s-landing'), intro: S('s-intro'), q1: S('s-q1'), q5: S('s-q5'),
            reality: S('s-reality'), blueprint: S('s-blueprint'), cost: S('s-cost'),
            scan: S('s-scan'), pick: S('s-pick'), emailScreen: S('s-email'),
            emails: E('email_submitted'), build: S('s-build'), preview: S('s-preview'),
            claims: E('claim_click'), paid: E('paid_20'),
            launch1: S('s-launch1'), seo: S('s-seo'), adsUp: S('s-upsell-ads'), addons: S('s-addons'),
            diag: { checkout_mode: E('checkout_mode'), mount_err: E('custom_mount_err'),
              mode_err: E('custom_mode_err'), finalize_fail: E('finalize_fail'),
              resv_expired: E('resv_expired'), resv_restored: E('resv_restored') } });
        }
        return res.status(200).json({ ok: true, tz: TZ, rows: out });
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
