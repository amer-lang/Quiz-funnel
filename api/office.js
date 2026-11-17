/* Sell Products AI — the Office's backend (/api/office?r=<route>).
   A whitelist proxy to DropStart's employees API (see lib/employees.js). The buyer's order id is
   taken ONLY from their login (cookie), never from the request, and is attached here, together with
   the server-side key — the browser can only ask for the routes below.

   GET  r=office                         team, store state, to-dos, approvals count
   GET  r=ledger[&cursor=N][&employee=N] what the employees did (newest first)
   GET  r=approvals                      changes waiting for the buyer, with before/after
   GET  r=creatives                      the Ad Designer's gallery (signed image links + copy)
   POST r=approve&id=N | reject&id=N (reason) | undo&id=N | bulk (decision[, employee][, ids[]: only those]) | mode&employee=N (mode)
        pause&employee=N | resume&employee=N | instructions&employee=N (instructions[]) | disconnect
        feedback&creative=N (feedback: up|down|"") | more&creative=N
   Support Rep (Sam): GET r=threads[&status=new|draft_ready|needs_owner|replied|closed][&cursor=N] | thread&id=N | ssettings
        POST tdraft&id=N (text) | tclose&id=N | tblock&id=N | tunblock&id=N | tredraft&id=N | tallow&id=N | tpropose&id=N | ssave (tone, signoff, store_name, policy) | saddress
   POSTs must be same-origin JSON (CSRF guard). */

const { identify, ours, readBody, available, isProd, hiringOpen, sameOriginJson, retryPending } = require('../lib/employees');

const ID = /^[0-9]{1,12}$/;
const ROUTES = {
  office:       { m: 'GET',  p: () => 'office' },
  ledger:       { m: 'GET',  p: () => 'ledger',    q: ['cursor', 'employee'] },
  approvals:    { m: 'GET',  p: () => 'approvals' },
  creatives:    { m: 'GET',  p: () => 'creatives' },
  approve:      { m: 'POST', p: a => 'actions/' + a.id + '/approve', need: ['id'] },
  reject:       { m: 'POST', p: a => 'actions/' + a.id + '/reject', need: ['id'], b: ['reason'] },
  undo:         { m: 'POST', p: a => 'actions/' + a.id + '/undo', need: ['id'] },
  bulk:         { m: 'POST', p: () => 'actions/bulk', b: ['decision', 'employee', 'reason', 'ids'], req: ['decision'] },
  mode:         { m: 'POST', p: a => a.employee + '/mode', need: ['employee'], b: ['mode'], req: ['mode'] },
  pause:        { m: 'POST', p: a => a.employee + '/pause', need: ['employee'] },
  resume:       { m: 'POST', p: a => a.employee + '/resume', need: ['employee'] },
  instructions: { m: 'POST', p: a => a.employee + '/instructions', need: ['employee'], b: ['instructions'], req: ['instructions'] },
  disconnect:   { m: 'POST', p: () => 'disconnect' },
  feedback:     { m: 'POST', p: a => 'creatives/' + a.creative + '/feedback', need: ['creative'], b: ['feedback'], req: ['feedback'] },
  more:         { m: 'POST', p: a => 'creatives/' + a.creative + '/more', need: ['creative'] },
  threads:      { m: 'GET',  p: () => 'support/threads', q: ['cursor'], enumq: { status: ['new', 'draft_ready', 'needs_owner', 'replied', 'closed'] } },
  thread:       { m: 'GET',  p: a => 'support/threads/' + a.id, need: ['id'] },
  ssettings:    { m: 'GET',  p: () => 'support/settings' },
  tdraft:       { m: 'POST', p: a => 'support/threads/' + a.id + '/draft', need: ['id'], b: ['text'], req: ['text'] },
  tclose:       { m: 'POST', p: a => 'support/threads/' + a.id + '/close', need: ['id'] },
  tblock:       { m: 'POST', p: a => 'support/threads/' + a.id + '/block', need: ['id'] },
  tunblock:     { m: 'POST', p: a => 'support/threads/' + a.id + '/unblock', need: ['id'] },
  tredraft:     { m: 'POST', p: a => 'support/threads/' + a.id + '/redraft', need: ['id'] },
  tallow:       { m: 'POST', p: a => 'support/threads/' + a.id + '/allow-draft', need: ['id'] },
  tpropose:     { m: 'POST', p: a => 'support/threads/' + a.id + '/propose', need: ['id'] },
  ssave:        { m: 'POST', p: () => 'support/settings', b: ['tone', 'signoff', 'store_name', 'policy'] },
  saddress:     { m: 'POST', p: () => 'support/settings/address' },
  stest:        { m: 'POST', p: () => 'support/test', b: ['to'] }
};
const TONES = ['friendly', 'professional', 'casual'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if(!available()) return res.status(404).json({ ok:false, error:'not_available' });
  if(req.method === 'OPTIONS') return res.status(204).end();

  const q = req.query || {};
  const route = ROUTES[Object.prototype.hasOwnProperty.call(ROUTES, String(q.r || '')) ? String(q.r) : ''];
  if(!route) return res.status(404).json({ ok:false, error:'unknown_route' });
  if(req.method !== route.m) return res.status(405).json({ ok:false, error:'method' });
  if(route.m === 'POST' && !sameOriginJson(req)) return res.status(403).json({ ok:false, error:'forbidden' });

  try{
    const who = await identify(req);
    if(!who) return res.status(401).json({ ok:false, error:'login_required' });

    const args = {};
    for(const k of (route.need || [])){
      const v = String(q[k] || '');
      if(!ID.test(v)) return res.status(400).json({ ok:false, error:'bad_' + k });
      args[k] = v;
    }

    const opts = { method: route.m, cs: who.cs, query: {} };
    for(const k of (route.q || [])) if(ID.test(String(q[k] || ''))) opts.query[k] = String(q[k]);
    for(const k of Object.keys(route.enumq || {})) if(route.enumq[k].includes(String(q[k] || ''))) opts.query[k] = String(q[k]);
    if(route.m === 'POST'){
      const body = await readBody(req);
      const out = {};
      for(const k of (route.b || [])) if(body[k] !== undefined) out[k] = body[k];
      for(const k of (route.req || [])) if(out[k] === undefined) return res.status(400).json({ ok:false, error:'missing_' + k });
      /* shape what we pass on: short strings, a bounded list of short strings, known values only */
      if(out.reason !== undefined) out.reason = String(out.reason).slice(0, 300);
      if(out.mode !== undefined && !['approval', 'autopilot'].includes(out.mode)) return res.status(400).json({ ok:false, error:'bad_mode' });
      if(out.decision !== undefined && !['approve', 'reject'].includes(out.decision)) return res.status(400).json({ ok:false, error:'bad_decision' });
      if(out.employee !== undefined && !ID.test(String(out.employee))) return res.status(400).json({ ok:false, error:'bad_employee' });
      if(out.feedback !== undefined && !['up', 'down', ''].includes(out.feedback)) return res.status(400).json({ ok:false, error:'bad_feedback' });
      if(out.ids !== undefined) out.ids = Array.isArray(out.ids) ? out.ids.slice(0, 100).map(String).filter(x => ID.test(x)) : [];
      /* Sam: free text is passed on as plain strings of bounded length (DropStart trims and sanitises again) */
      if(out.text !== undefined){ if(typeof out.text !== 'string') return res.status(400).json({ ok:false, error:'bad_text' }); out.text = out.text.slice(0, 8000); }
      if(out.to !== undefined){ if(typeof out.to !== 'string' || out.to.length > 254) return res.status(400).json({ ok:false, error:'bad_to' }); out.to = out.to.trim(); }
      if(out.tone !== undefined && !TONES.includes(out.tone)) return res.status(400).json({ ok:false, error:'bad_tone' });
      for(const [k, n] of [['signoff', 60], ['store_name', 80], ['policy', 1500]]) if(out[k] !== undefined){ if(typeof out[k] !== 'string') return res.status(400).json({ ok:false, error:'bad_' + k }); out[k] = out[k].slice(0, n); }
      if(out.instructions !== undefined) out.instructions = Array.isArray(out.instructions) ? out.instructions.slice(0, 10).map(s => String(s).slice(0, 500)) : [];
      opts.body = out;
    }

    /* a paid hire that could not be recorded earlier is retried whenever the buyer opens the Office */
    if(route === ROUTES.office && isProd() && hiringOpen()) await retryPending(who.cs);

    const r = await ours(route.p(args), opts);
    /* never pass an upstream auth failure or crash page through: our key being wrong is not the buyer's login problem */
    if(r.status === 401 || r.status === 403 || r.status >= 500 || !r.json) return res.status(502).json({ ok:false, error:'upstream' });
    const json = r.json;
    if(route === ROUTES.office && json && json.ok) json.preview = who.via === 'preview' || !isProd();
    return res.status(r.status).json(json);
  }catch(e){
    return res.status(200).json({ ok:false, error:'error' });
  }
};
