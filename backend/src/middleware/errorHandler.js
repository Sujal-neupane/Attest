/**
 * Error handling.
 *
 * Two audiences, two different messages, and conflating them is how products
 * either leak their internals or become impossible to support:
 *
 *   - the accountant gets a sentence that says what happened and what to do,
 *     in their language, with no stack trace and no SQL;
 *   - the log gets everything, correlated by request id.
 *
 * Errors from the domain and parsing layers already carry messages written for
 * the accountant — "this file contains both 16/07/2024 and 07/16/2024, which
 * cannot both be right" — so those are passed through deliberately rather than
 * flattened into "Bad Request".
 */

const { ZodError } = require('zod');
const { MoneyError } = require('../domain/money');
const { TaxError } = require('../domain/tax');
const { CsvError } = require('../services/parsing/csv');
const { ColumnMapError } = require('../services/parsing/columnMap');
const { DateError } = require('../utils/dates');
const { NepaliCalendarError } = require('../utils/nepaliCalendar');

/** An error we are choosing to show the user. */
class ApiError extends Error {
  constructor(status, message, { code, detail, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'error';
    this.detail = detail;
    this.expose = true;
    if (cause) this.cause = cause;
  }
}

/**
 * Errors whose message is already written for the accountant. Each of these is
 * a deliberate, specific refusal from a layer that knows why it refused, and
 * replacing that with a generic message would throw away the most useful part.
 */
const USER_FACING = [
  MoneyError,
  TaxError,
  CsvError,
  ColumnMapError,
  DateError,
  NepaliCalendarError,
];

function notFound(req, _res, next) {
  next(new ApiError(404, `No route for ${req.method} ${req.path}.`, { code: 'not_found' }));
}

// eslint-disable-next-line no-unused-vars -- Express identifies the error
// handler by its four-parameter signature; `next` must stay.
function errorHandler(err, req, res, next) {
  const requestId = req.id;

  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_failed',
        message: 'Some of the details sent were not valid.',
        // Field-level detail, because a form needs to know which input to mark.
        fields: err.issues.map((i) => ({
          field: i.path.join('.') || '(body)',
          message: i.message,
        })),
        requestId,
      },
    });
  }

  if (err instanceof ApiError) {
    logError(req, err, err.status);
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.detail ? { detail: err.detail } : {}),
        requestId,
      },
    });
  }

  if (USER_FACING.some((Type) => err instanceof Type)) {
    logError(req, err, 422);
    return res.status(422).json({
      error: {
        code: snakeCase(err.name),
        message: err.message,
        ...(err.line ? { line: err.line } : {}),
        ...(err.rowNumber ? { rowNumber: err.rowNumber } : {}),
        requestId,
      },
    });
  }

  // Anything else is a bug. The user gets an apology and an id to quote; the
  // log gets the whole thing. Never the message — an unexpected error's message
  // is as likely to be a connection string as anything useful.
  logError(req, err, 500);
  return res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side. Nothing was saved.',
      requestId,
    },
  });
}

function logError(req, err, status) {
  const log = req.log || console;
  const payload = {
    err,
    status,
    // Recorded so a support conversation can start from "who and what", not
    // from "can you reproduce it".
    userId: req.user?.id,
    firmId: req.user?.firmId,
    route: `${req.method} ${req.originalUrl}`,
  };
  if (status >= 500) log.error(payload, err.message);
  else log.warn(payload, err.message);
}

function snakeCase(name) {
  return String(name)
    .replace(/Error$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase() || 'error';
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { ApiError, errorHandler, notFound, asyncHandler };
