# Deploying Attest

Three pieces: a Postgres database, the API, and a worker. The worker is a
separate process, not a thread inside the API — parsing is CPU-heavy, and
sharing a process means one large statement makes every request slow.

---

## The one setting that will silently break everything

**`STORAGE_ENCRYPTION_KEY` must be identical on the API and the worker.**

The API encrypts each uploaded document with this key; the worker decrypts it to
parse. Give them different keys and nothing fails at boot, nothing fails at
upload, and every document then fails at parse time with an *integrity check*
error — on a file that is perfectly intact. You will spend an afternoon looking
at the storage layer before you look at the environment.

This is why `render.yaml` marks it `sync: false` rather than `generateValue:
true`: Render would generate a *different* value per service, which is exactly
the failure above.

```bash
openssl rand -base64 32     # set the SAME output on both services
```

The same applies to `STORAGE_SIGNING_SECRET`, though its failure is louder — the
links that open a source document simply stop verifying.

---

## Local, with Docker

```bash
docker compose up --build
npm --prefix backend run seed:demo      # optional: realistic demo data
npm --prefix frontend run dev           # http://localhost:5173
```

Migrations run automatically before the API starts serving.

## Local, without Docker

```bash
initdb -D /tmp/attest-pgdata -U postgres --auth=trust
mkdir -p /tmp/attest-pg
pg_ctl -D /tmp/attest-pgdata -o "-k /tmp/attest-pg -p 55432" start
createdb -h /tmp/attest-pg -p 55432 -U postgres attest

cp .env.example backend/.env            # then fill in DATABASE_URL and the secrets
npm --prefix backend install
npm --prefix backend run migrate
npm --prefix backend run seed:demo

npm --prefix backend start              # terminal 1
npm --prefix backend run worker         # terminal 2
npm --prefix frontend run dev           # terminal 3
```

---

## Deploying for free — what actually is, and what isn't

Worth stating plainly, because "free tier" is doing a lot of work on most
pricing pages:

| Piece | Free? | The catch |
|---|---|---|
| Frontend — Vercel Hobby | **Yes** | Non-commercial use |
| API — Render web service | **Yes** | Sleeps after ~15 min idle; first request then takes 30–50s |
| **Worker — Render background worker** | **No — $7/mo** | Background workers have no free instance type |
| Database — Render Postgres | **No, effectively** | The free instance is **deleted after 30 days** |
| Database — Neon | **Yes** | 0.5 GB, permanent, no card |
| Storage — Cloudflare R2 | **Yes** | 10 GB, no egress fees |
| Storage — Supabase | **Yes** | 1 GB, no card |
| AI invoice reading — Anthropic | **No** | Optional; everything else works without a key |

Two of those would quietly cost you money or data, so the free path avoids both:

**Use Neon, not Render's database.** A free Render Postgres is deleted 30 days
after you create it. A portfolio piece that dies a month after you link it on
your CV is worse than one that was never deployed.

**Run the worker inline.** Set `WORKER_MODE=inline` and the parse loop runs
inside the API process instead of a $7/month background worker.

That is a real trade-off, not a free lunch. Parsing then competes with requests
for the same event loop, so a large statement makes the API slow while it runs.
At a few documents a day it is invisible; at a hundred it is not. What it does
**not** cost you is correctness: the claim is still
`SELECT ... FOR UPDATE SKIP LOCKED`, so the guarantee that a document is parsed
exactly once lives in the database, not in the process model — which is why
changing the process model is safe at all. Two inline workers on two instances
still cannot double-process a document, and there is a test that proves it.

### The free stack, end to end

1. **Neon** — create a project, copy the connection string
2. **Cloudflare R2** — create a bucket, create an API token (Object Read & Write)
3. **Neon: create a second role.** In the Neon console → Roles → New Role,
   called `attest_app`. You now have two connection strings, and the difference
   matters more than it looks — see below.

4. **Render** — new **Web Service** (not a Blueprint, which would create the
   paid worker), build with `backend/Dockerfile`, and set:

```
NODE_ENV=production
WORKER_MODE=inline
# The OWNER role: migrations need to create tables.
MIGRATION_DATABASE_URL=<Neon owner connection string>
# The RESTRICTED role: this is what serves requests.
DATABASE_URL=<same database, user attest_app>
APP_DB_PASSWORD=<the attest_app password>
DATABASE_SSL=true
JWT_ACCESS_SECRET=<openssl rand -base64 48>
JWT_REFRESH_SECRET=<a different one>
STORAGE_BACKEND=s3
STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
STORAGE_BUCKET=attest-documents
STORAGE_REGION=auto
STORAGE_ACCESS_KEY_ID=<from R2>
STORAGE_SECRET_ACCESS_KEY=<from R2>
STORAGE_ENCRYPTION_KEY=<openssl rand -base64 32>
STORAGE_SIGNING_SECRET=<openssl rand -base64 32>
CORS_ORIGIN=https://<your-app>.vercel.app
```

4. **Vercel** — import the repo, root directory `frontend`, set
   `VITE_API_URL` to the Render URL
5. Seed the demo from the Render shell: `node db/seed/demo.js`

`STORAGE_ENCRYPTION_KEY` only needs to be set once here, because there is only
one process. The moment you split the worker out again, it must be identical on
both — see the top of this file.

### Why two database roles, and not one

A managed host hands you a single connection string for a role that **owns** the
database, and using it for everything is the obvious thing to do. Do not.

`jobs` has row-level security enabled but not forced, so the SECURITY DEFINER
function the worker uses to claim a job can see the queue across firms — which
it must, because it cannot know which firm a job belongs to until it has claimed
one. That is safe only while the application connects as a role that owns
nothing, because then the policy applies to it in full.

Connect as the owner and that same line becomes a cross-tenant leak: every firm
sees every firm's jobs, and nothing looks wrong.

So the app refuses to start if it detects it is connecting as the table owner,
and says so. That check exists because this was a real bug: while migrations ran
as a Postgres superuser everything worked, and the first time the whole thing
was run in the real topology the worker silently claimed nothing at all —
documents sat at 'uploaded' forever, with no error in any log.

---

## Render with a paid worker (the better architecture)

`render.yaml` is a blueprint — point Render at the repo and it creates all three.

Afterwards, set by hand on **both** `attest-api` and `attest-worker`:

| Variable | Value |
|---|---|
| `STORAGE_ENCRYPTION_KEY` | `openssl rand -base64 32` — the same on both |
| `STORAGE_SIGNING_SECRET` | `openssl rand -base64 32` — API only |
| `CORS_ORIGIN` | the deployed frontend URL, e.g. `https://attest.vercel.app` |

Then seed the demo, once, from the Render shell:

```bash
node db/seed/demo.js
```

### Document storage without a payment card

Every S3-compatible provider — R2 included — asks for a card before it will give
you a bucket. `STORAGE_BACKEND=postgres` removes the dependency entirely:
documents are stored as encrypted rows in the database you already have.

The bytes are the same AES-256-GCM ciphertext they would be in a bucket, so a
database dump or a backup does not expose a client's statement, and the rows are
behind the same row-level security as everything else.

It is the zero-account option, not the recommended one. A database is a poor
blob store at scale — every read pulls the whole object through the connection,
and backups grow with the documents rather than with the ledger. At kilobyte
invoices and a 0.5 GB free Neon project that is thousands of documents, which is
further than a portfolio deployment will ever get. When it stops being true,
switch `STORAGE_BACKEND` to `s3` and add the bucket credentials; nothing else
changes.

### Object storage

The API and the worker are separate processes. A local disk works only while
they share a filesystem, which stops being true the moment they are on separate
hosts — or the moment there is a second instance of either. So a real deployment
uses an S3-compatible bucket:

| Variable | Example |
|---|---|
| `STORAGE_BACKEND` | `s3` |
| `STORAGE_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` |
| `STORAGE_BUCKET` | `attest-documents` |
| `STORAGE_REGION` | `auto` for R2, the real region for AWS |
| `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY` | from the provider |
| `STORAGE_FORCE_PATH_STYLE` | `true` for MinIO and most self-hosted; `false` for AWS and R2 |

Cloudflare R2 is the recommended provider on a free tier: no egress charges, and
S3-compatible.

**Documents are encrypted by Attest before they are uploaded.** The provider
stores ciphertext and never sees the key. That is deliberate: provider-side
encryption protects against a stolen disk, but the provider holds those keys, so
it does not protect a client's bank statement from the company renting you the
bucket. `STORAGE_SERVER_SIDE_ENCRYPTION=AES256` adds their layer as well, where
supported — it is opt-in because not every provider accepts the header.

### On the free tier

Free web services sleep after inactivity, so the first request to a cold
instance takes 30–50 seconds. For a demo link someone else will open, that reads
as a broken site. Either warm it before sharing the link, or say so on the page.

---

## Frontend (Vercel)

```bash
cd frontend
vercel --prod
```

Set `VITE_API_URL` to the deployed API's origin, e.g.
`https://attest-api.onrender.com` — no trailing `/api`, the client appends it.

`vercel.json` rewrites every path to `index.html` so a deep link like
`/periods/<id>` survives a refresh, and sets the security headers the app cannot
set for itself.

---

## Before this is a real product, not a demo

Stated plainly, because a deployed thing invites people to trust it:

- **A second OCR language.** Only `eng` is installed. A bill printed in Nepali
  needs `tesseract-ocr-nep` in the image.
- **Multi-factor authentication.** Designed for, not built.
- **Data residency.** The IRD's e-billing directives expect Nepali hosting or a
  Nepal-accessible backup. Render's free regions are neither.
- **Backups with a *tested* restore.** An untested backup is a belief, not a
  backup.
- **A real secrets manager.** Environment variables are the floor.
- **Rotation for `STORAGE_ENCRYPTION_KEY`.** Right now, rotating it makes every
  stored document unreadable. Envelope encryption — a per-document key wrapped
  by a master key — is the fix, and it is not yet built.
