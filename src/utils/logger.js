'use strict';

const fs = require('fs');
const winston = require('winston');
const config = require('../config');

const { combine, timestamp, errors, json, colorize, printf, splat } = winston.format;

const devFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level}: ${stack || message}${rest}`;
});

const transports = [
  new winston.transports.Console({
    format: config.isProd
      ? combine(timestamp(), errors({ stack: true }), json())
      : combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), splat(), devFormat),
  }),
];

if (config.log.toFile) {
  fs.mkdirSync(config.log.dir, { recursive: true });
  const fileFormat = combine(timestamp(), errors({ stack: true }), json());
  transports.push(
    new winston.transports.File({ filename: `${config.log.dir}/error.log`, level: 'error', format: fileFormat, maxsize: 5_000_000, maxFiles: 3 }),
    new winston.transports.File({ filename: `${config.log.dir}/combined.log`, format: fileFormat, maxsize: 10_000_000, maxFiles: 5 })
  );
}

const logger = winston.createLogger({ level: config.log.level, transports });

/** Child logger with a fixed module name, e.g. logger.child({ module: 'ai' }). */
logger.for = (module) => logger.child({ module });

module.exports = logger;
