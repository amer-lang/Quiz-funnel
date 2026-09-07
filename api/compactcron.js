/* Sell Products AI — scheduled collector compaction.
   Vercel Cron hits this every 5 minutes (vercel.json). Each run performs one
   compaction pass via /api/collect?compact: today first (keeps the live
   funnel dashboard reading hour-files instead of a 1,500-chunk tail), then
   falls back to yesterday and D-2 if today had nothing left to grind.

   Why this exists: at current ad volume the funnel writes 40k+ event chunks
   per day. Compaction used to run only piggybacked on dashboard reads, fell
   days behind, and every read silently degraded to the newest 1,500 chunks
   (~2 hours of traffic) — dashboards showed ~5% of real numbers while Stripe
   stayed correct. A cron makes compaction independent of anyone watching. */

const READ_KEY = '448bd487135f59ca260b08fcb16d660e60b0953c54063d91cfeab0fe7e95362c';
const BASE = 'https://www.sellproducts.ai/api/collect';
const TZ = 'America/Los_Angeles';

const dayStr = t => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });

module.exports = async (req, res) => {
  const ua = String((req.headers && req.headers['user-agent']) || '');
  const q = req.query || {};
  if(!ua.startsWith('vercel-cron') && q.key !== READ_KEY)
    return res.status(403).json({ ok: false });

  const now = Date.now();
  // look back to D-4 so a day that fell behind while the cron was busy with
  // fresher days still gets ground down instead of aging out of the window
  const days = [0, 1, 2, 3, 4].map(i => dayStr(now - i * 86400000));
  const out = [];
  for(const day of days){
    try{
      const r = await fetch(BASE + '?compact=' + READ_KEY + '&day=' + day + '&budget=2200');
      const j = await r.json().catch(() => ({}));
      out.push({ day, compacted: j.compacted ?? null, remaining: j.chunks_remaining ?? null, busy: !!j.busy });
      // one real pass per run; only fall through when this day had no backlog
      if((j.compacted || 0) > 50 || j.busy) break;
    }catch(e){
      out.push({ day, error: String(e && e.message || e).slice(0, 120) });
      break;
    }
  }
  return res.status(200).json({ ok: true, ran: out, at: new Date().toISOString() });
};
