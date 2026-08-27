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

## Render (API, worker, database)

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

- **Multi-factor authentication.** Designed for, not built.
- **Data residency.** The IRD's e-billing directives expect Nepali hosting or a
  Nepal-accessible backup. Render's free regions are neither.
- **Backups with a *tested* restore.** An untested backup is a belief, not a
  backup.
- **A real secrets manager.** Environment variables are the floor.
- **Rotation for `STORAGE_ENCRYPTION_KEY`.** Right now, rotating it makes every
  stored document unreadable. Envelope encryption — a per-document key wrapped
  by a master key — is the fix, and it is not yet built.
