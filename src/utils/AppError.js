'use strict';

/** Operational error with an HTTP status and a stable machine-readable code. */
class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }

  static badRequest(message, details) {
    return new AppError(message, { status: 400, code: 'BAD_REQUEST', details });
  }
  static notFound(message = 'Resource not found') {
    return new AppError(message, { status: 404, code: 'NOT_FOUND' });
  }
  static unauthorized(message = 'Missing or invalid API key') {
    return new AppError(message, { status: 401, code: 'UNAUTHORIZED' });
  }
  static unavailable(message) {
    return new AppError(message, { status: 503, code: 'SERVICE_UNAVAILABLE' });
  }
}

module.exports = AppError;
