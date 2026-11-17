/* Sell Products AI — product-card snapshot (used by api/ds.js and api/cardsnap.js).

   The picker's cards come live from DropStart (/api/express/trending). When that call fails (DropStart
   restarting, overloaded, down) the funnel used to fall back to six built-in PLACEHOLDER products with
   no catalogue id — a buyer who picked one paid $20 for a store built around a text search for
   something "similar" (2 paid stores, Oct 21 2026). So a cron (api/cardsnap.js, every 10 min) saves every
   good live list here, in a private Blob, and if the live call fails api/ds.js serves the last good copy
   instead — same JSON, same card ids. DropStart re-resolves a card id on its side even after a cache loss,
   so a snapshot card builds the EXACT product. Writing happens only in the cron, never in a buyer's
   request, so a slow or failing Blob store cannot slow the funnel down. */

const SNAP_PATH = 'cards/trending-snapshot.json';
const MIN_CARDS = 12;                       // never snapshot a degenerate list
const MAX_AGE_MS = 48 * 3600 * 1000;        // older than this is not served (bounds how stale a delisted card can be)

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
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/* parse a /trending response body; returns the card array or null when it is not a usable list */
function cardsOf(text){
  try{
    const j = JSON.parse(text);
    const list = j && j.products;
    return Array.isArray(list) && list.length ? list : null;
  }catch(e){ return null; }
}

/* save a good live answer; returns { saved, cards, reason? } and never throws */
async function saveSnapshot(text){
  const list = cardsOf(text);
  if(!list) return { saved: false, cards: 0, reason: 'not_a_card_list' };
  if(list.length < MIN_CARDS) return { saved: false, cards: list.length, reason: 'too_few_cards' };
  try{
    const { put } = await import('@vercel/blob');
    await withTimeout(put(SNAP_PATH, JSON.stringify({ t: Date.now(), body: text }), blobOpts({
      access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' })), 15000);
    return { saved: true, cards: list.length };
  }catch(e){ return { saved: false, cards: list.length, reason: 'blob_write_failed: ' + String(e && e.message || e).slice(0, 100) }; }
}

/* the last good answer: { body, ageMs, cards } or null */
async function loadSnapshot(){
  try{
    const { head } = await import('@vercel/blob');
    const h = await withTimeout(head(SNAP_PATH, blobOpts()), 3000);
    const rec = await withTimeout(fetch(h.url, { headers: { Authorization: 'Bearer ' + blobToken() } }).then(r => r.json()), 3000);
    const ageMs = Date.now() - Number(rec && rec.t);
    const list = rec && typeof rec.body === 'string' ? cardsOf(rec.body) : null;
    if(!list || !(ageMs >= -60000) || ageMs > MAX_AGE_MS) return null;   // 60 s slack for clock skew between instances
    return { body: rec.body, ageMs: Math.max(0, ageMs), cards: list.length };
  }catch(e){ return null; }
}

module.exports = { cardsOf, saveSnapshot, loadSnapshot };
