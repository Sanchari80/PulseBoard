'use strict';

const { parseAlertsQuery } = require('../validators/schemas');
const { getRepository } = require('../repositories');
const emailService = require('../services/emailService');
const AppError = require('../utils/AppError');

/** GET /alerts – active anomalies by default; filter with ?status=&severity=&api=&q=&limit=&page= */
async function list(req, res) {
  const query = parseAlertsQuery(req.query);
  const { items, total } = await getRepository().list(query);
  res.json({ items, total, page: query.page, limit: query.limit, status: query.status });
}

async function stats(req, res) {
  res.json(await getRepository().stats());
}

async function getOne(req, res) {
  const alert = await getRepository().getById(req.params.id);
  if (!alert) throw AppError.notFound('Alert not found');
  res.json(alert);
}

async function resolve(req, res) {
  const alert = await getRepository().setStatus(req.params.id, 'resolved');
  if (!alert) throw AppError.notFound('Alert not found');
  res.json(alert);
}

async function reopen(req, res) {
  try {
    const alert = await getRepository().setStatus(req.params.id, 'active');
    if (!alert) throw AppError.notFound('Alert not found');
    res.json(alert);
  } catch (err) {
    if (err.code === 11000) throw new AppError('This incident is already open again under a newer alert', { status: 409, code: 'CONFLICT' });
    throw err;
  }
}

async function resolveAll(req, res) {
  const { severity, api } = req.body || {};
  const resolved = await getRepository().resolveAll({ severity, api });
  res.json({ resolved });
}

/** POST /alerts/report/email – e-mail a report of all active alerts. */
async function emailReport(req, res) {
  if (!emailService.isEnabled()) throw AppError.unavailable('E-mail is not configured. Set EMAIL_ENABLED=true, SMTP_* and EMAIL_TO in the environment.');
  const repo = getRepository();
  const { items } = await repo.list({ status: 'active', limit: 200, page: 1 });
  const result = await emailService.sendAlertReport(items, { reason: 'report' });
  await repo.markEmailed(items.map((a) => a.id));
  res.json({ sent: true, alerts: items.length, ...result });
}

module.exports = { list, stats, getOne, resolve, reopen, resolveAll, emailReport };
