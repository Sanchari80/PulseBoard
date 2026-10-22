'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { setRepository } = require('../src/repositories');
const MemoryAlertRepository = require('../src/repositories/memoryAlertRepository');
const registry = require('../src/services/apiHealthRegistry');

const EXAMPLE = [
  { api_name: 'PatientDataAPI', response_time_ms: 1200, status_code: 200, records_returned: 50 },
  { api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 },
];

let app;
test.beforeEach(() => {
  setRepository(new MemoryAlertRepository());
  registry.reset();
  app = createApp();
});

test('GET /health', async () => {
  const res = await request(app).get('/health').expect(200);
  assert.equal(res.body.status, 'ok');
});

test('POST /monitor detects the anomaly and stores an AI/rule alert', async () => {
  const res = await request(app).post('/monitor').send(EXAMPLE).expect(201);
  assert.equal(res.body.summary.received, 2);
  assert.equal(res.body.summary.healthy, 1);
  assert.equal(res.body.summary.alertsCreated, 1);
  assert.equal(res.body.results[1].status, 'anomaly');

  const alerts = await request(app).get('/alerts').expect(200);
  assert.equal(alerts.body.total, 1);
  const a = alerts.body.items[0];
  assert.equal(a.apiName, 'AppointmentAPI');
  assert.equal(a.severity, 'critical');
  assert.equal(a.status, 'active');
  assert.match(a.message, /AppointmentAPI failed with status 500/);
  assert.match(a.message, /0 records/);
});

test('single object and { responses: [] } bodies are accepted', async () => {
  await request(app).post('/monitor').send(EXAMPLE[1]).expect(201);
  const res = await request(app).post('/monitor').send({ responses: [EXAMPLE[0]] }).expect(200);
  assert.equal(res.body.summary.alertsCreated, 0);
});

test('repeated incidents are de-duplicated into one alert with an occurrence count', async () => {
  await request(app).post('/monitor').send([EXAMPLE[1]]).expect(201);
  const res = await request(app).post('/monitor').send([EXAMPLE[1], EXAMPLE[1]]).expect(200);
  assert.equal(res.body.summary.alertsUpdated, 1);
  const { body } = await request(app).get('/alerts');
  assert.equal(body.total, 1);
  assert.equal(body.items[0].occurrences, 3);
});

test('escalation from warning to critical rewrites the alert text', async () => {
  await request(app).post('/monitor').send([{ api_name: 'X', response_time_ms: 2500, status_code: 200, records_returned: 5 }]).expect(201);
  await request(app).post('/monitor').send([{ api_name: 'X', response_time_ms: 7000, status_code: 200, records_returned: 5 }]).expect(200);
  const { body } = await request(app).get('/alerts');
  assert.equal(body.items[0].severity, 'critical');
  assert.match(body.items[0].message, /7000 ms/);
});

test('batch with malformed items is processed, not rejected', async () => {
  const res = await request(app).post('/monitor').send([...EXAMPLE, {}, null, { api_name: 'LabResultsAPI', response_time_ms: 300, status_code: 200, records_returned: -1 }]).expect(201);
  assert.equal(res.body.summary.received, 5);
  assert.equal(res.body.summary.invalid, 2);
  assert.equal(res.body.results[2].status, 'invalid');
});

test('large batches are handled', async () => {
  const batch = Array.from({ length: 500 }, (_, i) => ({ api_name: `API_${i % 25}`, response_time_ms: i % 7 === 0 ? 6000 : 300, status_code: i % 11 === 0 ? 503 : 200, records_returned: 10 }));
  const res = await request(app).post('/monitor').send(batch).expect(201);
  assert.equal(res.body.summary.received, 500);
  const { body } = await request(app).get('/alerts?limit=500');
  // one open incident per API + problem combination, not one per response
  assert.ok(body.total < 100);
});

test('validation errors return 400 with a clear message', async () => {
  const bad = await request(app).post('/monitor').set('content-type', 'application/json').send('{oops').expect(400);
  assert.equal(bad.body.error.code, 'BAD_REQUEST');
  await request(app).post('/monitor').send([]).expect(400);
  await request(app).get('/alerts?status=nope').expect(400);
});

test('resolve, reopen and filters', async () => {
  await request(app).post('/monitor').send([EXAMPLE[1], { api_name: 'B', response_time_ms: 2500, status_code: 200, records_returned: 1 }]).expect(201);
  const { body } = await request(app).get('/alerts?severity=critical');
  assert.equal(body.total, 1);
  const id = body.items[0].id;

  await request(app).patch(`/alerts/${id}/resolve`).expect(200);
  assert.equal((await request(app).get('/alerts')).body.total, 1);
  assert.equal((await request(app).get('/alerts?status=resolved')).body.total, 1);
  assert.equal((await request(app).get('/alerts?q=appointment&status=all')).body.total, 1);

  await request(app).patch(`/alerts/${id}/reopen`).expect(200);
  const stats = await request(app).get('/alerts/stats').expect(200);
  assert.equal(stats.body.active, 2);
  assert.equal(stats.body.critical, 1);
});

test('unknown alert id returns 404', async () => {
  await request(app).get('/alerts/does-not-exist').expect(404);
  await request(app).patch('/alerts/does-not-exist/resolve').expect(404);
});

test('sample file and simulation endpoints', async () => {
  const sample = await request(app).post('/monitor/sample').expect(200);
  assert.ok(sample.body.summary.anomalous >= 5);
  const sim = await request(app).post('/monitor/simulate?count=30').expect(200);
  assert.equal(sim.body.summary.received, 30);
  const apis = await request(app).get('/monitor/apis').expect(200);
  assert.ok(apis.body.items.length >= 5);
});

test('email report returns 503 when SMTP is not configured', async () => {
  const res = await request(app).post('/alerts/report/email').expect(503);
  assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
});

test('API is also available under /api prefix and the UI is served', async () => {
  await request(app).get('/api/alerts').expect(200);
  const ui = await request(app).get('/').expect(200);
  assert.match(ui.text, /Pulseboard/);
});
