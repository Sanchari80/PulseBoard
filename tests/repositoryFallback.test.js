'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const config = require('../src/config');
const { getRepository, initRepository, setRepository } = require('../src/repositories');
const MemoryAlertRepository = require('../src/repositories/memoryAlertRepository');

test('MongoDB startup failure falls back to memory when enabled', async () => {
  const previousUri = config.db.uri;
  const previousFallback = config.db.fallbackToMemory;
  const previousConnect = mongoose.connect;
  const previousRepository = getRepository();

  config.db.uri = 'mongodb://unreachable.invalid:27017/api_monitor';
  config.db.fallbackToMemory = true;
  mongoose.connect = async () => {
    throw new Error('simulated MongoDB network failure');
  };

  try {
    const repository = await initRepository();
    assert.ok(repository instanceof MemoryAlertRepository);
    assert.equal(getRepository().kind, 'memory');
  } finally {
    config.db.uri = previousUri;
    config.db.fallbackToMemory = previousFallback;
    mongoose.connect = previousConnect;
    setRepository(previousRepository);
  }
});
