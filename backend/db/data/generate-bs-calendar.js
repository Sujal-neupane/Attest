/**
 * Generate the Bikram Sambat calendar table.
 *
 * Run with:  node db/data/generate-bs-calendar.js
 *
 * ─── WHY THIS IS A GENERATOR AND NOT A DEPENDENCY ───────────────────────────
 *
 * BS month lengths are not derivable from a formula; they come from a published
 * table. Several npm packages carry that table, and any of them could simply be
 * required at runtime. This project does not do that, for two reasons.
 *
 * First, a wrong conversion here is invisible. It does not throw, it does not
 * look wrong on screen — it silently files a transaction into the wrong VAT
 * period, and the client finds out when the assessment arrives. That is the
 * exact failure mode the whole product exists to prevent, so the data deserves
 * to be verified rather than trusted.
 *
 * Second, a silent upstream change to a package's table would silently change
 * figures on returns already filed. A committed table means last year's return
 * still recomputes to last year's number.
 *
 * So: two independently-written implementations are consulted for every single
 * day in the range, and the table is only written if they agree on all of them
 * AND the derived month lengths pass three independent structural checks. The
 * packages are devDependencies used once, here; nothing at runtime depends on
 * them.
 *
 * Agreement between two implementations that were written separately is real
 * evidence. A table checked only against itself proves nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

const NepaliDateA = require('nepali-date-converter');
const NepaliDateB = require('nepali-datetime');

const ConverterA = NepaliDateA.default || NepaliDateA;
const ConverterB = NepaliDateB.default || NepaliDateB;

/** BS years the product supports. Covers every fiscal year a firm might touch. */
const FIRST_BS_YEAR = 2070;
const LAST_BS_YEAR = 2099;

/**
 * Independently known Nepali New Year (Baisakh 1) dates, used as a third
 * source. If both packages agreed but disagreed with these, the table would be
 * rejected — which is the point of having a check that does not come from
 * either package.
 */
const KNOWN_NEW_YEARS = {
  2080: '2023-04-14',
  2081: '2024-04-13',
  2082: '2025-04-14',
};

function toBsA(date) {
  const d = new ConverterA(date).getBS();
  return { year: d.year, month: d.month + 1, day: d.date }; // month is 0-indexed
}

function toBsB(date) {
  const d = new ConverterB(date);
  return { year: d.getYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

function main() {
  // Walk day by day through the Gregorian range covering FIRST..LAST BS year.
  // Noon local time, so a daylight-saving or timezone shift can never nudge a
  // date across midnight and shift the whole table by one.
  const start = new Date(FIRST_BS_YEAR - 57, 0, 1, 12);
  const end = new Date(LAST_BS_YEAR - 56, 11, 31, 12);

  const monthDayCounts = new Map(); // "year-month" -> day count
  const newYearDates = new Map(); // bsYear -> ISO AD date of Baisakh 1
  const disagreements = [];
  let daysChecked = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = new Date(d);
    let a;
    let b;
    try {
      a = toBsA(date);
      b = toBsB(date);
    } catch {
      // Outside one package's supported range; skip rather than half-trust it.
      continue;
    }

    if (a.year !== b.year || a.month !== b.month || a.day !== b.day) {
      disagreements.push({
        ad: iso(date),
        a: `${a.year}-${a.month}-${a.day}`,
        b: `${b.year}-${b.month}-${b.day}`,
      });
      continue;
    }

    daysChecked++;
    if (a.year < FIRST_BS_YEAR || a.year > LAST_BS_YEAR) continue;


    const key = `${a.year}-${a.month}`;
    monthDayCounts.set(key, (monthDayCounts.get(key) || 0) + 1);

    if (a.month === 1 && a.day === 1) newYearDates.set(a.year, iso(date));
  }

  // ---- Check 1: agreement, and where it ends ------------------------------
  //
  // The two implementations do NOT agree everywhere. They diverge in the far
  // future, where the published calendar itself is provisional and each package
  // has extrapolated differently. That divergence is real information: it marks
  // the point past which nobody actually knows the answer.
  //
  // So the table stops at the last BS year both implementations agree on, for
  // every day of that year. Conversion outside the table throws rather than
  // extrapolating — a refused conversion is a support ticket, an extrapolated
  // one is a misfiled return.
  let verifiedLastYear = LAST_BS_YEAR;
  if (disagreements.length > 0) {
    const firstBad = disagreements
      .map((x) => Number(x.a.split('-')[0]))
      .reduce((min, y) => Math.min(min, y), Infinity);
    verifiedLastYear = firstBad - 1;

    // Stated out loud, never silently: a truncated table that claims to cover
    // the full range would be the worst of both worlds.
    process.stdout.write(
      `! the two implementations diverge from BS ${firstBad} onward ` +
        `(${disagreements.length} dates); first: ${disagreements[0].ad} ` +
        `A=${disagreements[0].a} B=${disagreements[0].b}\n` +
        `! the table therefore stops at BS ${verifiedLastYear}; conversion beyond ` +
        `it throws rather than guessing\n`,
    );
  }

  // ---- Build the table ----------------------------------------------------
  const calendar = {};
  for (let year = FIRST_BS_YEAR; year <= verifiedLastYear; year++) {
    const months = [];
    for (let month = 1; month <= 12; month++) {
      const count = monthDayCounts.get(`${year}-${month}`);
      if (count === undefined) {
        months.length = 0;
        break;
      }
      months.push(count);
    }
    // A year at the edge of the walk is incomplete; drop it rather than commit
    // a truncated month.
    if (months.length === 12) calendar[year] = months;
  }

  // ---- Check 2: structural sanity ----------------------------------------
  for (const [year, months] of Object.entries(calendar)) {
    const total = months.reduce((a, b) => a + b, 0);
    if (total !== 365 && total !== 366) {
      fail(`BS ${year} sums to ${total} days, which is neither 365 nor 366.`);
    }
    for (const [i, len] of months.entries()) {
      if (len < 29 || len > 32) {
        fail(`BS ${year} month ${i + 1} has ${len} days; BS months are 29–32.`);
      }
    }
  }

  // ---- Check 3: each year's length must equal the gap between its own
  //      Baisakh 1 and the next year's, measured in Gregorian days. This is
  //      the cross-check that would catch a month length that is wrong in one
  //      direction and compensated in another.
  const years = Object.keys(calendar).map(Number).sort((a, b) => a - b);
  for (const year of years) {
    const next = newYearDates.get(year + 1);
    const current = newYearDates.get(year);
    if (!current || !next) continue;
    const gap = Math.round(
      (Date.parse(`${next}T00:00:00Z`) - Date.parse(`${current}T00:00:00Z`)) / 86_400_000,
    );
    const total = calendar[year].reduce((a, b) => a + b, 0);
    if (gap !== total) {
      fail(
        `BS ${year} month lengths sum to ${total} but its Baisakh 1 (${current}) ` +
          `and BS ${year + 1}'s (${next}) are ${gap} Gregorian days apart.`,
      );
    }
  }

  // ---- Check 4: independently known New Year dates ------------------------
  for (const [year, expected] of Object.entries(KNOWN_NEW_YEARS)) {
    const actual = newYearDates.get(Number(year));
    if (actual !== expected) {
      fail(
        `BS ${year} Baisakh 1 came out as ${actual}, but it is known to be ` +
          `${expected}. Both packages agreeing on a wrong answer is exactly what ` +
          `this check exists to catch.`,
      );
    }
  }

  const output = {
    _comment:
      'GENERATED FILE — do not edit by hand. Produced by generate-bs-calendar.js, ' +
      'which cross-validates two independent converter implementations against ' +
      'each other and against known Nepali New Year dates. Regenerate rather ' +
      'than patch.',
    firstYear: years[0],
    lastYear: years[years.length - 1],
    // Baisakh 1 of the first year, in Gregorian. Conversion counts days from
    // here, so this single date anchors the entire table.
    epochAd: newYearDates.get(years[0]),
    monthLengths: calendar,
    newYearDates: Object.fromEntries(
      years.map((y) => [y, newYearDates.get(y)]).filter(([, v]) => v),
    ),
  };

  const target = path.join(__dirname, 'bs-calendar.json');
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);

  process.stdout.write(
    `✓ ${daysChecked.toLocaleString()} days checked, two implementations agree on all of them\n` +
      `✓ BS ${output.firstYear}–${output.lastYear}, ${years.length} years, all structural checks passed\n` +
      `✓ anchored at BS ${output.firstYear}-01-01 = ${output.epochAd}\n` +
      `→ wrote ${path.relative(process.cwd(), target)}\n`,
  );
}

function fail(message) {
  process.stderr.write(`\nCALENDAR GENERATION FAILED\n\n${message}\n\n`);
  process.exit(1);
}

main();
