/* Sell Products AI — "10 Profit Emails" generator + fulfillment.
   Vercel serverless function at /api/emailpack.

   Writes the 10-email pack (abandoned cart, welcome, post-purchase, win-back,
   review, flash sale) personalized to the buyer's product with OpenAI, and
   caches it in Vercel Blob at emailpack/<pi>.json — one generation per order,
   ever. The buyer reads it at /emails?cs=<pi> (their durable delivery page).

   GET ?cs=<pi_…>  — the buyer's PAID add-ons PaymentIntent that includes
                     profit_emails. Verifies with Stripe (fail closed),
                     serves the cached pack or generates it (~20-40s once).
   Degrades to {ready:false, status} so the page can show a retry state. */

const PENDING_TTL = 180000;

function keys(){ return { sk: process.env.STRIPE_SECRET_KEY || '' }; }

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

async function stripeGet(path){
  const { sk } = keys();
  const r = await fetch('https://api.stripe.com/v1/' + path, { headers: { Authorization: 'Bearer ' + sk } });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error((j.error && j.error.message) || ('stripe ' + r.status));
  return j;
}

/* the order must be a succeeded add-ons charge that includes profit_emails */
async function verifyOrder(pi){
  const p = await stripeGet('payment_intents/' + encodeURIComponent(pi));
  const ok = p.status === 'succeeded' && p.metadata &&
    p.metadata.type === 'store_addons' &&
    String(p.metadata.items || '').split(',').map(s => s.trim()).includes('profit_emails');
  if(!ok) return null;
  let product = String(p.metadata.product || '');
  if(!product && p.metadata.base_cs){
    try{
      const s = await stripeGet('checkout/sessions/' + encodeURIComponent(p.metadata.base_cs));
      product = String((s.metadata && s.metadata.product) || '');
    }catch(e){}
  }
  return { product: product || 'your product' };
}

const SYS = 'You are a world-class e-commerce email copywriter. You write plain-spoken, high-converting emails for small one-product Shopify stores. Punchy subject lines under 45 characters. Bodies 60-140 words, short paragraphs, one clear call to action, no fluff, no fake statistics, no ALL-CAPS spam. Use the placeholders [STORE LINK] where the store URL goes and [DISCOUNT CODE] where a discount code goes.';

const USER = (product) => 'Write exactly 10 emails for a Shopify store that sells one product: "' + product + '".\n' +
  'Return STRICT JSON — an array of 10 objects, each {"tag","subject","preview","body"} — and nothing else.\n' +
  'The 10 emails, in order:\n' +
  '1 tag "WELCOME 1" — subscriber welcome, introduce the product, soft link.\n' +
  '2 tag "WELCOME 2" — the story/problem the product solves.\n' +
  '3 tag "CART RECOVERY 1" — sent 1 hour after abandoned checkout, friendly nudge.\n' +
  '4 tag "CART RECOVERY 2" — 24 hours, add urgency, mention [DISCOUNT CODE] for 10% off.\n' +
  '5 tag "CART RECOVERY 3" — 72 hours, last call, code expires tonight.\n' +
  '6 tag "POST-PURCHASE" — thank you + what happens next + ask to reply with questions.\n' +
  '7 tag "REVIEW REQUEST" — a week after delivery, ask for a quick review.\n' +
  '8 tag "WIN-BACK 1" — 30 days inactive, we miss you + what is new.\n' +
  '9 tag "WIN-BACK 2" — 45 days, [DISCOUNT CODE] comeback offer.\n' +
  '10 tag "FLASH SALE" — 48-hour sale broadcast for [DISCOUNT CODE].\n' +
  'Bodies are plain text with \\n\\n between paragraphs. Sign off as "The team".';

async function generate(product){
  const key = process.env.OPENAI_API_KEY;
  if(!key) return { error: 'no_key' };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini', temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYS },
        // json_object mode needs an object — ask for {"emails":[...]}
        { role: 'user', content: USER(product) + '\nWrap the array as {"emails":[...]}.' }
      ]
    })
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) return { error: 'gen_failed', detail: (j.error && j.error.message) || '' };
  try{
    const parsed = JSON.parse(j.choices[0].message.content);
    const emails = (parsed.emails || parsed).slice(0, 10)
      .filter(e => e && e.subject && e.body)
      .map(e => ({ tag: String(e.tag || ''), subject: String(e.subject || ''),
        preview: String(e.preview || ''), body: String(e.body || '') }));
    if(emails.length < 8) return { error: 'thin_output' };
    return { emails };
  }catch(e){ return { error: 'parse_failed' }; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.sellproducts.ai');
  res.setHeader('Cache-Control', 'no-store');
  try{
    const pi = String((req.query || {}).cs || '').slice(0, 300);
    if(!/^pi_[A-Za-z0-9_]+$/.test(pi)) return res.status(400).json({ ready:false, status:'bad_order' });

    const { list, put } = await import('@vercel/blob');
    const path = 'emailpack/' + pi + '.json';

    /* cached? serve it (also covers concurrent viewers) */
    const page = await list(blobOpts({ prefix: 'emailpack/' + pi, limit: 10 }));
    const hit = (page.blobs || []).find(b => b.pathname === path);
    if(hit){
      const j = await fetch(hit.url).then(r => r.json()).catch(() => null);
      if(j) return res.status(200).json({ ready:true, product: j.product, emails: j.emails });
    }
    const pending = (page.blobs || []).find(b => b.pathname === 'emailpack/.pending-' + pi);
    if(pending && Date.now() - new Date(pending.uploadedAt).getTime() < PENDING_TTL)
      return res.status(200).json({ ready:false, status:'generating' });

    /* verify payment (fail closed), then generate once */
    const order = await verifyOrder(pi);
    if(!order) return res.status(200).json({ ready:false, status:'not_paid' });

    await put('emailpack/.pending-' + pi, String(Date.now()), blobOpts({
      access: 'public', addRandomSuffix: false, contentType: 'text/plain' }));

    const g = await generate(order.product);
    if(g.error) return res.status(200).json({ ready:false, status: g.error, detail: g.detail || '' });

    const payload = { product: order.product, emails: g.emails, made: Date.now() };
    await put(path, JSON.stringify(payload), blobOpts({
      access: 'public', addRandomSuffix: false, contentType: 'application/json' }));

    return res.status(200).json({ ready:true, product: order.product, emails: g.emails });
  }catch(e){
    return res.status(200).json({ ready:false, status:'error', detail: String(e && e.message || e).slice(0, 200) });
  }
};
