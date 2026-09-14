# AgastyaCRM — Backend (FastAPI)

Async FastAPI + MongoDB (Motor/Beanie) + JWT auth + Gmail SMTP + AWS S3.

## Setup

```bash
# from repo root, using the shared .venv
.venv/Scripts/python -m pip install -r server/requirements.txt

# configure secrets
cp server/.env.example server/.env   # then edit values (already provided for dev)
```

## Create the Owner account (run once, locally)

```bash
cd server
../.venv/Scripts/python create_owner.py
```

This is the ONLY way to create an Owner. It refuses to create a second one and
seeds the default policy categories.

## Run the API

```bash
cd server
../.venv/Scripts/python -m uvicorn app.main:app --reload --port 8000
```

- API docs (Swagger): http://localhost:8000/docs
- Health: http://localhost:8000/health

## Tests

```bash
cd server
../.venv/Scripts/python -m pytest
```

## Layout

```
app/
  config.py         Settings from .env
  db.py             Mongo/Beanie init
  core/             enums, permissions, security (JWT/hash), scoping, dependencies
  models/           Beanie documents
  schemas/          Pydantic request/response models
  services/         email, s3, otp, audit, codes, money, policy_ops
  routers/          auth, users, customers, insurers, policies, leads,
                    commissions, documents, reports, audit, master, public
  templates/email/  Jinja2 HTML email templates
create_owner.py     Standalone owner-creation script
```

## Scheduled jobs (cron)

Standalone jobs, wired up in `render.yaml`. Every one of them is **safe to run
twice** — a second run in the same window is a no-op rather than a double
credit — so a retried or overlapping schedule cannot corrupt anything.

- **Renewal reminders + follow-ups + policy expiry + Workplace HR** —
  `python send_reminders.py` (daily, **08:00 IST** / `30 2 * * *` UTC). Four
  unrelated jobs share this slot because they want the same time and the same
  database connection, and each is wrapped so a failure in one cannot stop the
  others. The HR half closes yesterday's forgotten punch-outs, credits the
  monthly leave accrual, lapses last year's balances and tells anybody whose day
  was auto-closed.
- **"You have not clocked in today"** — `python send_hr_nudges.py` (daily,
  **~30 minutes after shift start**; `0 5 * * *` UTC = 10:30 IST for a 10:00
  shift). Its own schedule rather than riding the 08:00 job purely because of
  the time — a nudge two hours before the shift is noise. De-duplicated per
  person per IST day against the notification rows themselves, so it needs no
  coordination with anything else. Delete the cron if the nudge is not wanted;
  nothing depends on it.
- **Monthly channel-partner statements** — `python send_partner_statements.py`
  (schedule **daily at 23:00**, e.g. `30 17 * * *` UTC for 23:00 IST). The job
  self-guards: it only does work on the **last working day** (Mon–Fri) of the
  month, rendering each active partner's statement to a PDF, archiving it in S3
  (`partner_statement/<id>/<YYYY-MM>.pdf`) and emailing it (PDF attached; also a
  WhatsApp copy when enabled). Idempotent per month; `--force` overrides both the
  date guard and the "already sent" check for a manual run.

## Deploy (Render)

- Root directory: `server`
- Build: `pip install -r requirements.txt`
- Start: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Set all `.env` values as Render environment variables. Set `CORS_ORIGINS` and
  `FRONTEND_BASE_URL` to the deployed Vercel URL.
- Add the cron jobs above as Render Cron Jobs (same root dir + env). They are
  all declared in the repo root `render.yaml`.

## Conventions

- Money stored as integer **paise**. Times stored in **UTC** (tz-aware).
- Every state change writes an `AuditLog`. Owner sees the full trail.
- Record-level data scoping was **removed**, not disabled: `core/scoping.py` and
  `visible_user_ids()` no longer exist. Every in-house user reaches every
  customer, lead and policy, and access is decided by **permission flags only**.
  `ensure_can_access()` / `build_scope_query()` survive in `routers/_helpers.py`
  as documented no-op pass-throughs so call sites need not branch — leave the
  calls in place, but do not mistake them for live enforcement.
