'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('./config');
const requestContext = require('./middleware/requestContext');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const routes = require('./routes');

function createApp({ readiness = Promise.resolve() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // correct client IPs behind Render / Railway / Nginx

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    })
  );
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : true }));
  app.use(compression());
  app.use(requestContext);
  app.use(express.json({ limit: '2mb' }));

  app.use(['/health', '/monitor', '/alerts', '/api'], async (req, res, next) => {
    try {
      await readiness;
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use(routes);
  // Same API under /api for clients that prefer a prefix (e.g. a separately hosted frontend).
  app.use('/api', routes);

  app.use(express.static(path.resolve(__dirname, '../public'), { maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
