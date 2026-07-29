/* Sell Products AI — ActiveCampaign bridge.
   Runs server-side so the AC API key never reaches the browser.

   POST {email, stage}   stage: optin → list 5 · unlocked → list 6 · videoads → list 7
     Syncs the contact into ActiveCampaign and subscribes it to the mapped list.
   GET  ?actest=<KEY>    Verifies the AC connection and returns the three lists'
                         names so the mapping can be sanity-checked. */

const AC_URL = 'https://sellproducts.api-us1.com';
const AC_KEY = 'd84c8bf84307d5b159099552ae63a16a92af944cac522e0ff3ea8ece4bae99b7350dab92';
const TEST_KEY = '6312341a658ce448a5799db99675154dc0f161dd042da6b3e1e2bff5532ff899';

const STAGE_LIST = { optin: 5, unlocked: 6, videoads: 7 };
const OK_ORIGINS = /^https:\/\/(www\.)?sellproducts\.ai$/;

async function ac(path, method, body){
  const r = await fetch(AC_URL + path, {
    method: method || 'GET',
    headers: { 'Api-Token': AC_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.status >= 200 && r.status < 300, j };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if(req.method === 'OPTIONS') return res.status(204).end();

  try{
    if(req.method === 'GET'){
      if((req.query || {}).actest !== TEST_KEY) return res.status(403).json({ error: 'bad key' });
      const out = {};
      for(const [stage, id] of Object.entries(STAGE_LIST)){
        const r = await ac('/api/3/lists/' + id);
        out[stage] = { listId: id, name: r.ok && r.j.list ? r.j.list.name : ('ERROR ' + r.status) };
      }
      let wrote = null;
      if((req.query || {}).write === '1'){
        // exercise the REAL write path with a test contact into the opt-in list
        const sync = await ac('/api/3/contact/sync', 'POST', { contact: { email: 'integration-test@sellproducts.ai' } });
        const cid = sync.ok && sync.j.contact ? sync.j.contact.id : null;
        const sub = cid ? await ac('/api/3/contactLists', 'POST', { contactList: { list: STAGE_LIST.optin, contact: cid, status: 1 } }) : { ok: false };
        wrote = { contactId: cid, subscribed: sub.ok };
      }
      return res.status(200).json({ ok: true, lists: out, wrote });
    }

    if(req.method === 'POST'){
      // Beacons from the funnel carry no Origin sometimes; when one IS present
      // it must be ours (or localhost during testing).
      const origin = req.headers.origin || '';
      if(origin && !OK_ORIGINS.test(origin) && !/^https?:\/\/localhost/.test(origin))
        return res.status(204).end();

      let body = req.body;
      if(typeof body === 'string'){ try{ body = JSON.parse(body); }catch(e){ body = null; } }
      const email = body && String(body.email || '').trim().toLowerCase().slice(0, 120);
      const stage = body && String(body.stage || '');
      const listId = STAGE_LIST[stage];
      if(!listId || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(204).end();

      const sync = await ac('/api/3/contact/sync', 'POST', { contact: { email } });
      const contactId = sync.ok && sync.j.contact ? sync.j.contact.id : null;
      if(!contactId) return res.status(502).json({ error: 'ac sync failed' });

      const sub = await ac('/api/3/contactLists', 'POST', {
        contactList: { list: listId, contact: contactId, status: 1 }
      });
      if(!sub.ok) return res.status(502).json({ error: 'ac list subscribe failed' });

      return res.status(204).end();
    }

    return res.status(405).json({ error: 'method' });
  }catch(err){
    return res.status(500).json({ error: 'lead bridge error' });
  }
};
