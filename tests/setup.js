'use strict';
// Loaded first by every test file: isolate tests from any local .env.
process.env.NODE_ENV = 'test';
process.env.AI_PROVIDER = 'none';
process.env.MONGODB_URI = '';
process.env.EMAIL_ENABLED = 'false';
process.env.ENABLE_SCHEDULER = 'false';
process.env.MONITOR_API_KEY = '';
