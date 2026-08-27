/**
 * The review sheet: run the engine, read the findings, resolve them, see the
 * VAT position.
 *
 * PATCH /flags/:id is the human-in-the-loop gate — the only route in the system
 * where a person's judgement is recorded as such.
 */

const express = require('express');
const { z } = require('zod');

const reviewService = require('../services/review.service');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

const uuid = z.string().uuid('Not a valid id.');
const requestContext = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

router.post(
  '/periods/:id/reconcile',
  requireAuth,
  requireRole('admin', 'preparer'),
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.id);
    res.json(await reviewService.runReconciliation(req.user, id, requestContext(req)));
  }),
);

router.get(
  '/periods/:id/flags',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const status = z
      .enum(['open', 'accepted', 'dismissed', 'superseded'])
      .optional()
      .parse(req.query.status || undefined);
    res.json(await reviewService.listFlags(req.user, id, { status }));
  }),
);

router.get(
  '/periods/:id/reconciliations',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await reviewService.listReconciliations(req.user, uuid.parse(req.params.id)));
  }),
);

const resolveSchema = z.object({
  status: z.enum(['accepted', 'dismissed']),
  // Length is checked in the service, where the rule can explain itself in
  // terms of severity rather than as a bare schema error.
  note: z.string().trim().max(4000).optional(),
});

router.patch(
  '/flags/:id',
  requireAuth,
  // A reviewer exists to make exactly this call; a preparer may also resolve.
  requireRole('admin', 'preparer', 'reviewer'),
  asyncHandler(async (req, res) => {
    const id = uuid.parse(req.params.id);
    const body = resolveSchema.parse(req.body);
    res.json(await reviewService.resolveFlag(req.user, id, body, requestContext(req)));
  }),
);

router.get(
  '/periods/:id/vat-summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await reviewService.vatSummary(req.user, uuid.parse(req.params.id)));
  }),
);

module.exports = router;
