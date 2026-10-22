'use strict';

const crypto = require('crypto');
const { SEVERITY_RANK } = require('../services/anomalyDetector');

const clone = (o) => structuredClone(o);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * In-memory implementation of the alert repository. Same contract as the Mongo one,
 * used for zero-config demos and tests. Data is lost on restart.
 */
class MemoryAlertRepository {
  constructor() {
    this.kind = 'memory';
    this.alerts = new Map();
  }

  async findActiveByFingerprints(fingerprints) {
    const wanted = new Set(fingerprints);
    const map = new Map();
    for (const a of this.alerts.values()) if (a.status === 'active' && wanted.has(a.fingerprint)) map.set(a.fingerprint, clone(a));
    return map;
  }

  async create(doc) {
    for (const a of this.alerts.values()) {
      if (a.status === 'active' && a.fingerprint === doc.fingerprint) {
        const err = new Error('duplicate active fingerprint');
        err.code = 11000;
        throw err;
      }
    }
    const now = new Date().toISOString();
    const alert = { id: crypto.randomBytes(12).toString('hex'), status: 'active', occurrences: 1, createdAt: now, updatedAt: now, ...clone(doc) };
    // Store dates as ISO strings, like the JSON the Mongo repository returns.
    alert.firstSeenAt = new Date(doc.firstSeenAt || now).toISOString();
    alert.lastSeenAt = new Date(doc.lastSeenAt || now).toISOString();
    this.alerts.set(alert.id, alert);
    return clone(alert);
  }

  async recordOccurrence(fingerprint, { count = 1, sample, anomalies, severity, lastSeenAt, batchId }) {
    const a = [...this.alerts.values()].find((x) => x.status === 'active' && x.fingerprint === fingerprint);
    if (!a) return null;
    a.occurrences += count;
    a.sample = sample;
    a.anomalies = anomalies;
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[a.severity]) a.severity = severity; // escalate, never downgrade an open incident
    a.lastSeenAt = new Date(lastSeenAt).toISOString();
    a.batchId = batchId;
    a.updatedAt = new Date().toISOString();
    return clone(a);
  }

  async updateText(id, fields) {
    const a = this.alerts.get(String(id));
    if (!a) return null;
    Object.assign(a, clone(fields), { updatedAt: new Date().toISOString() });
    return clone(a);
  }

  _filter({ status = 'active', severity, api, q } = {}) {
    const re = q ? new RegExp(escapeRe(q), 'i') : null;
    return [...this.alerts.values()].filter(
      (a) =>
        (status === 'all' || a.status === status) &&
        (!severity || a.severity === severity) &&
        (!api || a.apiName === api) &&
        (!re || re.test(a.apiName) || re.test(a.message) || re.test(a.title || ''))
    );
  }

  async list(query = {}) {
    const { limit = 100, page = 1 } = query;
    const items = this._filter(query).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.lastSeenAt.localeCompare(a.lastSeenAt));
    return { items: items.slice((page - 1) * limit, page * limit).map(clone), total: items.length };
  }

  async getById(id) {
    const a = this.alerts.get(String(id));
    return a ? clone(a) : null;
  }

  async setStatus(id, status) {
    const a = this.alerts.get(String(id));
    if (!a) return null;
    if (status === 'active' && a.status !== 'active') {
      const clash = [...this.alerts.values()].some((x) => x.id !== a.id && x.status === 'active' && x.fingerprint === a.fingerprint);
      if (clash) {
        const err = new Error('An active alert with the same signature already exists');
        err.code = 11000;
        throw err;
      }
    }
    a.status = status;
    a.resolvedAt = status === 'resolved' ? new Date().toISOString() : undefined;
    a.updatedAt = new Date().toISOString();
    return clone(a);
  }

  async resolveAll(filter = {}) {
    let n = 0;
    for (const a of this._filter({ ...filter, status: 'active' })) {
      a.status = 'resolved';
      a.resolvedAt = new Date().toISOString();
      n += 1;
    }
    return n;
  }

  async markEmailed(ids) {
    const now = new Date().toISOString();
    for (const id of ids) if (this.alerts.has(id)) this.alerts.get(id).emailedAt = now;
  }

  async stats() {
    const all = [...this.alerts.values()];
    const active = all.filter((a) => a.status === 'active');
    const since = Date.now() - 24 * 3600 * 1000;
    const byApi = new Map();
    for (const a of active) {
      const e = byApi.get(a.apiName) || { apiName: a.apiName, count: 0, severity: 'warning', occurrences: 0 };
      e.count += 1;
      e.occurrences += a.occurrences;
      if (a.severity === 'critical') e.severity = 'critical';
      byApi.set(a.apiName, e);
    }
    return {
      active: active.length,
      critical: active.filter((a) => a.severity === 'critical').length,
      warning: active.filter((a) => a.severity === 'warning').length,
      resolved: all.filter((a) => a.status === 'resolved').length,
      last24h: all.filter((a) => Date.parse(a.lastSeenAt) >= since).length,
      byApi: [...byApi.values()].sort((x, y) => y.count - x.count),
    };
  }

  async clear() {
    this.alerts.clear();
  }
}

module.exports = MemoryAlertRepository;
