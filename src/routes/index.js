'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const monitor = require('../controllers/monitorController');
const alerts = require('../controllers/alertsController');
const requireApiKey = require('../middleware/apiKey');
const { getRepository } = require('../repositories');
const config = require('../config');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.isTest ? 10_000 : 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests – try again in a minute' } },
});
const demoWriteLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.isTest ? 10_000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Public demo limit reached – try again in a minute' } },
});
const write = [writeLimiter, requireApiKey];
const demoMonitorWrite = (req, res, next) => {
  const limiter = config.publicDemoMode ? demoWriteLimiter : writeLimiter;
  limiter(req, res, () => {
    if (config.publicDemoMode) return next();
    return requireApiKey(req, res, next);
  });
};

router.get('/health', (req, res) => res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()), storage: getRepository().kind, time: new Date().toISOString() }));

// Monitoring input
router.post('/monitor', demoMonitorWrite, monitor.monitor);
router.post('/monitor/sample', demoMonitorWrite, monitor.runSample);
router.post('/monitor/simulate', demoMonitorWrite, monitor.runSimulation);
router.post('/monitor/poll', write, monitor.pollNow);
router.get('/monitor/apis', monitor.listApis);
router.get('/monitor/status', monitor.status);

// Alerts
router.get('/alerts', alerts.list);
router.get('/alerts/stats', alerts.stats);
router.post('/alerts/resolve-all', write, alerts.resolveAll);
router.post('/alerts/report/email', write, alerts.emailReport);
router.get('/alerts/:id', alerts.getOne);
router.patch('/alerts/:id/resolve', write, alerts.resolve);
router.patch('/alerts/:id/reopen', write, alerts.reopen);

module.exports = router;
