/* Open-access members link (/members?pass=<token>).
   The token is never stored in the repo: it is MEMBERS_OPEN_TOKEN when that
   env var exists, otherwise derived on the server from a secret Vercel already
   holds. Every function that honours the link derives it the same way, so they
   always agree. The owner reads it via /api/auth?probe=opentoken&key=READ_KEY. */
const crypto = require('crypto');
function openToken(){
  if(process.env.MEMBERS_OPEN_TOKEN) return String(process.env.MEMBERS_OPEN_TOKEN);
  const seed = process.env.AUTH_SECRET || process.env.STRIPE_SECRET_KEY || '';
  if(!seed) return '';
  return crypto.createHmac('sha256', seed).update('spai-members-open-access').digest('hex').slice(0, 24);
}
function isOpen(v){ const t = openToken(); return !!t && String(v || '') === t; }
module.exports = { openToken, isOpen };
