/* Server-side shared secrets come from Vercel environment variables only; none live in source.
   A variable that is missing or shorter than 32 chars counts as unset.
   guardKey: for keys that guard a route (`q.key === KEY`). Unset gives a random per-process value that nobody can send, so no
             request value (a string, undefined, '' or a JSON null in a POST body) can ever equal it and the route answers 403.
   credential: for tokens we send to another service. Unset gives null so callers skip the call. */
const crypto = require('crypto');
function value(name){
  const v = String(process.env[name] || '').trim();
  return v.length >= 32 ? v : '';
}
function guardKey(name){ return value(name) || crypto.randomBytes(32).toString('hex'); }
function credential(name){ return value(name) || null; }
module.exports = { guardKey, credential };
