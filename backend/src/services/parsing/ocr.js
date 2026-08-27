/**
 * OCR for scanned and photographed bills.
 *
 * ─── WHY THE BINARY AND NOT tesseract.js ────────────────────────────────────
 *
 * tesseract.js is a WASM build of this same engine. It downloads language data
 * at runtime by default — a container that fetches a 15MB model on its first
 * upload is a container that fails on its first upload behind a firewall — and
 * it is several times slower on a page of A4.
 *
 * The binary is one apt line in the Dockerfile, already packaged and patched by
 * a distribution, and it is what every wrapper wraps. Shelling out to it means
 * one dependency fewer in an image that holds client financial documents.
 *
 * The cost is a system dependency, which is why availability is checked rather
 * than assumed: where it is missing, a scan is refused with an explanation
 * instead of crashing.
 *
 * ─── AND WHY OCR OUTPUT IS TREATED AS SUSPECT ───────────────────────────────
 *
 * OCR misreads. A 3 becomes an 8, a 1 becomes a 7, and it does so confidently.
 * Everything downstream still applies — the model must quote from this text and
 * the quotes are still checked — but grounding can only prove the model read
 * what OCR produced. It cannot prove OCR read what the paper said.
 *
 * So an OCR'd document carries that fact forward, and the review sheet raises a
 * flag telling the accountant to check the figures against the original. That
 * is the honest limit of this feature and it is stated rather than hidden.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const run = promisify(execFile);

/** A page of A4 takes a second or two; ten times that means something is wrong. */
const PAGE_TIMEOUT_MS = 30_000;

/**
 * Most invoices are one page. A 200-page scan is either a mistake or a whole
 * ledger, and either way it is not what this path is for — refusing is better
 * than spending ten minutes of CPU discovering that.
 */
const MAX_PAGES = 10;

/** Rendering above this gains accuracy; below it, OCR starts guessing. */
const RENDER_DPI = 300;

class OcrError extends Error {
  constructor(message, { permanent = true } = {}) {
    super(message);
    this.name = 'OcrError';
    this.permanent = permanent;
  }
}

let availability = null;

/**
 * Are the binaries present?
 *
 * Cached after the first check — this runs per document, and spawning two
 * processes to ask the same question every time is waste.
 */
async function isAvailable() {
  if (availability !== null) return availability;

  try {
    await Promise.all([
      run('tesseract', ['--version'], { timeout: 5000 }),
      run('pdftoppm', ['-v'], { timeout: 5000 }),
    ]);
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

/** Reset, for tests that need to exercise the unavailable path. */
function resetAvailability(value = null) {
  availability = value;
}

/**
 * OCR a scanned PDF.
 *
 * pdftoppm rasterises each page; tesseract reads each image. Both are invoked
 * with execFile and an argument array — never a shell string — so a filename
 * can never become a command. The paths are ours anyway, but a document
 * pipeline is exactly where that assumption stops being safe one day.
 */
async function ocrPdf(buffer) {
  if (!(await isAvailable())) {
    throw new OcrError(
      'This looks like a scanned document, and OCR is not installed on this ' +
        'deployment. Install tesseract-ocr and poppler-utils, or enter the bill ' +
        'through a purchase register.',
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attest-ocr-'));

  try {
    const pdfPath = path.join(workDir, 'source.pdf');
    await fs.writeFile(pdfPath, buffer, { mode: 0o600 });

    try {
      await run(
        'pdftoppm',
        ['-png', '-r', String(RENDER_DPI), '-l', String(MAX_PAGES), pdfPath, path.join(workDir, 'page')],
        { timeout: PAGE_TIMEOUT_MS * MAX_PAGES },
      );
    } catch (err) {
      // Wrapped, or a corrupt upload escapes as a raw child-process error and
      // the worker retries it three times before dying with a message about
      // exit codes that means nothing to an accountant.
      throw new OcrError(
        `This file could not be rendered for reading — it may be corrupt or not ` +
          `a PDF at all. (${err.message.split('\n')[0]})`,
      );
    }

    const images = (await fs.readdir(workDir))
      .filter((name) => name.endsWith('.png'))
      .sort();

    if (images.length === 0) {
      throw new OcrError('Nothing could be rendered from this PDF to read.');
    }

    const pages = [];
    for (const image of images) {
      pages.push(await ocrImageFile(path.join(workDir, image)));
    }

    const text = pages.join('\n\n');

    if (text.trim().length < 20) {
      throw new OcrError(
        'OCR found almost no text on this document. It may be blank, upside down, ' +
          'or too blurred to read. Try a straighter, higher-resolution scan.',
      );
    }

    return { text, pages: images.length, method: 'ocr' };
  } finally {
    // The temp directory holds a decrypted client document and full-page
    // renders of it. Removed whatever happened above.
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** OCR a photograph uploaded directly, rather than a PDF of one. */
async function ocrImage(buffer) {
  if (!(await isAvailable())) {
    throw new OcrError('OCR is not installed on this deployment.');
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attest-ocr-'));
  try {
    const imagePath = path.join(workDir, 'source');
    await fs.writeFile(imagePath, buffer, { mode: 0o600 });
    const text = await ocrImageFile(imagePath);
    return { text, pages: 1, method: 'ocr' };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ocrImageFile(imagePath) {
  try {
    // `stdout` as the output target, and PSM 6 — "a single uniform block of
    // text" — which reads an invoice's columns far better than the default
    // page-segmentation mode does.
    const { stdout } = await run(
      'tesseract',
      [imagePath, 'stdout', '--psm', '6', '-l', 'eng'],
      { timeout: PAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      throw new OcrError(
        'Reading this page took too long and was stopped. It may be unusually ' +
          'large or dense.',
      );
    }
    throw new OcrError(`OCR failed on this document: ${err.message}`);
  }
}

module.exports = {
  OcrError,
  isAvailable,
  resetAvailability,
  ocrPdf,
  ocrImage,
  MAX_PAGES,
  RENDER_DPI,
};
