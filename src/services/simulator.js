'use strict';

/** Generates realistic API responses for demos and load tests. */
const PROFILES = [
  { api_name: 'PatientDataAPI', baseMs: 650, records: [20, 80] },
  { api_name: 'AppointmentAPI', baseMs: 900, records: [10, 60] },
  { api_name: 'CaregiverScheduleAPI', baseMs: 500, records: [5, 40] },
  { api_name: 'BillingAPI', baseMs: 1400, records: [3, 25] },
  { api_name: 'MedicationAPI', baseMs: 420, records: [8, 30] },
  { api_name: 'LabResultsAPI', baseMs: 780, records: [1, 15] },
  { api_name: 'InsuranceVerificationAPI', baseMs: 1100, records: [1, 5] },
  { api_name: 'VisitNotesAPI', baseMs: 380, records: [15, 120] },
];

const rand = (min, max) => Math.round(min + Math.random() * (max - min));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function simulate(count = 12, anomalyRate = 0.3) {
  return Array.from({ length: count }, () => {
    const p = pick(PROFILES);
    const healthy = { api_name: p.api_name, response_time_ms: rand(p.baseMs * 0.7, p.baseMs * 1.3), status_code: 200, records_returned: rand(...p.records) };
    if (Math.random() > anomalyRate) return healthy;
    switch (pick(['slow', 'server', 'empty', 'timeout', 'auth', 'slow_server'])) {
      case 'slow':
        return { ...healthy, response_time_ms: rand(2600, 7500) };
      case 'server':
        return { ...healthy, status_code: pick([500, 502, 503]), records_returned: 0 };
      case 'empty':
        return { ...healthy, records_returned: 0 };
      case 'timeout':
        return { ...healthy, status_code: 504, response_time_ms: 10000, records_returned: 0 };
      case 'auth':
        return { ...healthy, status_code: pick([401, 403]), records_returned: 0, response_time_ms: rand(80, 200) };
      default:
        return { ...healthy, status_code: 500, response_time_ms: rand(5200, 6500), records_returned: 0 };
    }
  });
}

module.exports = { simulate, PROFILES };
