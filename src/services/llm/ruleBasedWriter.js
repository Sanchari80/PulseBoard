'use strict';

/**
 * Deterministic alert writer. Used when no LLM key is configured, when the LLM call fails,
 * or when the model's answer for an item is unusable – so an alert is never lost.
 */

const IMPACT_HINTS = [
  [/patient/i, 'Care staff may be unable to open or update patient records.'],
  [/appointment|visit|booking/i, 'Visit scheduling and appointment lists may be incomplete.'],
  [/caregiver|schedule|shift|roster/i, 'Caregiver shift assignments may not load or may be out of date.'],
  [/billing|invoice|payment|claim/i, 'Billing and claims processing may be delayed.'],
  [/medication|pharmacy|prescription/i, 'Medication information may be missing for care teams.'],
  [/lab|result|diagnostic/i, 'Lab results may be missing or unreliable for clinicians.'],
  [/insurance|eligibility|verification/i, 'Insurance eligibility checks may fail, delaying patient intake.'],
  [/note|document|record/i, 'Clinical documentation may be unavailable to staff.'],
];

function impactFor(apiName, severity) {
  const hit = IMPACT_HINTS.find(([re]) => re.test(apiName));
  if (hit) return hit[1];
  return severity === 'critical' ? 'Features that depend on this API are likely unavailable to users.' : 'Features that depend on this API may behave unreliably.';
}

const has = (item, type) => item.anomalies.some((a) => a.type === type && a.severity !== 'info');
const find = (item, type) => item.anomalies.find((a) => a.type === type && a.severity !== 'info');

function describe(item) {
  const { sample } = item;
  const parts = [];
  const s = sample.status_code;
  const ms = sample.response_time_ms;

  if (has(item, 'MALFORMED_RESPONSE')) {
    return {
      title: 'Malformed monitoring entry received',
      message: `An API response could not be attributed to any API: ${find(item, 'MALFORMED_RESPONSE').detail.charAt(0).toLowerCase()}${find(item, 'MALFORMED_RESPONSE').detail.slice(1)}. Possible integration or logging defect.`,
      likely_cause: 'Possibly a broken integration client or a logging step that dropped fields.',
      impact: 'Health of the affected API is invisible until the reporting is fixed.',
      recommended_action: 'Check the integration that produced this entry and make it send api_name and metrics.',
    };
  }

  if (has(item, 'TIMEOUT')) parts.push(s === 0 ? 'did not respond' : `timed out with status ${s}`);
  else if (has(item, 'SERVER_ERROR')) parts.push(`failed with status ${s}`);
  else if (has(item, 'RATE_LIMITED')) parts.push('is rate-limiting requests (status 429)');
  else if (has(item, 'CLIENT_ERROR')) parts.push(`rejected the request with status ${s}`);

  if (has(item, 'HIGH_RESPONSE_TIME')) parts.push(`took ${ms} ms to respond`);
  else if (has(item, 'LATENCY_SPIKE')) {
    const spike = find(item, 'LATENCY_SPIKE');
    parts.push(`took ${ms} ms, ${spike.detail.split(', ')[1] || 'well above its usual latency'}`);
  }

  if (has(item, 'ZERO_RECORDS')) parts.push(sample.records_returned === 0 ? 'returned 0 records' : `returned only ${sample.records_returned} records`);
  if (has(item, 'INCONSISTENT_PAYLOAD')) parts.push(`still reported ${sample.records_returned} records`);
  for (const a of item.anomalies.filter((x) => x.type === 'MISSING_FIELD')) parts.push(`did not report ${a.field}`);
  for (const a of item.anomalies.filter((x) => x.type === 'INVALID_FIELD' && x.severity !== 'info')) parts.push(`sent an invalid ${a.field} (${JSON.stringify(a.value)})`);

  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'reported an anomaly';

  let meaning;
  let cause;
  let action;
  let title;
  if (has(item, 'TIMEOUT')) {
    title = 'API unreachable or timing out';
    meaning = 'Possible outage or network issue.';
    cause = 'Likely an upstream outage, network partition or an overloaded gateway.';
    action = 'Check the provider status page and gateway logs; fail over or queue requests if available.';
  } else if (has(item, 'SERVER_ERROR')) {
    title = has(item, 'ZERO_RECORDS') ? 'Server error with no data returned' : 'Server error from provider';
    meaning = 'Possible outage or data issue.';
    cause = 'Likely a provider-side failure such as a crashed service or failing database query.';
    action = 'Check provider status and server logs, then retry once the error rate drops.';
  } else if (has(item, 'RATE_LIMITED')) {
    title = 'Requests are being rate limited';
    meaning = 'Calls are being throttled by the provider.';
    cause = 'Likely the request quota was exceeded or a client is retrying too aggressively.';
    action = 'Add backoff to the client and review the quota with the provider.';
  } else if (has(item, 'CLIENT_ERROR')) {
    title = 'Requests rejected by the API';
    meaning = s === 401 || s === 403 ? 'Possible expired credentials.' : 'Possible contract or configuration change.';
    cause = s === 401 || s === 403 ? 'Likely expired or revoked credentials.' : 'Possibly a changed endpoint, missing parameter or wrong resource id.';
    action = s === 401 || s === 403 ? 'Rotate or renew the API credentials and confirm access scopes.' : 'Compare the request against the latest API contract and fix the client.';
  } else if (has(item, 'HIGH_RESPONSE_TIME') || has(item, 'LATENCY_SPIKE')) {
    title = 'Response time above limit';
    meaning = 'Possible performance degradation.';
    cause = 'Possibly heavy load on the provider, slow queries or network congestion.';
    action = 'Watch the next checks; if latency persists, contact the provider and enable caching.';
  } else if (has(item, 'ZERO_RECORDS')) {
    title = 'API returned no data';
    meaning = 'Possible data sync or filtering issue.';
    cause = 'Possibly a failed upstream sync, an empty source table or a wrong query filter.';
    action = 'Verify the source data and query parameters, and compare with the last successful sync.';
  } else {
    title = 'Inconsistent data from API';
    meaning = 'Possible contract or data-quality issue.';
    cause = 'Possibly a schema change or a bug in the provider\'s response serialization.';
    action = 'Validate the payload against the API contract and raise it with the provider.';
  }

  const recurring = item.occurrences > 1 ? ` Recurring: seen ${item.occurrences} times.` : '';

  return {
    title,
    message: `${item.apiName} ${joined}. ${meaning}${recurring}`,
    likely_cause: cause,
    impact: impactFor(item.apiName, item.severity),
    recommended_action: action,
  };
}

module.exports = { describe, impactFor };
