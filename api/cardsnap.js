/* Sell Products AI — product-card snapshot refresher (Vercel Cron, every 10 minutes; see vercel.json).
   Fetches DropStart's live card list and saves it as the fallback api/ds.js serves when DropStart's list
   cannot be loaded (see lib/cards.js). Nothing is written when the live answer is missing or too small,
   so a bad moment can never replace a good snapshot.

   GET (cron user-agent, or ?key=READ_KEY)            → refresh now
   GET ?verify=1 (cron user-agent, or ?key=READ_KEY)  → read the snapshot back (proves the Blob read path), no write */

const { guardKey } = require('../lib/secrets');
const { cardsOf, saveSnapshot, loadSnapshot } = require('../lib/cards');
const { DS_KEY } = require('./ds');

const READ_KEY = guardKey('READ_KEY');
const DS_API = 'https://chat.dropstart.app/api/express';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ua = String((req.headers && req.headers['user-agent']) || '');
  const q = req.query || {};
  if(!ua.startsWith('vercel-cron') && q.key !== READ_KEY) return res.status(403).json({ ok: false });

  if(q.verify){
    const snap = await loadSnapshot();
    return res.status(200).json(snap
      ? { ok: true, cards: snap.cards, age_min: Math.round(snap.ageMs / 60000) }
      : { ok: false, error: 'no_usable_snapshot' });
  }

  try{
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    let r, text;
    try{
      r = await fetch(DS_API + '/trending', { headers: { 'X-Express-Key': DS_KEY }, signal: ctl.signal });
      text = await r.text();
    }finally{ clearTimeout(timer); }
    if(!r.ok || !cardsOf(text)){
      console.warn('cardsnap: live list unusable (HTTP ' + r.status + '), snapshot left as is');
      return res.status(200).json({ ok: false, error: 'live_unusable', status: r.status });
    }
    const out = await saveSnapshot(text);
    if(!out.saved) console.warn('cardsnap: not saved — ' + out.reason);
    return res.status(200).json(Object.assign({ ok: out.saved }, out));
  }catch(e){
    console.warn('cardsnap: fetch failed — ' + String(e && e.message || e).slice(0, 120));
    return res.status(200).json({ ok: false, error: 'fetch_failed' });
  }
};
