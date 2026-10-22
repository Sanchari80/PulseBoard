'use strict';

const config = require('../config');

/**
 * In-process registry of per-API health: a rolling window of latencies (used as a
 * statistical baseline for spike detection) plus a short history for the dashboard.
 * For a multi-instance deployment this would move to Redis; the interface stays the same.
 */
class ApiHealthRegistry {
  constructor({ window = config.thresholds.baselineWindow, historySize = 30 } = {}) {
    this.window = window;
    this.historySize = historySize;
    this.apis = new Map();
  }

  _entry(apiName) {
    if (!this.apis.has(apiName)) {
      this.apis.set(apiName, { apiName, latencies: [], history: [], checks: 0, anomalies: 0, lastCheckedAt: null, lastSample: null, lastSeverity: null });
    }
    return this.apis.get(apiName);
  }

  /** Mean / std-dev of the latency window for an API (before the current sample is added). */
  baseline(apiName) {
    const e = this.apis.get(apiName);
    if (!e || e.latencies.length === 0) return { samples: 0, mean: 0, std: 0 };
    const n = e.latencies.length;
    const mean = e.latencies.reduce((a, b) => a + b, 0) / n;
    const variance = e.latencies.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return { samples: n, mean, std: Math.sqrt(variance) };
  }

  record(apiName, sample, severity, at = new Date()) {
    const e = this._entry(apiName);
    e.checks += 1;
    e.lastCheckedAt = at.toISOString();
    e.lastSample = sample;
    e.lastSeverity = severity || 'healthy';
    if (severity) e.anomalies += 1;
    // Only successful, numeric latencies feed the baseline, so outages don't poison it.
    if (Number.isFinite(sample.response_time_ms) && sample.status_code >= 200 && sample.status_code < 400) {
      e.latencies.push(sample.response_time_ms);
      if (e.latencies.length > this.window) e.latencies.shift();
    }
    e.history.push({ t: e.lastCheckedAt, ms: Number.isFinite(sample.response_time_ms) ? sample.response_time_ms : null, status: sample.status_code ?? null, severity: e.lastSeverity });
    if (e.history.length > this.historySize) e.history.shift();
  }

  list() {
    return [...this.apis.values()]
      .map(({ latencies, ...rest }) => {
        const b = this.baseline(rest.apiName);
        return { ...rest, avgResponseMs: Math.round(b.mean), uptimePct: rest.checks ? Math.round(((rest.checks - rest.anomalies) / rest.checks) * 1000) / 10 : null };
      })
      .sort((a, b) => a.apiName.localeCompare(b.apiName));
  }

  reset() {
    this.apis.clear();
  }
}

module.exports = new ApiHealthRegistry();
module.exports.ApiHealthRegistry = ApiHealthRegistry;
