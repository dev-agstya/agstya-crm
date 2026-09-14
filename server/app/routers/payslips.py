"""Payslips API -- the monthly pay run, and one person's own copy.

WHOSE PAYSLIP YOU MAY READ
---------------------------
Every employee always reaches their OWN, with no flag at all. That is the rule
the whole Workplace HR module follows and it applies here more obviously than
anywhere else: being told what you are owed is not a privilege. `view_payslips`
opens SOMEBODY ELSE'S; `manage_payslips` is the pay desk -- generate, adjust,
finalise, record a payment.

Enforced by `_target_user`, the only place in this file a `user_id` parameter
becomes a user. Reading a request parameter and trusting it is how "employees
see their own" becomes "employees see everybody's salary" by way of a URL
somebody edited, and a salary is the most sensitive field in a small office.

WHAT THIS ROUTER DOES NOT DO
-----------------------------
Arithmetic (`services/payroll` owns every rupee of it) and posting (paying a
payslip goes through `finance._post_expense`, the same function the
Add-transaction form and the statement importer use). Both omissions are the
point: a payroll module with its own copy of the pay rule drifts from the
register, and one with its own ledger write drifts from the books.
"""

from __future__ import annotations

import io
import uuid
from typing import Optional

from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, Response, status,
)

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction
from app.core.permissions import (
    EXPORT_DATA, MANAGE_PAYSLIPS, VIEW_PAYSLIPS, can,
)
from app.models.base import utcnow
from app.models.payslip import Payslip, PayslipStatus
from app.models.user import User
from app.routers._helpers import parse_object_id
from app.schemas.common import Message, Page
from app.schemas.payroll import (
    AdjustIn, FinaliseIn, GenerateIn, MarkPaidIn, MyPayslipSummary,
    PayRunBlocker, PayRunOut, PayRunTotals, PayslipOut,
)
from app.services import hr_attendance, hr_calendar as cal
from app.services import notifications, payroll, settings_svc
from app.services.audit import log_action

# Staff-only at the ROUTER level, like every other HR router: a new route added
# here is closed to channel partners by default. Partners are external, are not
# paid a salary by the agency, and are not covered by this module at all.
router = APIRouter(prefix="/api/hr/payslips", tags=["payslips"],
                   dependencies=[Depends(get_inhouse_user)])


# --- Access ----------------------------------------------------------------------


async def _target_user(actor: User, user_id: Optional[str]) -> User:
    """The employee an endpoint is about, having checked the caller may see them."""
    if not user_id or user_id == str(actor.id) or user_id == "me":
        return actor
    if not can(actor, VIEW_PAYSLIPS):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You can only see your own payslips.")
    target = await User.get(await parse_object_id(user_id))
    if target is None or getattr(target, "is_deleted", False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Employee not found.")
    return target


async def _load(payslip_id: str, actor: User) -> Payslip:
    """One payslip, having checked the caller may read it.

    A payslip belonging to somebody else without `view_payslips` is a 404 rather
    than a 403 -- a 403 confirms that a payslip exists for that person in that
    month, which is itself a fact about their employment.
    """
    slip = await Payslip.get(await parse_object_id(payslip_id))
    if slip is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payslip not found.")
    if slip.user_id != str(actor.id) and not can(actor, VIEW_PAYSLIPS):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payslip not found.")
    return slip


async def _lock_windows(rows: list[Payslip]) -> dict[str, str]:
    """{month: the date its drafts lock themselves} for the months on screen.

    Asked ONLY for months that still hold a draft, which is almost always
    exactly one -- a locked payslip has no deadline left and a list of somebody's
    twelve payslips must not cost twelve calendar reads to render. Same shape as
    the disputed-set lookup beside it: resolve once for the list, never per row.
    """
    months = {r.month for r in rows if r.status == PayslipStatus.DRAFT}
    if not months:
        return {}
    hr = (await settings_svc.get_settings()).hr
    out: dict[str, str] = {}
    for month in months:
        due = await payroll.auto_finalise_on(month, hr)
        if due is not None:
            out[month] = due.isoformat()
    return out


def _month_or_previous(month: Optional[str]) -> str:
    """A valid "YYYY-MM", or LAST month.

    Last month, not this one, and that is the whole default of this screen: a
    pay run is about the month that has finished. Opening on the current month
    would show everybody a half-built figure as the headline.
    """
    if month and len(month) == 7 and month[4] == "-":
        try:
            cal.month_bounds(month)
            return month
        except (ValueError, IndexError):
            pass
    return payroll.previous_month()


# --- One person's payslips -------------------------------------------------------


@router.get("/mine", response_model=MyPayslipSummary)
async def my_latest(actor: User = Depends(get_active_user)
                    ) -> MyPayslipSummary:
    """The strip on my own dashboard: my last payslip and how many are unpaid.

    Registered BEFORE `/{payslip_id}` -- a static path after a dynamic one is
    shadowed by it, and this router would have answered "mine" by trying to load
    a policy with the id "mine".
    """
    rows = await Payslip.find({"user_id": str(actor.id)}) \
        .sort("-month").limit(1).to_list()
    total = await Payslip.find({"user_id": str(actor.id)}).count()
    unpaid = await Payslip.find({
        "user_id": str(actor.id),
        "status": {"$in": [PayslipStatus.DRAFT, PayslipStatus.FINALISED]},
    }).count()
    disputed = (await payroll.disputed_for_months([rows[0].month])
                if rows else set())
    windows = await _lock_windows(rows)
    return MyPayslipSummary(
        latest=PayslipOut.from_model(rows[0], disputed, windows)
        if rows else None,
        total=total, unpaid=unpaid)


@router.get("", response_model=Page[PayslipOut])
async def list_payslips(
    user_id: Optional[str] = Query(default=None),
    month: Optional[str] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    actor: User = Depends(get_active_user),
) -> Page[PayslipOut]:
    """Payslips for one person, or for one month across everybody.

    NO `user_id` AND NO `month` MEANS MY OWN HISTORY, which is the safe default
    a client that forgets a parameter should land on. Asking for a whole month
    across the agency needs `view_payslips`; that check is here rather than on
    the decorator because the same endpoint legitimately serves both.

    Paginated (owner 2026-09-12) -- one person's own history, one payslip a
    month, passes 25 well within a career here. A plain Mongo query, so
    count/sort/page all happen at the database.
    """
    query: dict = {}
    if month:
        if not can(actor, VIEW_PAYSLIPS):
            # A month across everybody is somebody else's payslip by
            # definition. Scoped down rather than refused, so the employee's own
            # "August" still works.
            query["user_id"] = str(actor.id)
        query["month"] = month
    if user_id or not month:
        target = await _target_user(actor, user_id)
        query["user_id"] = str(target.id)
    if status_filter:
        query["status"] = status_filter

    total = await Payslip.find(query).count()
    rows = await Payslip.find(query).sort("-month", "user_name") \
        .skip((page - 1) * page_size).limit(page_size).to_list()
    disputed = await payroll.disputed_for_months({r.month for r in rows})
    windows = await _lock_windows(rows)
    return Page[PayslipOut](
        items=[PayslipOut.from_model(r, disputed, windows) for r in rows],
        total=total, page=page, page_size=page_size)


@router.get("/{payslip_id}", response_model=PayslipOut)
async def get_payslip(payslip_id: str,
                      actor: User = Depends(get_active_user)) -> PayslipOut:
    slip = await _load(payslip_id, actor)
    return PayslipOut.from_model(
        slip, await payroll.disputed_user_ids(slip.month),
        await _lock_windows([slip]))


# --- The pay run -----------------------------------------------------------------


@router.get("/run/{month}", response_model=PayRunOut,
            dependencies=[Depends(require_permission(VIEW_PAYSLIPS))])
async def pay_run(month: str,
                  actor: User = Depends(get_active_user)) -> PayRunOut:
    """Everybody's payslip for one month, plus what it costs and what is stuck.

    The totals are computed HERE and not in the browser. The tiles and the rows
    under them are the same screen; two derivations of "what does August cost"
    is how they end up saying different things, which on a pay screen is the
    difference between paying and not paying somebody.
    """
    key = _month_or_previous(month)
    rows = await Payslip.find({"month": key}).sort("user_name").to_list()
    employees = await hr_attendance.hr_employees()
    hr = (await settings_svc.get_settings()).hr

    # ONE query for the whole month, not one per row. The same set decides every
    # row's blockers and the screen's own summary, so the two cannot disagree
    # about who is waiting on a correction.
    disputed = await payroll.disputed_user_ids(key)
    due = await payroll.auto_finalise_on(key, hr)

    gross = sum(r.monthly_salary_paise for r in rows)
    deducted = sum(r.deduction_paise for r in rows)
    net = sum(r.net_payable_paise for r in rows)
    outstanding = sum(r.net_payable_paise for r in rows
                      if r.status in (PayslipStatus.DRAFT,
                                      PayslipStatus.FINALISED))

    # What the automatic job would do if it ran right now. Computed with the
    # SAME function the job itself uses (`payroll.blockers_for`), so the screen
    # cannot promise a lock that the job will refuse, or warn about one it would
    # have gone ahead with.
    drafts = [r for r in rows if r.status == PayslipStatus.DRAFT]
    blocked = [
        PayRunBlocker(payslip_id=str(r.id), user_id=r.user_id,
                      name=r.user_name or r.user_code, reasons=reasons)
        for r in drafts
        if (reasons := payroll.blockers_for(r, disputed=disputed))]

    return PayRunOut(
        totals=PayRunTotals(
            month=key,
            employees=len(employees),
            payslips=len(rows),
            draft=len(drafts),
            finalised=sum(1 for r in rows
                          if r.status == PayslipStatus.FINALISED),
            paid=sum(1 for r in rows if r.status == PayslipStatus.PAID),
            gross_paise=gross, deduction_paise=deducted, net_paise=net,
            outstanding_paise=outstanding,
            # Every list here names PEOPLE, not counts. "3 employees have no
            # salary on record" sends somebody hunting; three names is a to-do
            # list.
            missing_salary=[r.user_name for r in rows
                            if r.monthly_salary_paise <= 0],
            unresolved_people=[r.user_name for r in rows
                               if r.unresolved_days > 0],
            auto_finalise_days=int(
                getattr(hr, "payroll_auto_finalise_days", 0) or 0),
            auto_finalise_on=due.isoformat() if due else None,
            ready=len(drafts) - len(blocked),
            blocked=blocked),
        rows=[PayslipOut.from_model(
            r, disputed,
            {key: due.isoformat()} if due else {}) for r in rows])


@router.post("/generate", response_model=PayRunOut,
             dependencies=[Depends(require_permission(MANAGE_PAYSLIPS))])
async def generate(payload: GenerateIn, request: Request,
                   actor: User = Depends(get_active_user)) -> PayRunOut:
    """Build (or rebuild) a month's payslips from the attendance register.

    Runs on its own from the daily job on and after the 1st; this is the manual
    trigger for the month somebody corrected afterwards. `regenerate` re-reads
    the register into existing DRAFTS and is refused, per payslip, on anything
    finalised or paid -- rewriting the figure a payment was made against would
    leave that payment reconciling to nothing.
    """
    key = _month_or_previous(payload.month)
    hr = (await settings_svc.get_settings()).hr

    if payload.user_id:
        target = await User.get(await parse_object_id(payload.user_id))
        if target is None or not hr_attendance.is_hr_subject(target):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Payslips are generated for employees.")
        await payroll.generate_for(target, key, hr, actor=actor,
                                   regenerate=payload.regenerate)
        summary = {"written": 1}
    else:
        summary = await payroll.generate_month(
            key, hr, actor=actor, regenerate=payload.regenerate)

    await log_action(
        AuditAction.PAYSLIP_GENERATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", request=request,
        summary=f"Generated payslips for {key}"
                f"{' (regenerated)' if payload.regenerate else ''}",
        meta={k: str(v) for k, v in summary.items()})
    return await pay_run(key, actor)


@router.patch("/{payslip_id}/adjust", response_model=PayslipOut,
              dependencies=[Depends(require_permission(MANAGE_PAYSLIPS))])
async def adjust(payslip_id: str, payload: AdjustIn, request: Request,
                 actor: User = Depends(get_active_user)) -> PayslipOut:
    """Add or take off an amount by hand, with a reason.

    A bonus, an advance being recovered, a month somebody agreed to make good.
    Kept in its OWN field rather than folded into the computed deduction, so
    "what the rules said" and "what a person decided" are never the same number
    and a regeneration cannot quietly erase the second.
    """
    slip = await _load(payslip_id, actor)
    if slip.is_locked:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This payslip is finalised. Reopen it before adjusting it.")
    before = slip.adjustment_paise
    slip.adjustment_paise = payload.amount_paise
    slip.adjustment_note = payload.note
    payroll.apply_adjustment(slip)
    slip.updated_at = utcnow()
    await slip.save()

    await log_action(
        AuditAction.PAYSLIP_ADJUSTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", entity_id=str(slip.id), entity_code=slip.code,
        request=request,
        summary=f"Adjusted {slip.user_name}'s {slip.month} payslip by "
                f"Rs {payload.amount_paise / 100:,.2f}",
        meta={"before_paise": str(before), "after_paise":
              str(payload.amount_paise), "reason": payload.note})
    return PayslipOut.from_model(
        slip, await payroll.disputed_user_ids(slip.month),
        await _lock_windows([slip]))


@router.post("/finalise", response_model=PayRunOut,
             dependencies=[Depends(require_permission(MANAGE_PAYSLIPS))])
async def finalise(payload: FinaliseIn, request: Request,
                   actor: User = Depends(get_active_user)) -> PayRunOut:
    """Lock a month's figures and tell everybody their payslip is ready.

    Finalising is what makes a payslip real to the person it is about: until
    then it is a draft that the next correction can move. It is also what stops
    the register moving it -- see `payroll.generate_for`.

    An employee with NO SALARY on record is skipped rather than finalised at
    zero. Locking a zero would publish "you are owed nothing" to somebody whose
    record simply has not been filled in.
    """
    key = _month_or_previous(payload.month)
    query: dict = {"month": key, "status": PayslipStatus.DRAFT}
    if payload.payslip_ids:
        ids = [await parse_object_id(i) for i in payload.payslip_ids]
        query["_id"] = {"$in": ids}

    rows = await Payslip.find(query).to_list()
    now = utcnow()
    locked = skipped = 0
    for slip in rows:
        if slip.monthly_salary_paise <= 0:
            skipped += 1
            continue
        # `payroll.lock` is the ONE path to FINALISED, shared with the automatic
        # job — it sets the state and tells the employee. Two copies of "what
        # happens when a payslip is finalised" would drift, and the drift would
        # be a person being told a figure by one path and not the other.
        await payroll.lock(slip, actor=actor, now=now)
        locked += 1

    await log_action(
        AuditAction.PAYSLIP_FINALISED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", request=request,
        summary=f"Finalised {locked} payslip{'s' if locked != 1 else ''} "
                f"for {key}",
        meta={"skipped_no_salary": str(skipped)})
    return await pay_run(key, actor)


@router.post("/{payslip_id}/reopen", response_model=PayslipOut,
             dependencies=[Depends(require_permission(MANAGE_PAYSLIPS))])
async def reopen(payslip_id: str, request: Request,
                 actor: User = Depends(get_active_user)) -> PayslipOut:
    """Put a finalised payslip back to draft so it can be corrected.

    Refused once it is PAID. Money has moved; the payslip is now the record of
    what was paid, and editing it would make the ledger and the payslip disagree
    about the same transfer. The fix for a wrong payment is a correcting
    transaction, which is what the Transactions page is for.
    """
    slip = await _load(payslip_id, actor)
    if slip.status == PayslipStatus.PAID:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This payslip has been paid. Correct the payment on the "
            "Transactions page instead.")
    if slip.status != PayslipStatus.FINALISED:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Only a finalised payslip can be reopened.")
    slip.status = PayslipStatus.DRAFT
    slip.finalised_at = slip.finalised_by = slip.finalised_by_name = None
    slip.updated_at = utcnow()
    await slip.save()
    await log_action(
        AuditAction.PAYSLIP_REOPENED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", entity_id=str(slip.id), entity_code=slip.code,
        request=request,
        summary=f"Reopened {slip.user_name}'s {slip.month} payslip")
    return PayslipOut.from_model(
        slip, await payroll.disputed_user_ids(slip.month),
        await _lock_windows([slip]))


# --- Paying ----------------------------------------------------------------------


@router.post("/{payslip_id}/pay", response_model=PayslipOut,
             dependencies=[Depends(require_permission(MANAGE_PAYSLIPS))])
async def mark_paid(payslip_id: str, payload: MarkPaidIn, request: Request,
                    actor: User = Depends(get_active_user)) -> PayslipOut:
    """Record that this payslip was paid, and post the expense.

    THE EXPENSE IS POSTED THROUGH `finance._post_expense`, the same function
    behind the Add-transaction form and the statement importer. Not one line of
    ledger logic lives in this module: that function owns the bank delta, the
    account requirement and the idempotency key, and a payroll module with its
    own copy would drift from the books within a release.

    The transaction is booked as a `salary` EXPENSE against the employee
    (`paid_to_employee_id`), which is the shape the ledger already has for
    exactly this -- so a salary paid from here and one keyed by hand are the
    same row and appear identically in every report.

    The employee is told, because the owner asked for it: "when the salary is
    processed and the owner adds it in the transactions, at that time we can
    notify the employee that yes, so-and-so salary is received to you."
    """
    slip = await _load(payslip_id, actor)
    if slip.status == PayslipStatus.PAID:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "This payslip is already marked paid.")
    if slip.status == PayslipStatus.DRAFT:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Finalise this payslip before paying it, so the figure being paid "
            "is the figure on record.")
    amount = payload.amount_paise or slip.net_payable_paise
    if amount <= 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "There is nothing to pay on this payslip.")

    # Imported inside the function: routers/finance imports a great deal, and a
    # module-level import here would make the two files circular -- the same
    # arrangement routers/statement_import uses for the same reason.
    from app.routers.finance import _post_expense
    from app.schemas.finance import ExpenseCreate

    txn = await _post_expense(ExpenseCreate(
        amount_paise=amount, category="salary",
        note=f"Salary for {_month_label(slip.month)} - {slip.user_name}",
        reference=payload.reference,
        occurred_at=payload.occurred_at or utcnow(),
        paid_to_employee_id=slip.user_id,
        paid_to_name=slip.user_name,
        bank_account_id=payload.bank_account_id,
        idempotency_key=payload.idempotency_key or uuid.uuid4().hex,
    ), actor)

    now = utcnow()
    slip.status = PayslipStatus.PAID
    slip.paid_at = payload.occurred_at or now
    slip.paid_by = str(actor.id)
    slip.paid_by_name = actor.full_name
    slip.payment_txn_id = txn.id
    slip.payment_reference = payload.reference
    slip.paid_amount_paise = amount
    slip.updated_at = now
    await slip.save()

    await log_action(
        AuditAction.PAYSLIP_PAID, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", entity_id=str(slip.id), entity_code=slip.code,
        request=request,
        summary=f"Paid {slip.user_name}'s {slip.month} salary "
                f"(Rs {amount / 100:,.2f})",
        meta={"txn_id": txn.id, "reference": payload.reference or ""})

    if payload.notify:
        await notifications.create_notification(
            slip.user_id, f"Your {_month_label(slip.month)} salary was paid",
            body=f"Rs {amount / 100:,.2f}"
                 + (f", reference {payload.reference}."
                    if payload.reference else "."),
            category="payslip", link=f"/hr/payslips?month={slip.month}")
    return PayslipOut.from_model(
        slip, await payroll.disputed_user_ids(slip.month),
        await _lock_windows([slip]))


# "2026-08" -> "August 2026". Lives in `services/payroll` because the automatic
# path sends the same sentences as this one, and a month named two ways is how
# one notification list ends up carrying both "August" and "2026-08".
_month_label = payroll.month_label


# --- Export ----------------------------------------------------------------------


@router.get("/run/{month}/export", dependencies=[Depends(require_permission(
    VIEW_PAYSLIPS, EXPORT_DATA))])
async def export_pay_run(month: str,
                         actor: User = Depends(get_active_user)) -> Response:
    """The month's pay sheet -- one row per employee, money as NUMBERS.

    Numbers rather than formatted strings, for the same reason the business
    report stores them that way: a column somebody cannot total is not much of a
    pay sheet, and the first thing anybody does with this file is sum the last
    column and compare it to what left the bank.
    """
    key = _month_or_previous(month)
    rows = await Payslip.find({"month": key}).sort("user_name").to_list()

    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font

    wb = Workbook()
    ws = wb.active
    ws.title = f"Pay {key}"
    ws.append(["Employee", "Code", "Designation", "Monthly salary",
               "Per day", "Calendar days", "Present", "WFH", "Half days",
               "Paid leave", "Unpaid leave", "Absent", "Late marks",
               "Late penalty (days)", "Before joining (days)",
               "Payable days", "Loss of pay (days)", "Deduction",
               "Adjustment", "Net payable", "Status", "Paid on"])
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center")

    for r in rows:
        ws.append([
            r.user_name, r.user_code, r.designation or "",
            r.monthly_salary_paise / 100, r.per_day_paise / 100,
            r.calendar_days, r.present_days, r.wfh_days, r.half_days,
            r.paid_leave_days, r.unpaid_leave_days, r.absent_days,
            r.late_marks, r.late_penalty_days, r.pre_joining_days,
            r.payable_days, r.lop_days, r.deduction_paise / 100,
            r.adjustment_paise / 100, r.net_payable_paise / 100,
            r.status,
            r.paid_at.strftime("%d/%m/%Y") if r.paid_at else ""])

    ws.append([])
    ws.append([f"Per-day rate is the monthly salary divided by "
               f"{rows[0].days_divisor if rows else 30}, so the same absence "
               f"costs the same in every month."])
    ws.freeze_panes = "D2"
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["C"].width = 18

    buf = io.BytesIO()
    wb.save(buf)
    await log_action(
        AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", summary=f"Exported the {key} pay sheet")
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument."
                   "spreadsheetml.sheet",
        headers={"Content-Disposition":
                 f'attachment; filename="payroll-{key}.xlsx"'})


@router.delete("/{payslip_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_PAYSLIPS))])
async def cancel_payslip(payslip_id: str, request: Request,
                         actor: User = Depends(get_active_user)) -> Message:
    """Write a payslip off. Refused once it has been paid.

    CANCELLED, not deleted. A payslip that existed and was withdrawn is a fact
    somebody will ask about; a missing row is not an answer. It also keeps the
    unique (user, month) index honest -- deleting the document would let the
    monthly job silently generate a replacement the next morning, which is
    exactly what cancelling it was meant to prevent.
    """
    slip = await _load(payslip_id, actor)
    if slip.status == PayslipStatus.PAID:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "A paid payslip cannot be cancelled.")
    slip.status = PayslipStatus.CANCELLED
    slip.updated_at = utcnow()
    await slip.save()
    await log_action(
        AuditAction.PAYSLIP_CANCELLED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="payslip", entity_id=str(slip.id), entity_code=slip.code,
        request=request,
        summary=f"Cancelled {slip.user_name}'s {slip.month} payslip")
    return Message(detail="Payslip cancelled.")
