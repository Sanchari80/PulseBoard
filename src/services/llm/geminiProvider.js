'use strict';

const { postJson, extractJson, LlmError } = require('./http');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompts');

/** Google Gemini via the REST generateContent endpoint (no SDK needed). */
function createGeminiProvider({ apiKey, model }) {
  return {
    name: 'gemini',
    model,
    async generate(items) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const data = await postJson(
        url,
        {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: buildUserPrompt(items) }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 4096 },
        },
        { headers: { 'x-goog-api-key': apiKey } }
      );
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (!text) throw new LlmError(`Gemini returned no content (finishReason: ${data?.candidates?.[0]?.finishReason || 'unknown'})`);
      return extractJson(text);
    },
  };
}

module.exports = { createGeminiProvider };
