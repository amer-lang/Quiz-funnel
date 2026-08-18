/* Sell Products AI — Members Area backend (/api/members).
   Powers the First Sale Roadmap at /members: verifies the buyer, stores
   mission progress server-side (survives devices), and recovers the buyer's
   Shopify activation link from ActiveCampaign on demand.

   GET ?cs=<paid $20 session>              → { ok, email, product, done:[...] }
   GET ?cs=...&complete=N                  → mark mission N (1-7) done
   GET ?cs=...&activation=1                → { ok, link } + adds contact to the
                                             "SPAI Resend Activation" list so an
                                             AC automation can email it too.
   Progress lives in Vercel Blob members/<cs>.json (private store). */

const AC_URL = 'https://sellproducts.api-us1.com';
const AC_KEY = 'd84c8bf84307d5b159099552ae63a16a92af944cac522e0ff3ea8ece4bae99b7350dab92';
const ACTIVATION_FIELD_ID = 2;               // %ACTIVATION_LINK%
const RESEND_LIST = 'SPAI Resend Activation'; // auto-created; wire an AC automation to it
const OK_TYPES = new Set(['store_unlock20', 'store_unlock']); // $20 era + legacy $1 era

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
function bfetch(url){
  return fetch(url, { headers: { Authorization: 'Bearer ' + blobToken() } });
}

async function sget(path){
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + (process.env.STRIPE_SECRET_KEY || '') }
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

async function ac(path, method, body){
  const r = await fetch(AC_URL + path, {
    method: method || 'GET',
    headers: { 'Api-Token': AC_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.status >= 200 && r.status < 300, j };
}

async function readProgress(cs){
  try{
    const { head } = await import('@vercel/blob');
    const h = await head('members/' + cs + '.json', blobOpts());
    const j = await bfetch(h.url).then(r => r.json());
    if(j && Array.isArray(j.done)) return j;
  }catch(e){}
  return { done: [] };
}

async function writeProgress(cs, rec){
  const { put } = await import('@vercel/blob');
  await put('members/' + cs + '.json', JSON.stringify(rec), blobOpts({
    access: 'private', addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json' }));
}

/* the buyer's activation link: AC custom field first, session project_id fallback */
async function activationLink(email, meta){
  let link = '';
  try{
    const f = await ac('/api/3/contacts?email=' + encodeURIComponent(email));
    const c = f.ok && f.j.contacts && f.j.contacts[0];
    if(c){
      const fv = await ac('/api/3/contacts/' + c.id + '/fieldValues');
      const hit = fv.ok && (fv.j.fieldValues || []).find(v => String(v.field) === String(ACTIVATION_FIELD_ID) && v.value);
      if(hit) link = hit.value;
      // add to the resend list so the user's AC automation emails it
      try{
        let lid = 0;
        const ls = await ac('/api/3/lists?limit=100');
        const found = ls.ok && (ls.j.lists || []).find(l => (l.name || '').toLowerCase() === RESEND_LIST.toLowerCase());
        if(found) lid = found.id;
        else{
          const mk = await ac('/api/3/lists', 'POST', { list: { name: RESEND_LIST,
            stringid: 'spai-resend-activation', sender_url: 'https://www.sellproducts.ai', sender_reminder: 'You bought a store on sellproducts.ai' } });
          lid = mk.ok && mk.j.list ? mk.j.list.id : 0;
        }
        if(lid) await ac('/api/3/contactLists', 'POST', { contactList: { list: lid, contact: c.id, status: 1 } });
      }catch(e){}
    }
  }catch(e){}
  if(!link && meta && meta.project_id) link = 'https://sellproducts.ai/?resume=' + encodeURIComponent(meta.project_id);
  return link;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  try{
    const cs = String(q.cs || '').slice(0, 300);
    if(!/^cs_[A-Za-z0-9_]+$/.test(cs)) return res.status(400).json({ ok:false, error:'bad_cs' });
    if(!process.env.STRIPE_SECRET_KEY) return res.status(200).json({ ok:false, error:'no_keys' });

    const s = await sget('checkout/sessions/' + encodeURIComponent(cs));
    const ty = (s.metadata && s.metadata.type) || '';
    if(s.payment_status !== 'paid' || !OK_TYPES.has(ty))
      return res.status(200).json({ ok:false, error:'not_a_store_order' });
    const email = (s.customer_details && s.customer_details.email) || '';
    const product = (s.metadata && s.metadata.product) || '';

    if(q.activation){
      const link = await activationLink(email, s.metadata || {});
      return res.status(200).json({ ok:true, link, email });
    }

    const rec = await readProgress(cs);
    if(q.complete){
      const n = parseInt(q.complete, 10);
      if(n >= 1 && n <= 7 && !rec.done.includes(n)){
        rec.done.push(n);
        rec.done.sort((a, b) => a - b);
        rec.updated = Date.now();
        rec.email = email;
        await writeProgress(cs, rec);
      }
    }
    return res.status(200).json({ ok:true, email, product, done: rec.done });
  }catch(e){
    return res.status(200).json({ ok:false, error: String(e && e.message || e).slice(0, 200) });
  }
};
