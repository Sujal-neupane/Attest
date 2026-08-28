/**
 * Express application wiring.
 *
 * Order matters here and is deliberate: security headers before anything can
 * respond, request id before logging so every line correlates, body parsing
 * before routes, and the error handler last so it catches everything above it.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('node:crypto');
const pinoHttp = require('pino-http');

const env = require('./config/env');
const { corsOrigin } = require('./config/cors');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middleware/errorHandler');

function createApp() {
  const app = express();

  // Behind a proxy on Render/Fly, req.ip is otherwise the proxy's address —
  // which would make per-IP rate limiting apply to everyone at once.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  app.use(
    cors({
      origin: corsOrigin(env.CORS_ORIGIN),
      credentials: true,
      // An explicit list rather than a wildcard, so adding a header that
      // carries authority is a deliberate act.
      allowedHeaders: ['Content-Type', 'Authorization'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    }),
  );

  // A request id on everything, echoed to the client in error responses so a
  // support message can quote one instead of describing what happened.
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });

  app.use(
    pinoHttp({
      genReqId: (req) => req.id,
      level: env.LOG_LEVEL,
      // Financial data must never reach the logs, and neither must credentials.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.refreshToken',
        ],
        remove: true,
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );

  // 1MB is generous for JSON here; documents are uploaded as multipart to a
  // separate route with its own, larger limit.
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', routes);

  // The root is not a 404.
  //
  // This API is deployed on its own host, so `/` is what a platform's uptime
  // pinger, a browser, and anyone handed the URL all hit first. Answering with
  // a 404 and a logged stack trace made every wake-up look like an error in
  // the logs, and told a human nothing about what they had reached.
  //
  // It names the service and points at the health check. Nothing here is
  // sensitive: no version, no build id, no dependency list — an unauthenticated
  // endpoint should not describe the attack surface.
  app.get('/', (req, res) => {
    res.json({
      service: 'Attest — VAT and audit assistant',
      documentation: 'https://github.com/Sujal-neupane/Attest',
      health: '/api/health',
    });
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
