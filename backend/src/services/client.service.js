/**
 * Client businesses and their fiscal periods.
 */

const { withFirm } = require('../config/db');
const clients = require('../repositories/client.repository');
const audit = require('../repositories/audit.repository');
const { ApiError } = require('../middleware/errorHandler');
const { monthRange, fiscalYearRange } = require('../utils/nepaliCalendar');

async function create(user, { name, pan }, context = {}) {
  return withFirm(user.firmId, async (db) => {
    let created;
    try {
      created = await clients.createClient(db, { firmId: user.firmId, name, pan });
    } catch (err) {
      // 23505 is unique_violation. Translated here rather than leaked, because
      // the accountant needs to know it is a duplicate PAN, not a database code.
      if (err.code === '23505') {
        throw new ApiError(409, `A client with PAN ${pan} already exists in your firm.`, {
          code: 'duplicate_pan',
        });
      }
      throw err;
    }

    await audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: 'create_client',
      entityType: 'client',
      entityId: created.id,
      detail: { name, pan },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return created;
  });
}

async function list(user, options) {
  return withFirm(user.firmId, (db) => clients.listClients(db, options));
}

async function get(user, id) {
  return withFirm(user.firmId, async (db) => {
    const found = await clients.findClientById(db, id);
    // Row-level security has already made another firm's client invisible, so
    // this is genuinely "not found" from the caller's point of view — and 404
    // rather than 403 is also the right answer for a firm probing for ids.
    if (!found) throw new ApiError(404, 'That client was not found.', { code: 'not_found' });
    return found;
  });
}

async function createPeriod(user, clientId, { label, bsYear, bsMonth, startDate, endDate }, context = {}) {
  // Firms speak in Bikram Sambat — "Shrawan 2081", "FY 2081-82" — and the
  // engine computes in Gregorian. If the caller gives us only the BS period,
  // derive the Gregorian range rather than making an accountant convert dates
  // by hand, which is exactly the error-prone work this product exists to
  // remove. A BS year outside the verified calendar throws from the converter
  // with its own explanation.
  if (!startDate || !endDate) {
    const derived = bsMonth ? monthRange(bsYear, bsMonth) : fiscalYearRange(bsYear);
    startDate = startDate || derived.startDate;
    endDate = endDate || derived.endDate;
    label = label || derived.label;
  }

  if (endDate < startDate) {
    throw new ApiError(400, 'The period ends before it starts.', { code: 'invalid_period' });
  }

  return withFirm(user.firmId, async (db) => {
    const client = await clients.findClientById(db, clientId);
    if (!client) throw new ApiError(404, 'That client was not found.', { code: 'not_found' });

    // Overlapping periods would let one transaction land in two VAT returns.
    const overlap = await clients.findOverlappingPeriod(db, { clientId, startDate, endDate });
    if (overlap) {
      throw new ApiError(
        409,
        `This overlaps "${overlap.label}" (${overlap.startDate} to ${overlap.endDate}). ` +
          `Overlapping periods would let the same transaction be counted in two returns.`,
        { code: 'period_overlap' },
      );
    }

    const created = await clients.createPeriod(db, {
      firmId: user.firmId,
      clientId,
      label,
      bsYear,
      bsMonth,
      startDate,
      endDate,
    });

    await audit.record(db, {
      firmId: user.firmId,
      userId: user.id,
      action: 'create_period',
      entityType: 'fiscal_period',
      entityId: created.id,
      detail: { clientId, label, startDate, endDate },
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return created;
  });
}

async function listPeriods(user, clientId) {
  return withFirm(user.firmId, (db) => clients.listPeriods(db, clientId));
}

module.exports = { create, list, get, createPeriod, listPeriods };
