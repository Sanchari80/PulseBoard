'use strict';

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger').for('monitor');
const { detect, maxSeverity } = require('./anomalyDetector');
const registry = require('./apiHealthRegistry');
const { generateAlerts, getProviderInfo } = require('./aiAlertService');
const { getRepository } = require('../repositories');
const emailService = require('./emailService');
const { mapLimit } = require('../utils/concurrency');

const newBatchId = () => `b_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

/**
 * Process a batch of raw API responses end to end:
 *   detect → group into incidents → de-duplicate against open alerts →
 *   AI text for new incidents only → persist → optional e-mail.
 *
 * @param {unknown[]} items
 * @param {{ source?: 'api'|'file'|'scheduler'|'simulation'|'sample' }} [opts]
 */
async function processBatch(items, { source = 'api' } = {}) {
  const started = Date.now();
  const batchId = newBatchId();
  const now = new Date();
  const repo = getRepository();
  const baseline = registry.baseline.bind(registry);

  // 1. Detect – sequential so each API's baseline learns from earlier items in the same batch.
  const results = items.map((raw, index) => {
    const d = detect(raw, { baseline });
    if (d.attributable) registry.record(d.apiName, d.sample, d.severity, now);
    return { index, d };
  });

  // 2. Group identical incidents inside the batch (same API + same problems).
  const groups = new Map();
  for (const { index, d } of results) {
    if (!d.isAnomalous) continue;
    const g = groups.get(d.fingerprint) || { fingerprint: d.fingerprint, apiName: d.apiName, types: d.types, severities: [], sample: d.sample, anomalies: d.anomalies, count: 0, indices: [] };
    g.count += 1;
    g.indices.push(index);
    g.severities.push(d.severity);
    g.sample = d.sample; // keep the latest sample
    g.anomalies = d.anomalies;
    groups.set(d.fingerprint, g);
  }
  for (const g of groups.values()) g.severity = maxSeverity(g.severities);

  // 3. De-duplicate against incidents that are already open.
  const existing = await repo.findActiveByFingerprints([...groups.keys()]);
  const alertIdByFingerprint = new Map();
  const updated = [];
  const fresh = [];
  const escalated = [];
  for (const g of groups.values()) {
    const prev = existing.get(g.fingerprint);
    if (prev) {
      const a = await repo.recordOccurrence(g.fingerprint, { count: g.count, sample: g.sample, anomalies: g.anomalies, severity: g.severity, lastSeenAt: now, batchId });
      if (a) {
        updated.push(a);
        alertIdByFingerprint.set(g.fingerprint, a.id);
        // Warning → critical: the old wording undersells the incident, so rewrite it.
        if (prev.severity !== 'critical' && g.severity === 'critical') escalated.push({ alert: a, g });
        continue;
      }
    }
    fresh.push(g);
  }

  if (escalated.length) {
    const rewrites = await generateAlerts(escalated.map(({ alert, g }, i) => ({ id: `e${i + 1}`, apiName: g.apiName, severity: 'critical', sample: g.sample, anomalies: g.anomalies, occurrences: alert.occurrences })));
    await mapLimit(escalated, 10, async ({ alert }, i) => {
      const t = rewrites.get(`e${i + 1}`);
      const a = await repo.updateText(alert.id, { title: t.title, message: t.message, likelyCause: t.likely_cause, impact: t.impact, recommendedAction: t.recommended_action, aiSource: t.source });
      const idx = updated.findIndex((u) => u.id === alert.id);
      if (a && idx >= 0) updated[idx] = a;
    });
  }

  // 4. AI text only for new incidents (keeps LLM cost flat when an outage repeats).
  const texts = await generateAlerts(fresh.map((g, i) => ({ id: `a${i + 1}`, apiName: g.apiName, severity: g.severity, sample: g.sample, anomalies: g.anomalies, occurrences: g.count })));
  const { promptVersion } = getProviderInfo();

  const created = [];
  await mapLimit(fresh, 10, async (g, i) => {
    const t = texts.get(`a${i + 1}`);
    const doc = {
      apiName: g.apiName,
      fingerprint: g.fingerprint,
      severity: g.severity,
      types: g.types,
      anomalies: g.anomalies,
      sample: g.sample,
      title: t.title,
      message: t.message,
      likelyCause: t.likely_cause,
      impact: t.impact,
      recommendedAction: t.recommended_action,
      aiSource: t.source,
      promptVersion,
      occurrences: g.count,
      firstSeenAt: now,
      lastSeenAt: now,
      batchId,
      source,
    };
    try {
      const a = await repo.create(doc);
      created.push(a);
      alertIdByFingerprint.set(g.fingerprint, a.id);
    } catch (err) {
      if (err.code !== 11000) throw err;
      // Another request opened the same incident a moment ago – count this as an occurrence.
      const a = await repo.recordOccurrence(g.fingerprint, { count: g.count, sample: g.sample, anomalies: g.anomalies, severity: g.severity, lastSeenAt: now, batchId });
      if (a) {
        updated.push(a);
        alertIdByFingerprint.set(g.fingerprint, a.id);
      }
    }
  });

  // 5. Notify on new critical incidents (fire-and-forget, never fails the request).
  const newCritical = created.filter((a) => a.severity === 'critical');
  if (newCritical.length && emailService.isEnabled() && config.email.onCritical) {
    emailService
      .sendAlertReport(newCritical, { reason: 'new-critical' })
      .then(() => repo.markEmailed(newCritical.map((a) => a.id)))
      .catch((err) => logger.error(`Critical alert e-mail failed: ${err.message}`));
  }

  const summary = {
    batchId,
    source,
    received: items.length,
    healthy: results.filter((r) => !r.d.isAnomalous).length,
    anomalous: results.filter((r) => r.d.isAnomalous).length,
    invalid: results.filter((r) => !r.d.attributable).length,
    alertsCreated: created.length,
    alertsUpdated: updated.length,
    bySeverity: {
      critical: results.filter((r) => r.d.severity === 'critical').length,
      warning: results.filter((r) => r.d.severity === 'warning').length,
    },
    ai: getProviderInfo(),
    durationMs: Date.now() - started,
  };

  logger.info(`Batch ${batchId} (${source}): ${summary.received} received, ${summary.anomalous} anomalous, ${summary.alertsCreated} new / ${summary.alertsUpdated} updated alerts in ${summary.durationMs} ms`);

  return {
    summary,
    results: results.map(({ index, d }) => ({
      index,
      api_name: d.apiName,
      status: !d.attributable ? 'invalid' : d.isAnomalous ? 'anomaly' : 'healthy',
      severity: d.severity,
      anomalies: d.anomalies.map(({ type, severity, detail }) => ({ type, severity, detail })),
      alertId: d.fingerprint ? alertIdByFingerprint.get(d.fingerprint) || null : null,
    })),
    alerts: { created, updated },
  };
}

module.exports = { processBatch };
