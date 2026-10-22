'use strict';

const config = require('../config');
const apiRules = require('../config/apiRules.json');

const SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };
const maxSeverity = (list) =>
  list.reduce((max, s) => (!max || SEVERITY_RANK[s] > SEVERITY_RANK[max] ? s : max), null);

/** Anomaly catalogue – the single source of truth for types and their default severities. */
const TYPES = {
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  INVALID_FIELD: 'INVALID_FIELD',
  MISSING_FIELD: 'MISSING_FIELD',
  HIGH_RESPONSE_TIME: 'HIGH_RESPONSE_TIME',
  LATENCY_SPIKE: 'LATENCY_SPIKE',
  SERVER_ERROR: 'SERVER_ERROR',
  TIMEOUT: 'TIMEOUT',
  CLIENT_ERROR: 'CLIENT_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  ZERO_RECORDS: 'ZERO_RECORDS',
  INCONSISTENT_PAYLOAD: 'INCONSISTENT_PAYLOAD',
};

const UNKNOWN_API = 'Unidentified API';

function rulesFor(apiName) {
  const t = config.thresholds;
  const o = apiRules[apiName] || {};
  return {
    responseTimeWarnMs: o.responseTimeWarnMs ?? t.responseTimeWarnMs,
    responseTimeCriticalMs: o.responseTimeCriticalMs ?? t.responseTimeCriticalMs,
    minRecords: o.minRecords ?? t.minRecords,
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Numeric strings ("1200") are accepted but reported, because they signal an inconsistent contract. */
function readNumber(raw, field, anomalies) {
  const value = raw[field];
  if (value === undefined || value === null || value === '') return { present: false, value: null };
  if (isNum(value)) return { present: true, value };
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    anomalies.push({ type: TYPES.INVALID_FIELD, severity: 'info', field, value, detail: `${field} was sent as a string ("${value}") instead of a number` });
    return { present: true, value: Number(value) };
  }
  anomalies.push({ type: TYPES.INVALID_FIELD, severity: 'warning', field, value, detail: `${field} has a non-numeric value (${JSON.stringify(value)})` });
  return { present: true, value: null };
}

/**
 * Inspect one raw API response and return every anomaly found.
 * Pure function apart from the read-only baseline lookup, so it is trivial to unit-test.
 *
 * @param {unknown} raw          A single item from the batch.
 * @param {{ baseline?: (api:string)=>{samples:number,mean:number,std:number} }} [ctx]
 */
function detect(raw, ctx = {}) {
  const anomalies = [];

  if (!isPlainObject(raw)) {
    anomalies.push({ type: TYPES.MALFORMED_RESPONSE, severity: 'warning', detail: `Entry is ${Array.isArray(raw) ? 'an array' : raw === null ? 'null' : typeof raw}, expected an object` });
    return finalize(UNKNOWN_API, {}, anomalies, false);
  }

  const apiName = typeof raw.api_name === 'string' && raw.api_name.trim() ? raw.api_name.trim().slice(0, 120) : null;
  if (!apiName) {
    const empty = Object.keys(raw).length === 0;
    anomalies.push({ type: TYPES.MALFORMED_RESPONSE, severity: 'warning', field: 'api_name', detail: empty ? 'Entry is an empty object – no fields were reported' : 'api_name is missing, so the response cannot be attributed to an API' });
    return finalize(UNKNOWN_API, pickSample(raw), anomalies, false);
  }

  const rules = rulesFor(apiName);
  const rt = readNumber(raw, 'response_time_ms', anomalies);
  const sc = readNumber(raw, 'status_code', anomalies);
  const rc = readNumber(raw, 'records_returned', anomalies);
  const sample = { response_time_ms: rt.value, status_code: sc.value, records_returned: rc.value };

  // ---- HTTP status --------------------------------------------------------
  const status = sc.value;
  const validStatus = status === 0 || (Number.isInteger(status) && status >= 100 && status <= 599);
  const failed = validStatus && (status === 0 || status >= 400);
  if (!sc.present) {
    anomalies.push({ type: TYPES.MISSING_FIELD, severity: 'warning', field: 'status_code', detail: 'status_code is missing' });
  } else if (status !== null) {
    if (!validStatus) {
      anomalies.push({ type: TYPES.INVALID_FIELD, severity: 'warning', field: 'status_code', value: status, detail: `status_code ${status} is not a valid HTTP status` });
    } else if (status === 0 || status === 408 || status === 504) {
      anomalies.push({ type: TYPES.TIMEOUT, severity: 'critical', field: 'status_code', value: status, detail: status === 0 ? 'No response received (connection failed)' : `Upstream timed out (HTTP ${status})` });
    } else if (status >= 500) {
      anomalies.push({ type: TYPES.SERVER_ERROR, severity: 'critical', field: 'status_code', value: status, detail: `Server error (HTTP ${status})` });
    } else if (status === 429) {
      anomalies.push({ type: TYPES.RATE_LIMITED, severity: 'warning', field: 'status_code', value: status, detail: 'Rate limited by the provider (HTTP 429)' });
    } else if (status >= 400) {
      anomalies.push({ type: TYPES.CLIENT_ERROR, severity: 'warning', field: 'status_code', value: status, detail: `Request rejected (HTTP ${status})` });
    }
  }

  // ---- Response time -------------------------------------------------------
  const ms = rt.value;
  if (!rt.present) {
    anomalies.push({ type: TYPES.MISSING_FIELD, severity: 'warning', field: 'response_time_ms', detail: 'response_time_ms is missing' });
  } else if (ms !== null) {
    if (ms < 0) {
      anomalies.push({ type: TYPES.INVALID_FIELD, severity: 'warning', field: 'response_time_ms', value: ms, detail: `response_time_ms is negative (${ms})` });
    } else if (ms >= rules.responseTimeCriticalMs) {
      anomalies.push({ type: TYPES.HIGH_RESPONSE_TIME, severity: 'critical', field: 'response_time_ms', value: ms, threshold: rules.responseTimeCriticalMs, detail: `Response took ${ms} ms (critical limit ${rules.responseTimeCriticalMs} ms)` });
    } else if (ms >= rules.responseTimeWarnMs) {
      anomalies.push({ type: TYPES.HIGH_RESPONSE_TIME, severity: 'warning', field: 'response_time_ms', value: ms, threshold: rules.responseTimeWarnMs, detail: `Response took ${ms} ms (warning limit ${rules.responseTimeWarnMs} ms)` });
    } else if (ctx.baseline && !failed) {
      // Below the static limit, but unusually slow for THIS api.
      const b = ctx.baseline(apiName);
      const { baselineMinSamples, baselineSigma } = config.thresholds;
      const limit = b.mean + baselineSigma * b.std;
      if (b.samples >= baselineMinSamples && b.std > 0 && ms > limit && ms - b.mean > 250) {
        anomalies.push({ type: TYPES.LATENCY_SPIKE, severity: 'warning', field: 'response_time_ms', value: ms, threshold: Math.round(limit), detail: `Response took ${ms} ms, ${(ms / b.mean).toFixed(1)}x its usual ${Math.round(b.mean)} ms` });
      }
    }
  }

  // ---- Returned data -------------------------------------------------------
  const records = rc.value;
  if (!rc.present) {
    anomalies.push({ type: TYPES.MISSING_FIELD, severity: 'warning', field: 'records_returned', detail: 'records_returned is missing – the payload could not be verified' });
  } else if (records !== null) {
    if (records < 0 || !Number.isInteger(records)) {
      anomalies.push({ type: TYPES.INVALID_FIELD, severity: 'warning', field: 'records_returned', value: records, detail: `records_returned is ${records}, expected a whole number ≥ 0` });
    } else if (failed && records > 0) {
      anomalies.push({ type: TYPES.INCONSISTENT_PAYLOAD, severity: 'warning', field: 'records_returned', value: records, detail: `Request failed (HTTP ${status}) yet reported ${records} records` });
    } else if (records < rules.minRecords) {
      anomalies.push({ type: TYPES.ZERO_RECORDS, severity: failed ? 'warning' : rules.minRecords > 0 && records === 0 ? 'warning' : 'info', field: 'records_returned', value: records, threshold: rules.minRecords, detail: records === 0 ? 'No records were returned' : `Only ${records} records returned (expected at least ${rules.minRecords})` });
    }
  }

  return finalize(apiName, sample, anomalies, true);
}

function pickSample(raw) {
  return {
    response_time_ms: isNum(raw.response_time_ms) ? raw.response_time_ms : null,
    status_code: isNum(raw.status_code) ? raw.status_code : null,
    records_returned: isNum(raw.records_returned) ? raw.records_returned : null,
  };
}

function finalize(apiName, sample, anomalies, attributable) {
  // "info" findings (e.g. numeric strings) are kept as context but don't raise an alert on their own.
  const alerting = anomalies.filter((a) => a.severity !== 'info');
  const severity = alerting.length ? maxSeverity(alerting.map((a) => a.severity)) : null;
  const types = [...new Set(alerting.map((a) => a.type))].sort();
  return {
    apiName,
    attributable,
    sample,
    anomalies,
    severity,
    isAnomalous: alerting.length > 0,
    // Same API + same set of problems = same incident (used for de-duplication).
    fingerprint: alerting.length ? `${apiName}::${types.join('+')}` : null,
    types,
  };
}

module.exports = { detect, TYPES, SEVERITY_RANK, maxSeverity, rulesFor, UNKNOWN_API };
