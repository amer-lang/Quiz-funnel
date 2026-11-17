/* Open-access members link (/members?pass=<token>).
   The token is never stored in the repo: it is MEMBERS_OPEN_TOKEN when that
   env var exists, otherwise derived on the server from a secret Vercel already
   holds. Every function that honours the link derives it the same way, so they
   always agree. The owner reads it via /api/auth?probe=opentoken&key=READ_KEY. */
const crypto = require('crypto');
function openToken(){
  if(process.env.MEMBERS_OPEN_TOKEN) return String(process.env.MEMBERS_OPEN_TOKEN);
  /* The seed stays the Stripe key (what it has always been in production, because AUTH_SECRET was unset there), so existing
     /members?pass=… links keep working now that AUTH_SECRET is set. Do not put AUTH_SECRET first: it would change every open link. */
  const seed = process.env.STRIPE_SECRET_KEY || process.env.AUTH_SECRET || '';
  if(!seed) return '';
  return crypto.createHmac('sha256', seed).update('spai-members-open-access').digest('hex').slice(0, 24);
}
function isOpen(v){ const t = openToken(); return !!t && String(v || '') === t; }
module.exports = { openToken, isOpen };
