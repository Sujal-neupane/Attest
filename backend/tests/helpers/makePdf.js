/**
 * Build a minimal, genuinely valid PDF.
 *
 * Written rather than committed as a binary fixture so the test states what the
 * invoice SAYS in readable source — a checked-in PDF is an opaque blob that
 * nobody can review in a diff, and the whole point of these tests is that the
 * text on the page is what gets checked against the extraction.
 *
 * This is a real PDF with a real text layer, so pdf-parse exercises its actual
 * path rather than a shortcut.
 */

function escapePdfText(text) {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * @param {string[]} lines
 * @returns {Buffer}
 */
function makePdf(lines) {
  const leading = 14;
  const body = lines
    .map((line, i) => (i === 0 ? `(${escapePdfText(line)}) Tj` : `T* (${escapePdfText(line)}) Tj`))
    .join('\n');

  const content = `BT\n/F1 10 Tf\n${leading} TL\n50 780 Td\n${body}\nET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

module.exports = { makePdf };
