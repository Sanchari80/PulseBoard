'use strict';

const config = require('./config');
const logger = require('./utils/logger').for('server');
const { createApp } = require('./app');
const { initRepository, closeRepository } = require('./repositories');
const { getProviderInfo } = require('./services/aiAlertService');
const emailService = require('./services/emailService');
const scheduler = require('./jobs/scheduler');

async function main() {
  const readiness = initRepository();
  const app = createApp({ readiness });
  const server = app.listen(config.port, () => {
    const ai = getProviderInfo();
    logger.info(`API monitor listening on http://localhost:${config.port} (${config.env})`);
    logger.info(`AI alerts: ${ai.provider}${ai.model ? ` (${ai.model})` : ''} · e-mail: ${emailService.isEnabled() ? 'on' : 'off'} · scheduler: ${config.scheduler.enabled ? 'on' : 'off'}`);
  });
  try {
    await readiness;
  } catch (err) {
    server.close();
    throw err;
  }
  scheduler.start();

  const shutdown = (signal) => {
    logger.info(`${signal} received – shutting down`);
    scheduler.stop();
    server.close(async () => {
      await closeRepository().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', { error: err?.stack || String(err) }));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.stack });
  process.exit(1);
});

main().catch((err) => {
  logger.error(`Failed to start: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
