<p align="center">
  <img src="frontend/src/assets/logo-lockup.svg" alt="Attest" width="170">
</p>

<p align="center">
  <em>The software prepares. The accountant attests.</em>
</p>

<p align="center">
  <a href="#status"><img alt="status" src="https://img.shields.io/badge/status-in%20development-9A6100"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-321%20passing-2F7A6F">
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

**What the client's books SAY is stored separately from what the engine COMPUTES.**
A register stating Rs. 1,000 of VAT on a Rs. 10,000 taxable sale is wrong by
Rs. 300, and that discrepancy is precisely what an accountant is paid to find.
Writing the computed figure over the reported one would make the two agree and
the error vanish — so `reported_vat_paisa` and `vat_paisa` are different
columns, and their difference becomes a flag.

**Re-running the review never re-asks a question already answered.**
A flag an accountant has accepted or dismissed survives a re-run with its note
and attribution intact. Stale open flags are marked `superseded` — a status of
its own, not `dismissed`, because dismissed means a person decided and the
schema rightly demands to know who. Recording a machine action as a human one
is the kind of false accountability the audit trail exists to prevent.

**Anomaly severity is deliberately conservative.**
A false "high" teaches the reviewer to dismiss everything, which is the failure
mode that kills tools like this. Large round numbers are flagged `low`, and the
low-severity colour is a near-neutral slate — because a low-severity flag
genuinely should not pull the eye off a high one.

**The Bikram Sambat calendar is generated and verified, not trusted.**
BS month lengths are not derivable from a formula — each month runs 29 to 32
days on a pattern that varies year to year — so conversion needs a published
table. Several npm packages carry one. This project consults *two independently
written implementations for every single day in the range* and only commits the
table where they agree on all of them, then checks it three more ways: every
year sums to 365 or 366, every month is 29–32 days, and each year's total equals
the Gregorian gap between its own Baisakh 1 and the next year's — plus known
Nepali New Year dates that come from neither package.

The two packages turned out to **disagree on 492 dates**, diverging from BS 2087
onward where the published calendar is still provisional. The table stops at the
last year they agree on, and conversion beyond it throws. A refused conversion is
a support ticket; an extrapolated one is a misfiled return.
[generator](backend/db/data/generate-bs-calendar.js) · [tests](backend/tests/nepaliCalendar.test.js)

**Slow work never runs inside an HTTP request.**
Parsing and extraction take seconds to minutes. The API enqueues and returns
`202 Accepted`; a separate worker process parses; the client polls. That is also
the scaling story: more volume means more workers, not a bigger box.

The queue is Postgres with `SKIP LOCKED`, not Redis. The deciding reason is that
enqueueing happens in the **same transaction** as the document row it refers to.
With a separate broker those two can diverge — the row commits, the enqueue
fails, and a document is never parsed and never marked failed. That silent drop
is the thing this product must not do.

**The AI is checked, not trusted — even about what it read.**
The tax engine stops a model from *calculating* a figure. Extraction is the
second, quieter way a wrong number gets into a return: a model does not need to
compute anything to report Rs. 13,100 from an invoice that says Rs. 11,300. The
transposition is plausible, and every calculation on top of it would be perfect.

So every extracted value must arrive with the exact text it was read from, and
that text is checked back against the document. A quote that is not in the
document, or a figure that is not in the quote, rejects the **whole**
extraction — it becomes a flag for a human, never a set of transactions with one
unverified number inside. The model's job is to *locate* a value; reading it is
ours.

Every tool it can call is read-only. There is no tool that computes VAT, writes
a transaction, or resolves a flag. An agent that can only read cannot cause a
wrong figure to be filed, whatever it decides.
[`grounding.js`](backend/src/services/ai/grounding.js) · [tests](backend/tests/grounding.test.js)

**Object storage is encrypted by us, not by the provider.**
Documents are AES-256-GCM encrypted *before* upload, so an S3-compatible bucket
holds ciphertext and never the key. Provider-side encryption is worth enabling
too, but on its own it only protects against a stolen disk — the provider holds
those keys, so it does not stop the company renting you a bucket from reading a
client's bank statement.

The S3 client signs its own requests. `@aws-sdk/client-s3` is tens of megabytes
and a large dependency tree for four verbs against one bucket, in an image that
holds client financial data. SigV4 is ~100 lines, verified against AWS's own
published test vectors, and the whole client is exercised against a real MinIO
server — a signing bug there fails loudly on every request rather than
corrupting anything quietly.
[`sigv4.js`](backend/src/services/storage/sigv4.js) · [tests](backend/tests/sigv4.test.js)

**Documents are encrypted at rest, in development as well as production.**
AES-256-GCM, which authenticates as well as encrypts, so a file altered on disk
fails to decrypt rather than returning corrupted bytes that then get parsed into
transactions. The alternative to encrypting in development is a folder of real
client bank statements in plaintext on a laptop — and an encryption path only
exercised in production is one nobody has tested. Storage keys carry ids and
never filenames, because keys reach logs and a client's name in a log line is a
confidentiality leak.

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

Built and tested — **321 tests passing** (288 backend, 21 frontend, 12 database):

- [x] Deterministic financial core — money, VAT, TDS, reconciliation, anomalies (41)
- [x] Database schema with row-level security, append-only audit log (12)
- [x] Import pipeline — CSV, column mapping, date resolution, bank statements (53)
- [x] Bikram Sambat conversion from a cross-validated calendar table (11)
- [x] API — auth, clients, fiscal periods, tenant isolation end to end (20)
- [x] Encrypted document storage and a Postgres-backed job queue (28)
- [x] Upload pipeline — file → encrypted store → worker → ledger (28)
- [x] Sales and purchase register import (14)
- [x] Review engine — reconcile, compute, flag, resolve, VAT summary (18)
- [x] CI on every push: unit tests, database tests, lint, dependency audit
- [x] Brand and design system

- [x] React review sheet — keyboard-driven, with source click-through (21)
- [x] CSV export — VAT summary, review report, full ledger (9)
- [x] S3-compatible object storage, signed by hand and tested against MinIO (19)
- [x] AI extraction — read-only tool loop, grounding, PDF invoices end to end (43)

In progress:
- [ ] LLM extraction with tool calling
- [ ] Deploy, sample data, demo

## Deploying

`render.yaml` provisions the database, API and worker; `frontend/vercel.json`
covers the frontend. Migrations run before the API serves a request, and
`npm --prefix backend run seed:demo` loads a realistic Shrawan 2081 period —
uploaded, parsed and reconciled through the real pipeline, so a visitor sees
genuine output rather than a fixture.

**[docs/DEPLOY.md](docs/DEPLOY.md)** has the full steps, including the one
setting that silently breaks everything if it differs between the API and the
worker, and an honest list of what is still missing before this is a product
rather than a demo.

```bash
docker compose up --build     # database, API and worker, locally
```

## Running the whole thing

```bash
# terminal 1 — API
npm --prefix backend start

# terminal 2 — worker (parsing runs off the request path)
npm --prefix backend run worker

# terminal 3 — the app
npm --prefix frontend run dev      # http://localhost:5173
```

Known gaps, stated rather than hidden:

- **The BS calendar covers BS 2070–2086 only.** The two sources cross-validated
  to build it diverge from BS 2087 onward, where the published calendar is
  provisional. Conversion outside that range throws rather than extrapolating.
- Passwords use scrypt rather than argon2id — see
  [`password.js`](backend/src/utils/password.js) for the reasoning.

Deliberately **not** in v1, and listed so the scope stays cut: direct IRD/CBMS
filing, multi-factor auth, every bank format, mobile, billing.

## Licence

All rights reserved. Built by [Sujal Neupane](https://github.com/Sujal-neupane).
