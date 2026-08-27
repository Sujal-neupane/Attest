<p align="center">
  <img src="frontend/src/assets/logo-lockup.svg" alt="Attest" width="170">
</p>

<p align="center">
  <em>The software prepares. The accountant attests.</em>
</p>

<p align="center">
  <a href="#status"><img alt="status" src="https://img.shields.io/badge/status-in%20development-9A6100"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-119%20passing-2F7A6F">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-2F7A6F">
  <img alt="postgres" src="https://img.shields.io/badge/postgres-16-2F7A6F">
</p>

---

A chartered accountant uploads a client's messy financial documents. Attest
parses them, reconciles the ledger against the bank, computes VAT and TDS,
flags what looks wrong, and produces a review sheet where **every number links
back to the page and line it came from**. The accountant reviews, overrides,
and signs.

The software never signs.

## The problem

Chartered accountants in Nepal spend most of their billable hours on work that
is repetitive and unforgiving: keying figures out of bank statements and
invoices, matching transactions by hand, computing VAT and TDS, chasing missing
bills, and assembling returns. It is slow, it is dull, and an error triggers a
penalty from the tax office.

The accounting software that exists here is built for *a business keeping its
own books*. Almost none of it is built for *the firm that audits and files for
forty client businesses at once*. That gap is what this is for.

## The one design decision everything else follows from

> **The AI never does the math.**

Deterministic, unit-tested code computes every financial figure. A language
model is used only for the fuzzy, human-shaped parts of the job: reading a
blurry scan, proposing a category for a transaction, drafting an explanation
for a flag in plain language.

A model may propose that a payment is *rent*. Only
[`domain/tax.js`](backend/src/domain/tax.js) may turn that into `Rs. 5,000.00`
of TDS, and it does so with arithmetic a human can reproduce on paper.

This is not caution for its own sake. A figure on a tax return has to be
reproducible three years later during an assessment, and "the model said so" is
not a defence anyone can file. So the boundary is architectural: the entire
`backend/src/domain/` directory is pure — no framework, no network, no clock,
no model — and it is the only thing in the system permitted to produce a number.

## How it works

```
 upload ──▶ extract ──▶ normalize ──▶ reconcile ──▶ compute ──▶ flag ──▶ REVIEW ──▶ export
              ▲                          │            │          ▲         │
              │                          └────────────┴──────────┘         │
           AI here                    deterministic code only          human here
        (and only here)              (unit-tested, reproducible)      (the only gate)
```

1. **Upload** — file goes to encrypted object storage, a parse job is queued.
2. **Extract** — a worker OCRs scans and uses an LLM to pull structured fields
   out of layouts that differ from every other layout. The location of every
   value is kept.
3. **Normalize** — everything becomes uniform transaction rows, regardless of
   which bank or which register it came from.
4. **Reconcile** — three ordered passes match bank against ledger. Ambiguous
   ties are *not guessed*; they are handed to the reviewer.
5. **Compute** — VAT at 13% and TDS by category, in integer paisa.
6. **Flag** — objective rules catch duplicates, gaps, round numbers, missing
   bills. Each flag carries its evidence.
7. **Review** — the accountant accepts, dismisses, or annotates. Every action
   is written to an immutable log.
8. **Export** — a VAT summary and a review report to file manually.

Steps 2 and part of 6 are the only places a model runs. Steps 4 and 5 — the
money — are pure code.

## Engineering decisions worth defending

**Money is an integer number of paisa. Never a float.**
`0.1 + 0.2 !== 0.3`, and a one-paisa drift across a thousand invoices is a
reconciliation difference nobody can explain to a client. Rates are integers in
basis points, so 13% is exactly `1300` and never `0.13000000000000001`.
[`domain/money.js`](backend/src/domain/money.js) · [tests](backend/tests/money.test.js)

**Tenant isolation lives in Postgres, not in application code.**
Every tenant-scoped table carries `firm_id` and has row-level security policies
checked against a session variable set from the verified JWT. A repository
method that forgets its `WHERE` clause returns zero rows instead of another
firm's client financials. Application code has bugs; this one would end the
product.

It is tested against a real database, as a `NOBYPASSRLS` role — because a
Postgres superuser bypasses RLS entirely, and testing isolation as one produces
a green test that is lying to you.
[schema](backend/db/migrations/001_initial_schema.sql) · [tests](backend/db/tests/rls.test.sql)

**The audit log refuses UPDATE and DELETE by trigger.**
Not by revoked grants, which a superuser session bypasses during exactly the
incident where the trail matters most. Corrections are new entries.

**Constraints the database enforces so the code cannot get them wrong:**
a debit must be stored negative (getting the sign wrong silently inverts a VAT
return); a resolved flag must record who resolved it (anonymous sign-off is
worse than none — it *looks* like accountability); **dismissing a high-severity
flag requires a written reason**, which is what makes the review sheet a
defensible record rather than a list somebody clicked through.

**The reconciler refuses to guess.**
Three passes run strongest-evidence-first — exact reference match, then exact
amount within a settlement window, then fuzzy amount and party name — so a weak
match can never steal a counterpart an exact match would have claimed. When two
candidates tie, it reports the ambiguity instead of picking one.
[`domain/reconciliation.js`](backend/src/domain/reconciliation.js)

**Anomaly severity is deliberately conservative.**
A false "high" teaches the reviewer to dismiss everything, which is the failure
mode that kills tools like this. Large round numbers are flagged `low`, and the
low-severity colour is a near-neutral slate — because a low-severity flag
genuinely should not pull the eye off a high one.

**Slow work never runs inside an HTTP request.**
Parsing and extraction take seconds to minutes. The API enqueues and returns;
workers process; the client polls. That is also the scaling story: more volume
means more workers, not a bigger box.

## Design

The interface is warm paper neutral and spends saturation only on meaning, so a
single high-severity flag is impossible to miss. The accent is a desaturated
verdigris, chosen partly because it stays distinguishable from the semantic red
and amber under the two most common colour-vision deficiencies — in a product
whose whole job is signalling *needs attention* versus *fine*, that is a
correctness property, not a taste one.

Money is always set in tabular figures and right-aligned, so decimal points form
a straight line down a column and the eye can compare magnitudes without
reading. It is the highest-value typographic decision in a financial interface
and it costs nothing.

[**docs/BRAND.md**](docs/BRAND.md) records the mark, the palette, the type, and
which UX law each interface decision answers — including the two logo versions
that were built, rendered, and thrown away, and why.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React (Vite), design tokens in plain CSS |
| API | Node + Express, Clean Architecture |
| Data | PostgreSQL 16 with row-level security |
| Queue | BullMQ + Redis |
| Storage | Encrypted object storage, short-lived signed URLs |
| OCR / LLM | Tesseract, Claude API (extraction and classification only) |

## Running it

```bash
git clone https://github.com/Sujal-neupane/Attest.git
cd Attest

# Unit tests — no database, no network, no setup
npm --prefix backend test

# Database tests — needs a scratch Postgres
initdb -D /tmp/attest-pgdata -U postgres --auth=trust
mkdir -p /tmp/attest-pg
pg_ctl -D /tmp/attest-pgdata -o "-k /tmp/attest-pg -p 55432" start
npm --prefix backend run test:db
```

## Status

Built and tested — **119 tests passing** (107 Node, 12 database):

- [x] Deterministic financial core — money, VAT, TDS, reconciliation, anomalies (41)
- [x] Database schema with row-level security, append-only audit log (12)
- [x] Import pipeline — CSV, column mapping, date resolution, bank statements (49)
- [x] API — auth, clients, fiscal periods, tenant isolation end to end (17)
- [x] CI on every push: unit tests, database tests, lint, dependency audit
- [x] Brand and design system

In progress:

- [ ] Document upload to encrypted storage, background worker pipeline
- [ ] Sales and purchase register import
- [ ] Review sheet with source click-through
- [ ] LLM extraction with tool calling
- [ ] Deploy, sample data, demo

Known gaps, stated rather than hidden:

- **Bikram Sambat dates are not converted.** BS month lengths need an official
  transcribed table, and a table that is nearly right silently moves
  transactions into the wrong VAT period. BS-dated files are refused at import
  with an explanation. See [`nepaliCalendar.js`](backend/src/utils/nepaliCalendar.js).
- Passwords use scrypt rather than argon2id — see
  [`password.js`](backend/src/utils/password.js) for the reasoning.

Deliberately **not** in v1, and listed so the scope stays cut: direct IRD/CBMS
filing, multi-factor auth, every bank format, mobile, billing.

## Licence

All rights reserved. Built by [Sujal Neupane](https://github.com/Sujal-neupane).
