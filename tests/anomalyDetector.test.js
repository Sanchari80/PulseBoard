'use strict';
require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('../src/services/anomalyDetector');

test('healthy response has no anomalies', () => {
  const r = detect({ api_name: 'PatientDataAPI', response_time_ms: 1200, status_code: 200, records_returned: 50 });
  assert.equal(r.isAnomalous, false);
  assert.equal(r.severity, null);
});

test('the assignment example: 500 + slow + zero records is critical', () => {
  const r = detect({ api_name: 'AppointmentAPI', response_time_ms: 5500, status_code: 500, records_returned: 0 });
  assert.equal(r.severity, 'critical');
  assert.deepEqual(r.types, ['HIGH_RESPONSE_TIME', 'SERVER_ERROR', 'ZERO_RECORDS']);
  assert.equal(r.fingerprint, 'AppointmentAPI::HIGH_RESPONSE_TIME+SERVER_ERROR+ZERO_RECORDS');
});

test('response time thresholds: warning then critical', () => {
  assert.equal(detect({ api_name: 'X', response_time_ms: 2500, status_code: 200, records_returned: 3 }).severity, 'warning');
  assert.equal(detect({ api_name: 'X', response_time_ms: 9000, status_code: 200, records_returned: 3 }).severity, 'critical');
});

test('per-API rules override global thresholds', () => {
  // BillingAPI warns at 3000 ms (src/config/apiRules.json), so 2500 ms is fine
  assert.equal(detect({ api_name: 'BillingAPI', response_time_ms: 2500, status_code: 200, records_returned: 3 }).isAnomalous, false);
});

test('timeouts and connection failures are critical', () => {
  assert.ok(detect({ api_name: 'X', response_time_ms: 100, status_code: 504, records_returned: 0 }).types.includes('TIMEOUT'));
  assert.equal(detect({ api_name: 'X', response_time_ms: 100, status_code: 0, records_returned: 0 }).severity, 'critical');
});

test('4xx is a warning, 429 is rate limited', () => {
  assert.deepEqual(detect({ api_name: 'X', response_time_ms: 100, status_code: 404, records_returned: 0 }).types, ['CLIENT_ERROR', 'ZERO_RECORDS']);
  assert.ok(detect({ api_name: 'X', response_time_ms: 100, status_code: 429, records_returned: 0 }).types.includes('RATE_LIMITED'));
});

test('invalid HTTP status codes are not classified as request failures', () => {
  for (const status of [99, 600, 700, 200.5]) {
    const result = detect({ api_name: 'X', response_time_ms: 100, status_code: status, records_returned: 5 });
    assert.ok(result.types.includes('INVALID_FIELD'), `status ${status} should be invalid`);
    assert.ok(!result.types.includes('SERVER_ERROR'), `status ${status} should not be a server error`);
    assert.ok(!result.types.includes('INCONSISTENT_PAYLOAD'), `status ${status} should not be treated as a failed request`);
  }
});

test('zero records on a successful call is flagged', () => {
  const r = detect({ api_name: 'X', response_time_ms: 300, status_code: 200, records_returned: 0 });
  assert.deepEqual(r.types, ['ZERO_RECORDS']);
  assert.equal(r.severity, 'warning');
});

test('missing, negative and non-numeric fields are data-integrity anomalies', () => {
  assert.ok(detect({ api_name: 'X', response_time_ms: 300, status_code: 200 }).types.includes('MISSING_FIELD'));
  assert.ok(detect({ api_name: 'X', response_time_ms: 300, status_code: 200, records_returned: -3 }).types.includes('INVALID_FIELD'));
  assert.ok(detect({ api_name: 'X', response_time_ms: 'fast', status_code: 200, records_returned: 1 }).types.includes('INVALID_FIELD'));
});

test('numeric strings are accepted but noted without raising an alert', () => {
  const r = detect({ api_name: 'X', response_time_ms: '300', status_code: 200, records_returned: 4 });
  assert.equal(r.isAnomalous, false);
  assert.equal(r.anomalies[0].severity, 'info');
});

test('failed request that still reports records is inconsistent', () => {
  assert.ok(detect({ api_name: 'X', response_time_ms: 300, status_code: 500, records_returned: 12 }).types.includes('INCONSISTENT_PAYLOAD'));
});

test('malformed entries never throw', () => {
  for (const bad of [{}, null, 42, 'text', [], { response_time_ms: 10 }]) {
    const r = detect(bad);
    assert.equal(r.attributable, false);
    assert.ok(r.types.includes('MALFORMED_RESPONSE'));
  }
});

test('latency spike against the API\'s own baseline', () => {
  const baseline = () => ({ samples: 20, mean: 300, std: 40 });
  const r = detect({ api_name: 'X', response_time_ms: 1500, status_code: 200, records_returned: 5 }, { baseline });
  assert.deepEqual(r.types, ['LATENCY_SPIKE']);
  const normal = detect({ api_name: 'X', response_time_ms: 360, status_code: 200, records_returned: 5 }, { baseline });
  assert.equal(normal.isAnomalous, false);
});
