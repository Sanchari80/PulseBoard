'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const list = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: int(process.env.PORT, 4000),
  corsOrigins: list(process.env.CORS_ORIGINS), // empty = allow all
  monitorApiKey: process.env.MONITOR_API_KEY || '', // optional protection for write endpoints

  db: {
    // When MONGODB_URI is empty the app falls back to an in-memory store (zero-config demo).
    uri: process.env.MONGODB_URI || '',
  },

  thresholds: {
    responseTimeWarnMs: int(process.env.RESPONSE_TIME_WARN_MS, 2000),
    responseTimeCriticalMs: int(process.env.RESPONSE_TIME_CRITICAL_MS, 5000),
    minRecords: int(process.env.MIN_RECORDS, 1),
    // Statistical baseline: flag latency that is N standard deviations above an API's own history.
    baselineMinSamples: int(process.env.BASELINE_MIN_SAMPLES, 5),
    baselineSigma: Number(process.env.BASELINE_SIGMA || 3),
    baselineWindow: int(process.env.BASELINE_WINDOW, 50),
  },

  batch: {
    maxItems: int(process.env.BATCH_MAX_ITEMS, 1000),
    aiChunkSize: int(process.env.AI_CHUNK_SIZE, 8), // anomalies described per LLM call
    aiConcurrency: int(process.env.AI_CONCURRENCY, 3), // parallel LLM calls
  },

  ai: {
    // gemini | openai | none  (auto-detected from keys when unset)
    provider: (process.env.AI_PROVIDER || '').toLowerCase(),
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 15000),
    retries: int(process.env.AI_RETRIES, 1),
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      // Any OpenAI-compatible endpoint works (Groq, OpenRouter, Azure proxy, local LLM...)
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    },
  },

  email: {
    enabled: bool(process.env.EMAIL_ENABLED, false),
    onCritical: bool(process.env.EMAIL_ON_CRITICAL, true),
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'API Monitor <no-reply@example.com>',
    to: list(process.env.EMAIL_TO),
  },

  scheduler: {
    enabled: bool(process.env.ENABLE_SCHEDULER, false),
    intervalMs: int(process.env.POLL_INTERVAL_MS, 60000),
    requestTimeoutMs: int(process.env.POLL_TIMEOUT_MS, 10000),
    targetsFile: process.env.TARGETS_FILE || path.resolve(__dirname, 'targets.json'),
  },

  log: {
    level: process.env.LOG_LEVEL || (env === 'test' ? 'error' : 'info'),
    toFile: bool(process.env.LOG_TO_FILE, false),
    dir: process.env.LOG_DIR || path.resolve(__dirname, '../../logs'),
  },
};

module.exports = config;
