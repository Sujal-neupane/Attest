/**
 * Route wiring.
 *
 * Controllers read the request, call one service, and send the response. They
 * contain no business logic, which is what keeps the interesting code testable
 * without an HTTP layer around it.
 */

const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');

const authService = require('../services/auth.service');
const clientService = require('../services/client.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { healthcheck } = require('../config/db');
const documentRoutes = require('./documents');

const router = express.Router();

// ---------------------------------------------------------------------------
// Validation schemas. Parsed at the edge so nothing downstream has to wonder
// whether a field is present or what shape it is.
// ---------------------------------------------------------------------------

const email = z.string().trim().toLowerCase().email('Enter a valid email address.');
const password = z
  .string()
  .min(12, 'Use at least 12 characters — this account holds client financial data.')
  .max(1024);

const registerSchema = z.object({
  firmName: z.string().trim().min(2, 'Enter your firm name.').max(200),
  fullName: z.string().trim().min(2, 'Enter your name.').max(200),
  email,
  password,
});

const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password.') });

const clientSchema = z.object({
  name: z.string().trim().min(2, "Enter the business's name.").max(200),
  pan: z
    .string()
    .trim()
    .regex(/^\d{9}$/, 'A PAN is exactly nine digits.')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.');

// startDate/endDate are optional: given a BS year (and optionally a month), the
// Gregorian range and the label are derived from the verified calendar table.
// Supplying them explicitly still works and takes precedence.
const periodSchema = z
  .object({
    label: z.string().trim().min(2).max(120).optional(),
    bsYear: z.coerce.number().int().min(2000).max(2200),
    bsMonth: z.coerce.number().int().min(1).max(12).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
  })
  .refine((v) => (v.startDate ? Boolean(v.endDate) : true), {
    message: 'Give both a start and an end date, or neither.',
    path: ['endDate'],
  })
  .refine((v) => (v.endDate ? Boolean(v.startDate) : true), {
    message: 'Give both a start and an end date, or neither.',
    path: ['startDate'],
  });

const uuid = z.string().uuid('Not a valid id.');

// ---------------------------------------------------------------------------
// Rate limits. Sign-in is limited far harder than everything else, because it
// is the only endpoint where guessing is the attack.
// ---------------------------------------------------------------------------

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many sign-in attempts. Try again in a few minutes.',
    },
  },
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const dbOk = await healthcheck().catch(() => false);
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'ok' : 'unreachable',
    });
  }),
);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const requestContext = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

router.post(
  '/auth/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const result = await authService.register(body, requestContext(req));
    res.status(201).json({
      firm: result.firm,
      user: result.user,
      ...result.tokens,
    });
  }),
);

router.post(
  '/auth/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await authService.login(body, requestContext(req));
    res.json({ user: result.user, ...result.tokens });
  }),
);

router.post(
  '/auth/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = z
      .object({ refreshToken: z.string().min(1) })
      .parse(req.body);
    res.json(authService.refresh(refreshToken));
  }),
);

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Clients and fiscal periods
// ---------------------------------------------------------------------------

router.post(
  '/clients',
  requireAuth,
  requireRole('admin', 'preparer'),
  asyncHandler(async (req, res) => {
    const body = clientSchema.parse(req.body);
    const created = await clientService.create(req.user, body, requestContext(req));
    res.status(201).json(created);
  }),
);

router.get(
  '/clients',
  requireAuth,
  asyncHandler(async (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    res.json(await clientService.list(req.user, { includeArchived }));
  }),
);

router.get(
  '/clients/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json(await clientService.get(req.user, id));
  }),
);

router.post(
  '/clients/:id/periods',
  requireAuth,
  requireRole('admin', 'preparer'),
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const body = periodSchema.parse(req.body);
    const created = await clientService.createPeriod(req.user, id, body, requestContext(req));
    res.status(201).json(created);
  }),
);

router.get(
  '/clients/:id/periods',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json(await clientService.listPeriods(req.user, id));
  }),
);

// Documents, pipeline status and parsed transactions.
router.use(documentRoutes);

module.exports = router;
