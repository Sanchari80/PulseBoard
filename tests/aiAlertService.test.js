'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../src/services/aiAlertService');
const { createGeminiProvider } = require('../src/services/llm/geminiProvider');
const { createOpenAIProvider } = require('../src/services/llm/openaiProvider');
const { detect } = require('../src/services/anomalyDetector');

const item = (raw, id = 'a1') => {
  const d = detect(raw);
  return { id, apiName: d.apiName, severity: d.severity, sample: d.sample, anomalies: d.anomalies, occurrences: 1 };
};
const appointment = item({ api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 });

test.afterEach(() => ai.setProvider(null));

test('without a provider the rule-based writer produces a readable alert', async () => {
  const out = await ai.generateAlerts([appointment]);
  const t = out.get('a1');
  assert.equal(t.source, 'rule-based');
  assert.equal(t.message, 'AppointmentAPI failed with status 500, took 5500 ms to respond and returned 0 records. Possible outage or data issue.');
  assert.ok(t.recommended_action.length > 10);
});

test('LLM output is used when valid', async () => {
  ai.setProvider({ name: 'mock', model: 'm1', generate: async (items) => ({ alerts: items.map((i) => ({ id: i.id, title: 'Appointments down', message: `${i.apiName} failed with status 500 and returned 0 records. Possible outage.`, likely_cause: 'Likely provider outage.', impact: 'Schedules cannot load.', recommended_action: 'Check provider status.' })) }) });
  const t = (await ai.generateAlerts([appointment])).get('a1');
  assert.equal(t.source, 'mock:m1');
  assert.equal(t.title, 'Appointments down');
});

test('falls back per item when the LLM names the wrong API or returns junk', async () => {
  ai.setProvider({ name: 'mock', model: 'm1', generate: async () => ({ alerts: [{ id: 'a1', title: 'Wrong', message: 'BillingAPI is down and nobody knows why.' }] }) });
  assert.equal((await ai.generateAlerts([appointment])).get('a1').source, 'rule-based');
});

test('falls back when the LLM call throws', async () => {
  ai.setProvider({ name: 'mock', model: 'm1', generate: async () => { throw new Error('HTTP 429'); } });
  assert.equal((await ai.generateAlerts([appointment])).get('a1').source, 'rule-based');
});

test('items are chunked across several LLM calls', async () => {
  let calls = 0;
  ai.setProvider({ name: 'mock', model: 'm1', generate: async (items) => { calls += 1; return { alerts: items.map((i) => ({ id: i.id, title: 'Slow API', message: `${i.apiName} is slow at the moment, possibly degraded.` })) }; } });
  const items = Array.from({ length: 20 }, (_, n) => item({ api_name: `API${n}`, response_time_ms: 3000, status_code: 200, records_returned: 1 }, `a${n}`));
  const out = await ai.generateAlerts(items);
  assert.equal(out.size, 20);
  assert.ok(calls >= 3);
});

function mockFetch(responseBody, capture) {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    capture.url = url;
    capture.init = init;
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { global.fetch = original; };
}

test('Gemini provider builds the request and parses JSON (even inside code fences)', async () => {
  const cap = {};
  const text = '```json\n{"alerts":[{"id":"a1","title":"Outage","message":"AppointmentAPI failed with status 500 and returned 0 records. Possible outage or data issue."}]}\n```';
  const restore = mockFetch({ candidates: [{ content: { parts: [{ text }] } }] }, cap);
  try {
    const p = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const json = await p.generate([appointment]);
    assert.equal(json.alerts[0].title, 'Outage');
    assert.match(cap.url, /gemini-2\.5-flash:generateContent/);
    assert.equal(cap.init.headers['x-goog-api-key'], 'k');
    const body = JSON.parse(cap.init.body);
    assert.match(body.systemInstruction.parts[0].text, /home-healthcare/);
    assert.match(body.contents[0].parts[0].text, /AppointmentAPI/);
  } finally {
    restore();
  }
});

test('OpenAI-compatible provider builds the request and parses JSON', async () => {
  const cap = {};
  const restore = mockFetch({ choices: [{ message: { content: '{"alerts":[{"id":"a1","title":"Outage","message":"AppointmentAPI failed."}]}' } }] }, cap);
  try {
    const p = createOpenAIProvider({ apiKey: 'sk', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' });
    const json = await p.generate([appointment]);
    assert.equal(json.alerts[0].id, 'a1');
    assert.equal(cap.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(cap.init.headers.authorization, 'Bearer sk');
    assert.equal(JSON.parse(cap.init.body).response_format.type, 'json_object');
  } finally {
    restore();
  }
});
