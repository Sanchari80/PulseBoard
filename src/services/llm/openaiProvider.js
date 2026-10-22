'use strict';

const { postJson, extractJson, LlmError } = require('./http');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompts');

/** OpenAI Chat Completions – also works with any OpenAI-compatible endpoint via OPENAI_BASE_URL. */
function createOpenAIProvider({ apiKey, model, baseUrl }) {
  return {
    name: 'openai',
    model,
    async generate(items) {
      const data = await postJson(
        `${baseUrl}/chat/completions`,
        {
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(items) },
          ],
        },
        { headers: { authorization: `Bearer ${apiKey}` } }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new LlmError('OpenAI returned no content');
      return extractJson(text);
    },
  };
}

module.exports = { createOpenAIProvider };
