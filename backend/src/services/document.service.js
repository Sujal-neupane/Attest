/**
 * Uploading a document, and reading back its status.
 *
 * The upload path has one job beyond storing bytes: make sure that a document
 * row and the job that will parse it either both exist or neither does. That is
 * why the storage write happens first, and the row and job are written together
 * in one transaction — see the ordering note below.
 */

const crypto = require('node:crypto');
const documents = require('../repositories/document.repository');
const audit = require('../repositories/audit.repository');
const clients = require('../repositories/client.repository');
const queue = require('./queue');
const storage = require('./storage');
const { withFirm } = require('../config/db');
const { ApiError } = require('../middleware/errorHandler');

const MAX_BYTES = 25 * 1024 * 1024;

const ACCEPTED_TYPES = Object.freeze([
  'bank_statement', 'sales_register', 'purchase_register', 'invoice',
]);

/**
 * @param {object} deps  { store } — injected so tests can use a temp directory
 *                       and so swapping local storage for S3 touches one place.
 */
function createDocumentService({ store }) {
  return {
    /**
     * Store a file and queue it for parsing.
     *
     * ORDERING, and why it is this way round:
     *
     *   1. write to storage
     *   2. in ONE transaction: insert the document row + enqueue the parse job
     *
     * If step 1 succeeds and step 2 fails, the result is an orphaned encrypted
     * blob — invisible, harmless, and reclaimable by a sweep. If the order were
     * reversed, a failure would leave a row and a job pointing at a file that
     * does not exist, which fails three times and then dies with a message the
     * accountant cannot act on.
     *
     * Leaving litter is the better failure. Referring to something that is not
     * there is not.
     */
    async upload(user, fiscalPeriodId, file, context = {}) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new ApiError(400, `"${file.type}" is not a document type Attest accepts.`, {
          code: 'unsupported_type',
          detail: `Accepted: ${ACCEPTED_TYPES.join(', ')}.`,
        });
      }
      if (!file.contents?.length) {
        throw new ApiError(400, 'That file is empty.', { code: 'empty_file' });
      }
      if (file.contents.length > MAX_BYTES) {
        throw new ApiError(413, `That file is larger than ${MAX_BYTES / 1024 / 1024}MB.`, {
          code: 'file_too_large',
        });
      }

      const contentHash = storage.contentHash(file.contents);

      // Check for a duplicate before writing anything, so re-uploading the same
      // statement does not silently double every transaction in the period.
      const period = await withFirm(user.firmId, async (db) => {
        const found = await clients.findPeriodById(db, fiscalPeriodId);
        if (!found) {
          throw new ApiError(404, 'That fiscal period was not found.', { code: 'not_found' });
        }
        if (found.isLocked) {
          throw new ApiError(409, `"${found.label}" is locked and cannot take new documents.`, {
            code: 'period_locked',
          });
        }
        const duplicate = await documents.findDuplicate(db, { fiscalPeriodId, contentHash });
        if (duplicate) {
          throw new ApiError(
            409,
            `This exact file has already been uploaded to this period as ` +
              `"${duplicate.filename}". Uploading it again would double every ` +
              `transaction in it.`,
            { code: 'duplicate_document', detail: `Existing document: ${duplicate.id}` },
          );
        }
        return found;
      });

      const documentId = crypto.randomUUID();
      const storageKey = storage.buildKey({
        firmId: user.firmId,
        fiscalPeriodId,
        documentId,
      });

      const { byteSize } = await store.put(storageKey, file.contents);

      return withFirm(user.firmId, async (db) => {
        const document = await documents.create(db, {
          id: documentId,
          firmId: user.firmId,
          clientId: period.clientId,
          fiscalPeriodId,
          type: file.type,
          filename: file.filename,
          storageKey,
          contentHash,
          byteSize,
          uploadedBy: user.id,
        });

        // Same transaction as the row above. Either both land or neither does,
        // so there is never a document nobody will parse.
        const job = await queue.enqueue(db, {
          firmId: user.firmId,
          type: queue.JOB_TYPES.PARSE_DOCUMENT,
          payload: { documentId, fiscalPeriodId },
        });

        await audit.record(db, {
          firmId: user.firmId,
          userId: user.id,
          action: 'upload_document',
          entityType: 'document',
          entityId: documentId,
          detail: {
            fiscalPeriodId,
            filename: file.filename,
            type: file.type,
            byteSize,
            contentHash,
          },
          ip: context.ip,
          userAgent: context.userAgent,
        });

        return { ...document, jobId: job.id ?? null };
      });
    },

    async listForPeriod(user, fiscalPeriodId) {
      return withFirm(user.firmId, (db) => documents.listForPeriod(db, fiscalPeriodId));
    },

    async get(user, documentId) {
      return withFirm(user.firmId, async (db) => {
        const document = await documents.findById(db, documentId);
        if (!document) {
          throw new ApiError(404, 'That document was not found.', { code: 'not_found' });
        }
        return document;
      });
    },

    /**
     * Mint a short-lived link to view the original file.
     *
     * The document is fetched first so that row-level security decides whether
     * the caller may see it at all. A token is only signed for a document the
     * caller has already been shown.
     */
    async signedUrl(user, documentId, { signer, ttlSeconds = 300 }) {
      const document = await this.get(user, documentId);
      const { token, expiresAt } = signer.sign(document.storageKey, { ttlSeconds });
      return {
        url: `/api/documents/${documentId}/content?token=${token}`,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      };
    },

    /** Read the decrypted bytes, having verified the token against this document. */
    async contents(user, documentId, token, { signer }) {
      const document = await this.get(user, documentId);
      const check = signer.verify(document.storageKey, token);
      if (!check.valid) {
        throw new ApiError(
          check.reason === 'expired' ? 410 : 403,
          check.reason === 'expired'
            ? 'That link has expired. Open the document again for a fresh one.'
            : 'That link is not valid for this document.',
          { code: `link_${check.reason}` },
        );
      }
      return { document, contents: await store.get(document.storageKey) };
    },
  };
}

module.exports = { createDocumentService, ACCEPTED_TYPES, MAX_BYTES };
