'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger').for('db');
const MemoryAlertRepository = require('./memoryAlertRepository');
const MongoAlertRepository = require('./mongoAlertRepository');

let repo = new MemoryAlertRepository();

/** Connect to MongoDB when configured; use memory storage only when explicitly allowed. */
async function initRepository() {
  if (!config.db.uri) {
    logger.warn('MONGODB_URI not set – using in-memory storage (alerts are lost on restart)');
    repo = new MemoryAlertRepository();
    return repo;
  }
  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  try {
    await mongoose.connect(config.db.uri, { serverSelectionTimeoutMS: 10000 });
    await mongoose.model('Alert').syncIndexes();
    logger.info(`Connected to MongoDB (${mongoose.connection.name})`);
    repo = new MongoAlertRepository();
    return repo;
  } catch (err) {
    if (!config.db.fallbackToMemory) throw err;
    logger.error('MongoDB connection failed; starting with in-memory storage. Alerts will be lost on restart until MongoDB is reachable.', {
      error: err.message,
    });
    repo = new MemoryAlertRepository();
    return repo;
  }
}

const getRepository = () => repo;
const setRepository = (r) => {
  repo = r;
};

async function closeRepository() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

module.exports = { initRepository, getRepository, setRepository, closeRepository };
