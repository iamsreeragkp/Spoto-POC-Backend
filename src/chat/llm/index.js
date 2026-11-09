// LLM adapter selector. Add a provider = add a file exporting { name, plan(), analyzeComments() } and register it here.
const providers = {
  openai: () => require('./openai'),
  mock: () => require('./mock'),
};

function getLlm() {
  const name = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
  if (!providers[name]) throw new Error(`Unknown LLM_PROVIDER "${name}" (available: ${Object.keys(providers).join(', ')})`);
  return providers[name]();
}

module.exports = { getLlm };
