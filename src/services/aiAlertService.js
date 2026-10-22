'use strict';

const { z } = require('zod');
const config = require('../config');
const logger = require('../utils/logger').for('ai');
const { chunk, mapLimit } = require('../utils/concurrency');
const { createGeminiProvider } = require('./llm/geminiProvider');
const { createOpenAIProvider } = require('./llm/openaiProvider');
const ruleBased = require('./llm/ruleBasedWriter');
const { PROMPT_VERSION } = require('./llm/prompts');

const alertTextSchema = z.object({
  id: z.string(),
  title: z.string().min(3).max(120),
  message: z.string().min(10).max(600),
  likely_cause: z.string().max(400).optional().default(''),
  impact: z.string().max(400).optional().default(''),
  recommended_action: z.string().max(400).optional().default(''),
});

function resolveProvider(aiConfig = config.ai) {
  const { provider, gemini, openai } = aiConfig;
  if (provider === 'none') return null;
  if ((provider === 'gemini' || !provider) && gemini.apiKey) return createGeminiProvider(gemini);
  if ((provider === 'openai' || !provider) && openai.apiKey) return createOpenAIProvider(openai);
  if (provider && provider !== 'none') logger.warn(`AI_PROVIDER="${provider}" but no API key is set – using rule-based alerts`);
  return null;
}

let provider = resolveProvider();

/** Test hook / runtime switch. */
function setProvider(p) {
  provider = p;
}
function getProviderInfo() {
  return provider ? { provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION } : { provider: 'rule-based', model: null, promptVersion: PROMPT_VERSION };
}

const ruleBasedResult = (item) => ({ ...ruleBased.describe(item), source: 'rule-based' });

/**
 * Generate human-readable alert text for a list of anomaly groups.
 * Items are sent in chunks (one LLM call per chunk, several chunks in parallel), and any
 * item the model fails on falls back to the rule-based writer. Never throws.
 *
 * @param {Array<{id:string, apiName:string, severity:string, sample:object, anomalies:object[], occurrences?:number}>} items
 * @returns {Promise<Map<string, {title,message,likely_cause,impact,recommended_action,source}>>}
 */
async function generateAlerts(items) {
  const out = new Map();
  if (!items.length) return out;

  if (!provider) {
    for (const it of items) out.set(it.id, ruleBasedResult(it));
    return out;
  }

  const source = `${provider.name}:${provider.model}`;
  const chunks = chunk(items, config.batch.aiChunkSize);

  await mapLimit(chunks, config.batch.aiConcurrency, async (group) => {
    const started = Date.now();
    try {
      const json = await provider.generate(group);
      const list = Array.isArray(json?.alerts) ? json.alerts : [];
      const byId = new Map();
      for (const raw of list) {
        const parsed = alertTextSchema.safeParse(raw);
        if (parsed.success) byId.set(parsed.data.id, parsed.data);
      }
      for (const it of group) {
        const ai = byId.get(it.id);
        // Guard against hallucinated attribution: the message must name the right API.
        if (ai && (it.apiName === 'Unidentified API' || ai.message.includes(it.apiName))) {
          out.set(it.id, { title: ai.title, message: ai.message, likely_cause: ai.likely_cause, impact: ai.impact, recommended_action: ai.recommended_action, source });
        } else {
          out.set(it.id, ruleBasedResult(it));
        }
      }
      logger.info(`Generated ${group.length} alert(s) with ${source} in ${Date.now() - started} ms`);
    } catch (err) {
      logger.warn(`AI generation failed for ${group.length} alert(s), using rule-based text: ${err.message}`);
      for (const it of group) out.set(it.id, ruleBasedResult(it));
    }
  });

  return out;
}

module.exports = { generateAlerts, setProvider, getProviderInfo, resolveProvider };
