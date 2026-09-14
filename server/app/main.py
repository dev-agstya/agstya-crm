"""AgastyaCRM FastAPI application entrypoint."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo.errors import DuplicateKeyError

from app import __version__
from app.config import settings
from app.core.middleware import RateLimitMiddleware, TimeoutMiddleware
from app.core.validation_errors import friendly_message
from app.db import close_db, init_db
from app.services import (
    captcha, errorlog, manager_backfill, partner_access, permissions_svc,
    policy_lifecycle,
)
from app.routers import (
    announcements,
    attendance,
    audit,
    auth,
    banks,
    brokers,
    claims,
    customers,
    documents,
    finance,
    holidays,
    insurers,
    leads,
    leave,
    managers,
    master,
    notifications,
    payslips,
    pending_txns,
    policies,
    policy_access,
    portal,
    public,
    quotes,
    rate_rules,
    reminders,
    reports,
    rewards,
    roles,
    search,
    settings as settings_router,
    statement_import,
    system,
    targets,
    users,
    wallet,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("agastyacrm")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    captcha.warn_if_misconfigured()
    # Partners created while the portal was held back carry portal_access=False
    # for a reason that no longer applies, so the deploy that opens the portal
    # is the deploy that has to let them in. Runs once ever (it stamps
    # SystemSettings), and is a cheap no-op on every other boot — after it has
    # run, a partner with portal_access=False was deliberately revoked and must
    # stay that way. Never fatal: a CRM that will not start because a backfill
    # failed is worse than a portal that opens a deploy late.
    try:
        await partner_access.open_portal_to_existing_partners()
    except Exception:  # noqa: BLE001
        logger.exception("Partner portal access backfill failed; the portal "
                         "is open but existing partners were not granted "
                         "access. It will retry on the next boot.")
    # Policies booked before relationship managers replaced teams carry no
    # manager stamp. Same shape: once ever, marked, never fatal.
    try:
        await manager_backfill.backfill_policy_managers()
    except Exception:  # noqa: BLE001
        logger.exception("Relationship-manager backfill failed; older policies "
                         "will show as Unassigned until it succeeds. It will "
                         "retry on the next boot.")
    # Permission flags were split one-pair-per-page on 2026-08-07. Accounts
    # still holding the old vocabulary are translated here. Safe to fail: every
    # permission read applies the same translation for anyone not yet migrated
    # (core/permissions.effective_permissions), so the worst case is that the
    # write is retried next boot — nobody loses access in the meantime.
    try:
        await permissions_svc.migrate_all_permissions()
    except Exception:  # noqa: BLE001
        logger.exception("Permission migration failed; accounts are still "
                         "being read through the compatibility path. It will "
                         "retry on the next boot.")
    # Age the policy book. Nothing in this app ever wrote PolicyStatus.EXPIRED
    # until 2026-08-19 (services/policy_lifecycle), so cover that ended months
    # ago is still stored as ACTIVE — on the badge, in "active policies", and in
    # what the roster counts as renewable.
    #
    # The daily cron owns this from now on; the boot call is what fixes the
    # existing book on the deploy that ships it, and what keeps a long-running
    # instance honest if a cron run is ever missed. Two `update_many` calls, so
    # it costs nothing on a book with nothing to move. Never fatal.
    try:
        aged = await policy_lifecycle.sweep()
        if aged["expired"] or aged["renewal_due"]:
            logger.info("Policy lifecycle sweep: %s expired, %s renewal due",
                        aged["expired"], aged["renewal_due"])
    except Exception:  # noqa: BLE001
        logger.exception("Policy lifecycle sweep failed; policy statuses may "
                         "lag their expiry dates until the daily job runs.")
    # Close the books on JIT policy-access grants whose window has run out.
    # READABILITY ONLY, and worth saying twice: nothing depends on this having
    # run. `PolicyAccessRequest.is_live()` and `policy_scope` both compare
    # `expires_at` to the clock, so a missed run cannot leave anybody's access
    # open — what it fixes is an approval queue full of rows claiming to be live
    # about windows that shut last week.
    try:
        lapsed = await policy_access.expire_lapsed()
        if lapsed:
            logger.info("Closed %s lapsed policy-access grants", lapsed)
    except Exception:  # noqa: BLE001
        logger.exception("Could not close lapsed policy-access grants; they "
                         "are already inert, the queue will read stale.")
    logger.info("%s v%s started (%s)", settings.app_name, __version__,
                settings.environment)
    yield
    await close_db()


app = FastAPI(
    title=f"{settings.app_name} API",
    version=__version__,
    description="Insurance-agency CRM backend.",
    lifespan=lifespan,
)

# Middleware runs outermost-first in reverse order of registration, so add the
# inner layers (timeout, rate limit) first and CORS LAST — that keeps CORS
# headers on rate-limit / timeout / error responses too.
app.add_middleware(TimeoutMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    # Auth is a Bearer header, never a cookie, so credentialed CORS buys us
    # nothing — and with it on, a CORS_ORIGINS of "*" is rejected outright by
    # the browser rather than merely being too permissive.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # The frontend and API sit on different origins (Vercel / Render), so the
    # browser hides response headers unless they are named here. Downloads
    # (statement PDFs, Excel exports) carry their filename on this one.
    expose_headers=["Content-Disposition"],
)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    """Return ONE sentence a person can act on, not the raw error array.

    This used to emit "<loc>: <raw pydantic message>", which reached users as
    `new_password: Value error, Password must contain both letters and
    numbers.` — machine punctuation around a message that was already a
    sentence. Every rewrite rule now lives in core/validation_errors, so this is
    the single place the whole app's form errors are phrased (owner A1).
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": friendly_message(exc.errors())},
    )


@app.exception_handler(DuplicateKeyError)
async def duplicate_key_handler(request: Request, exc: DuplicateKeyError):
    """A unique index rejected the write — say which field, not "server error".

    Routers check uniqueness before inserting, but a check-then-insert loses a
    race, and the index is what actually enforces it. Reaching here means the
    guard was raced (or missing), which is a conflict the caller can act on,
    not a crash worth an error reference.
    """
    field = "value"
    key = (exc.details or {}).get("keyPattern") or {}
    if key:
        field = next(iter(key)).replace("_", " ")
    logger.info("Duplicate key on %s %s: %s", request.method,
                request.url.path, key or exc)
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={"detail": f"That {field} is already in use. Please use a "
                           f"different one."},
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    """Any UNEXPECTED error: store it (traceback + context) under a reference
    code, alert the developer, and return a clean, specific-as-we-can message
    with that reference — never a bare stack trace or 'something went wrong'."""
    ref = await errorlog.record(request, exc)
    logger.error("Unhandled error %s on %s %s", ref, request.method,
                 request.url.path, exc_info=exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "detail": "Something went wrong on our side and the team has been "
                      f"notified. Please try again. Reference: {ref}",
            "error_id": ref,
        },
    )


@app.get("/", tags=["health"])
async def root() -> dict:
    return {"app": settings.app_name, "version": __version__, "status": "ok"}


@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "healthy"}


# statement_import is registered AFTER finance and mounts under
# /api/finance/statement-import. Finance declares no /statement-import/{...}
# route, so there is nothing for a dynamic segment to shadow — but the ordering
# is kept explicit because this router lives inside another one's prefix, which
# is exactly the shape the /export-before-/{id} scar came from.
#
# pending_txns mounts under /api/finance/pending-transactions for the same
# reason and with the same care: finance declares no matching dynamic segment,
# so nothing shadows it, and the ordering is kept explicit.
#
# policy_access is registered AFTER policies. It has its own /api/policy-access
# prefix and cannot collide, but the two are read together — the scope
# policies applies is the scope policy_access lets somebody out of.
for r in (auth, roles, users, managers, master, insurers, brokers, rate_rules,
          customers, policies, policy_access, leads, reminders, rewards,
          wallet, finance, statement_import, pending_txns, banks, targets,
          documents, reports, audit, notifications, system, search,
          settings_router, quotes, claims, announcements, attendance, leave,
          holidays, payslips, portal, public):
    app.include_router(r.router)
