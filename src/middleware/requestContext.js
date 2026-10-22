'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger').for('http');

/** Attaches a request id and logs every request with its duration and status. */
module.exports = function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('x-request-id', req.id);
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    if (req.path === '/health') return; // keep platform health probes out of the logs
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger.log(level, `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`, { requestId: req.id });
  });
  next();
};
