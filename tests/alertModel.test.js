'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const Alert = require('../src/models/Alert');
const { detect } = require('../src/services/anomalyDetector');

test('a pipeline-built alert document passes the Mongo schema and serialises with an id', () => {
  const d = detect({ api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 });
  const doc = new Alert({ apiName: d.apiName, fingerprint: d.fingerprint, severity: d.severity, types: d.types, anomalies: d.anomalies, sample: d.sample, title: 't', message: 'AppointmentAPI failed with status 500.', aiSource: 'rule-based', source: 'api' });
  assert.equal(doc.validateSync(), undefined);
  const json = doc.toJSON();
  assert.equal(typeof json.id, 'string');
  assert.equal(json._id, undefined);
  assert.equal(json.status, 'active');
});

test('the schema rejects an unknown severity', () => {
  const doc = new Alert({ apiName: 'X', fingerprint: 'X::A', severity: 'meh', message: 'hello world' });
  assert.ok(doc.validateSync().errors.severity);
});
