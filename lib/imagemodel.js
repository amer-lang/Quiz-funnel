/* OpenAI image model selection with fallback.
   gpt-image-1 was retired by OpenAI (every call since 2026-10-23 answered
   "The model 'gpt-image-1' does not exist"), which silently stopped the $49
   ad packs and the pack-shot teasers. Instead of pinning one name again, try a
   short list in order and remember the first one that works for the life of
   the function instance. OPENAI_IMAGE_MODEL (env) goes first when set. */

const DEFAULTS = ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-1.5', 'gpt-image-1-mini']; // gpt-image-1.5 and -mini retire 2026-12-01

function candidates(){
  const env = String(process.env.OPENAI_IMAGE_MODEL || '').trim();
  return (env ? [env] : []).concat(DEFAULTS.filter(m => m !== env));
}

let working = '';
const isMissingModel = (status, out) => {
  const msg = String((out && out.error && (out.error.message || out.error.code)) || '').toLowerCase();
  return (status === 404 || status === 400 || status === 403) && /model|does not exist|not found|not supported|unsupported|access/.test(msg);
};

/* run(fn): fn(model) -> { status, out }. Walks the candidates on "no such model"
   answers, stops on the first real answer (success or any other error). */
async function run(fn){
  const list = working ? [working].concat(candidates().filter(m => m !== working)) : candidates();
  let last = { status: 0, out: null, model: '' };
  for(const model of list){
    const r = await fn(model);
    last = { status: r.status, out: r.out, model };
    if(r.status >= 200 && r.status < 300){ working = model; return last; }
    if(!isMissingModel(r.status, r.out)) return last;
    if(working === model) working = '';
  }
  return last;
}

/* owner probe: which image-capable models this key can see */
async function listModels(key){
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  const ids = ((j && j.data) || []).map(m => m.id).filter(id => /image|dall/i.test(id)).sort();
  return { status: r.status, image_models: ids, candidates: candidates(), working: working || null, error: j && j.error && j.error.message };
}

module.exports = { run, listModels, candidates, current: () => working };
