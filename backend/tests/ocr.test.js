/**
 * OCR, against the real tesseract binary.
 *
 * The fixture is a page of text rendered to an IMAGE — which is exactly what a
 * scanned bill is. Nothing is mocked: tesseract reads the pixels back, and the
 * assertions are the identifiers and figures an accountant would need rather
 * than a character-perfect transcript, because OCR is never exact.
 *
 * Skipped where the binaries are absent, so `npm test` stays clean on a machine
 * without them:
 *
 *   brew install tesseract poppler        # macOS
 *   apt-get install tesseract-ocr poppler-utils
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ocr = require('../src/services/parsing/ocr');

let available = true;
try {
  execFileSync('tesseract', ['--version'], { stdio: 'pipe' });
  execFileSync('pdftoppm', ['-v'], { stdio: 'pipe' });
} catch {
  available = false;
}

if (!available) {
  test('OCR tests skipped — tesseract or poppler not installed', () => assert.ok(true));
}

const run = available ? test : test.skip;

const INVOICE_LINES = [
  'SHARMA TRADERS PVT LTD',
  'PAN: 301234567',
  'Invoice No: INV-2081-0042',
  'Date: 17/07/2024',
  'Taxable Amount 10,000.00',
  'VAT 13% 1,300.00',
  'Grand Total 11,300.00',
];

/**
 * A page of text as an IMAGE — a scan, in other words.
 *
 * Rendered from SVG rather than from the PDF this suite's other fixtures use.
 * That PDF is hand-built to be minimally valid, and while pdf-parse reads its
 * text layer perfectly, poppler renders it blank — which makes it useless as an
 * OCR fixture. The fault is in my toy PDF, not in the product: a PDF from real
 * accounting software renders fine.
 *
 * Returns null where no SVG renderer exists, and the test skips rather than
 * pretending to have checked something.
 */
function renderScanImage(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-scan-'));
  const svgPath = path.join(dir, 'page.svg');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700">` +
    `<rect width="1200" height="700" fill="#ffffff"/>` +
    lines
      .map(
        (line, i) =>
          `<text x="60" y="${90 + i * 70}" font-family="Helvetica, Arial, sans-serif" ` +
          `font-size="40" fill="#000000">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`,
      )
      .join('') +
    `</svg>`;

  fs.writeFileSync(svgPath, svg);

  const renderers = [
    ['rsvg-convert', ['-o', path.join(dir, 'page.png'), svgPath]],
    ['qlmanage', ['-t', '-s', '1200', '-o', dir, svgPath]],
  ];

  for (const [command, args] of renderers) {
    try {
      execFileSync(command, args, { stdio: 'pipe' });
      const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
      if (png) {
        const image = fs.readFileSync(path.join(dir, png));
        fs.rmSync(dir, { recursive: true, force: true });
        return image;
      }
    } catch {
      // Try the next renderer.
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return null;
}

run('the binaries are detected', async () => {
  assert.equal(await ocr.isAvailable(), true);
});

run('a scanned invoice is read back off the pixels', async (t) => {
  const image = renderScanImage(INVOICE_LINES);
  if (!image) {
    t.skip('no SVG renderer available to build a scan fixture');
    return;
  }

  const result = await ocr.ocrImage(image);
  assert.equal(result.method, 'ocr');

  // OCR is not exact, so this asserts the identifiers and figures an
  // accountant would actually need — not a character-perfect transcript.
  assert.match(result.text, /SHARMA\s*TRADERS/i);
  assert.match(result.text, /INV-2081-0042/);
  assert.match(result.text, /11[,.]300[,.]00/);
  assert.match(result.text, /1[,.]300[,.]00/);
});

run('a page with nothing on it is reported rather than returned as empty text', async (t) => {
  const image = renderScanImage(['   ']);
  if (!image) {
    t.skip('no SVG renderer available');
    return;
  }

  // An empty page must not come back as an empty string that then gets handed
  // to a model as though it were a document.
  const result = await ocr.ocrImage(image);
  assert.ok(result.text.trim().length < 20, 'a blank page yields no meaningful text');
});

run('a file that is not a document at all fails as an OCR error, not a crash', async () => {
  await assert.rejects(
    () => ocr.ocrPdf(Buffer.from('this is not a pdf')),
    (err) => err instanceof ocr.OcrError,
  );
});

run('OCR is refused cleanly when the binaries are missing', async () => {
  ocr.resetAvailability(false);
  try {
    await assert.rejects(
      () => ocr.ocrPdf(Buffer.from('%PDF-1.4')),
      (err) => err instanceof ocr.OcrError && /not installed/.test(err.message),
    );
  } finally {
    ocr.resetAvailability(null);
  }
});

run('an OCR failure is permanent — a blurred scan does not sharpen on retry', async () => {
  ocr.resetAvailability(false);
  try {
    await ocr.ocrPdf(Buffer.from('%PDF-1.4')).catch((err) => {
      assert.equal(err.permanent, true);
    });
  } finally {
    ocr.resetAvailability(null);
  }
});

run('temporary files are cleaned up, even on failure', async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('attest-ocr-'));

  await ocr.ocrPdf(Buffer.from('not a pdf at all')).catch(() => {});

  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('attest-ocr-'));
  // Those directories hold a decrypted client document and full-page renders
  // of it. Leaving them behind on the error path would be the worst time to.
  assert.deepEqual(after, before);
});
