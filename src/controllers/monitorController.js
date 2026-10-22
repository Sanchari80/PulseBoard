'use strict';

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const { parseMonitorBody, simulateSchema } = require('../validators/schemas');
const { processBatch } = require('../services/monitorService');
const registry = require('../services/apiHealthRegistry');
const { simulate } = require('../services/simulator');
const scheduler = require('../jobs/scheduler');
const { getProviderInfo } = require('../services/aiAlertService');
const { getRepository } = require('../repositories');
const emailService = require('../services/emailService');
const AppError = require('../utils/AppError');

const SAMPLE_FILE = path.resolve(__dirname, '../../data/sample-responses.json');

/** POST /monitor – analyse one response or a batch. */
async function monitor(req, res) {
  const items = parseMonitorBody(req.body);
  if (config.publicDemoMode && items.length > config.publicDemoMaxItems) {
    throw AppError.badRequest(`Public demo batches are limited to ${config.publicDemoMaxItems} responses`);
  }
  const source = req.get('x-monitor-source') === 'file' ? 'file' : 'api';
  const result = await processBatch(items, { source });
  res.status(result.summary.alertsCreated ? 201 : 200).json(result);
}

/** POST /monitor/sample – run the bundled static JSON file. */
async function runSample(req, res) {
  const items = JSON.parse(await fs.readFile(SAMPLE_FILE, 'utf8'));
  res.json(await processBatch(items, { source: 'sample' }));
}

/** POST /monitor/simulate?count=12 – random realistic traffic for demos. */
async function runSimulation(req, res) {
  const parsed = simulateSchema.safeParse({ ...req.query, ...(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) });
  if (!parsed.success) throw AppError.badRequest('count must be an integer between 1 and 200');
  res.json(await processBatch(simulate(parsed.data.count), { source: 'simulation' }));
}

/** POST /monitor/poll – probe the configured live endpoints right now. */
async function pollNow(req, res) {
  res.json(await scheduler.runOnce());
}

/** GET /monitor/apis – per-API health snapshot (latency history, uptime). */
function listApis(req, res) {
  res.json({ items: registry.list() });
}

/** GET /monitor/status – what the system is configured to do. */
function status(req, res) {
  res.json({
    ai: getProviderInfo(),
    storage: getRepository().kind,
    email: { enabled: emailService.isEnabled(), onCritical: config.email.onCritical },
    scheduler: scheduler.status(),
    thresholds: config.thresholds,
    batchMaxItems: config.batch.maxItems,
    writeProtected: Boolean(config.monitorApiKey) || config.publicDemoMode,
    publicDemoMode: config.publicDemoMode,
  });
}

module.exports = { monitor, runSample, runSimulation, pollNow, listApis, status };
