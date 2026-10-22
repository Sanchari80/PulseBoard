#!/usr/bin/env node
'use strict';

/**
 * Input method 1: run a static JSON file through the monitor from the command line.
 *   npm run monitor:file                      # uses data/sample-responses.json
 *   npm run monitor:file -- path/to/file.json
 * Stores alerts in the configured database (MongoDB if MONGODB_URI is set).
 */
const fs = require('fs');
const path = require('path');
const { initRepository, closeRepository } = require('../repositories');
const { parseMonitorBody } = require('../validators/schemas');
const { processBatch } = require('../services/monitorService');

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '../../data/sample-responses.json'));
  const items = parseMonitorBody(JSON.parse(fs.readFileSync(file, 'utf8')));
  await initRepository();
  const { summary, alerts } = await processBatch(items, { source: 'file' });

  console.log(`\nFile: ${file}`);
  console.log(`Received ${summary.received} · healthy ${summary.healthy} · anomalous ${summary.anomalous} · invalid ${summary.invalid}`);
  console.log(`Alerts: ${summary.alertsCreated} new, ${summary.alertsUpdated} updated · writer: ${summary.ai.provider}\n`);
  for (const a of [...alerts.created, ...alerts.updated]) {
    console.log(`  [${a.severity.toUpperCase().padEnd(8)}] ${a.message}`);
    if (a.recommendedAction) console.log(`             Next step: ${a.recommendedAction}`);
  }
  await closeRepository();
}

main().catch((err) => {
  console.error(`monitor:file failed: ${err.message}`);
  process.exit(1);
});
