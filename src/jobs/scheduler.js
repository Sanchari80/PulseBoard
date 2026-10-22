'use strict';

const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger').for('scheduler');
const { processBatch } = require('../services/monitorService');

let timer = null;
let running = false;
let lastRun = null;

function loadTargets() {
  try {
    const targets = JSON.parse(fs.readFileSync(config.scheduler.targetsFile, 'utf8'));
    return Array.isArray(targets) ? targets.filter((t) => t && t.api_name && t.url) : [];
  } catch (err) {
    logger.error(`Cannot read targets file ${config.scheduler.targetsFile}: ${err.message}`);
    return [];
  }
}

const countRecords = (body) => {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === 'object') {
    for (const key of ['data', 'items', 'results', 'records']) if (Array.isArray(body[key])) return body[key].length;
    return 1;
  }
  return 0;
};

/** Call one real endpoint and convert the outcome into the monitor's input format. */
async function probe(target) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.scheduler.requestTimeoutMs);
  const started = performance.now();
  try {
    const res = await fetch(target.url, { method: target.method || 'GET', headers: target.headers, signal: controller.signal });
    let records = 0;
    try {
      records = countRecords(await res.json());
    } catch {
      records = 0;
    }
    return { api_name: target.api_name, response_time_ms: Math.round(performance.now() - started), status_code: res.status, records_returned: records };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return { api_name: target.api_name, response_time_ms: Math.round(performance.now() - started), status_code: timedOut ? 504 : 0, records_returned: 0 };
  } finally {
    clearTimeout(t);
  }
}

/** Probe every target once and run the results through the monitor as one batch. */
async function runOnce() {
  if (running) return { skipped: true, reason: 'A poll is already running' };
  running = true;
  try {
    const targets = loadTargets();
    if (!targets.length) return { skipped: true, reason: 'No targets configured' };
    const responses = await Promise.all(targets.map(probe));
    const { summary } = await processBatch(responses, { source: 'scheduler' });
    lastRun = { at: new Date().toISOString(), targets: targets.length, summary };
    return lastRun;
  } catch (err) {
    logger.error(`Scheduled poll failed: ${err.message}`);
    throw err;
  } finally {
    running = false;
  }
}

function start() {
  if (!config.scheduler.enabled || timer) return;
  logger.info(`Polling ${loadTargets().length} target(s) every ${config.scheduler.intervalMs / 1000}s`);
  timer = setInterval(() => runOnce().catch(() => {}), config.scheduler.intervalMs);
  timer.unref();
  setTimeout(() => runOnce().catch(() => {}), 2000).unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const status = () => ({ enabled: config.scheduler.enabled, intervalMs: config.scheduler.intervalMs, targets: loadTargets().map((t) => t.api_name), running, lastRun });

module.exports = { start, stop, runOnce, status, probe };
