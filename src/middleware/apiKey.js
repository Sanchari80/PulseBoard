'use strict';

const crypto = require('crypto');
const config = require('../config');
const AppError = require('../utils/AppError');

/** Optional guard for write endpoints. Disabled when MONITOR_API_KEY is empty. */
module.exports = function requireApiKey(req, res, next) {
  if (!config.monitorApiKey) return next();
  const given = req.get('x-api-key') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(config.monitorApiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(AppError.unauthorized());
  next();
};
