'use strict';

const config = require('../../config');

class LlmError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** POST JSON with a timeout and bounded exponential-backoff retries on 429 / 5xx / network errors. */
async function postJson(url, body, { headers = {}, timeoutMs = config.ai.timeoutMs, retries = config.ai.retries } = {}) {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new LlmError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new LlmError('LLM returned a non-JSON HTTP body');
      }
    } catch (err) {
      const e = err.name === 'AbortError' ? new LlmError(`LLM request timed out after ${timeoutMs} ms`, { retryable: true }) : err instanceof LlmError ? err : new LlmError(err.message, { retryable: true });
      if (!e.retryable || attempt >= retries) throw e;
      attempt += 1;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Models sometimes wrap JSON in ```json fences or add prose – extract the first JSON object. */
function extractJson(text) {
  if (typeof text !== 'string') throw new LlmError('Empty LLM response');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new LlmError('LLM response did not contain JSON');
  }
}

module.exports = { postJson, extractJson, LlmError };
