'use strict';

const AppError = require('../utils/AppError');
const config = require('../config');
const logger = require('../utils/logger').for('error');

function notFound(req, res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Malformed JSON body from express.json()
  if (err.type === 'entity.parse.failed') {
    err = AppError.badRequest('Request body is not valid JSON', { position: err.message });
  } else if (err.type === 'entity.too.large') {
    err = new AppError('Request body is too large', { status: 413, code: 'PAYLOAD_TOO_LARGE' });
  } else if (err.name === 'CastError') {
    err = AppError.badRequest(`Invalid id: ${err.value}`);
  }

  const status = err.status || 500;
  if (status >= 500) logger.error(err.message, { requestId: req.id, stack: err.stack });

  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status >= 500 && !err.isOperational ? 'Something went wrong on the server' : err.message,
      ...(err.details ? { details: err.details } : {}),
      ...(!config.isProd && status >= 500 ? { stack: err.stack } : {}),
      requestId: req.id,
    },
  });
}

module.exports = { notFound, errorHandler };
