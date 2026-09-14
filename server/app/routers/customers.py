"""Customer (policyholder) CRUD with origin-based data scoping.

Visibility & edit rules (mirror the leads model):
  - In-house users (owner/manager/employee) see ALL customers (their own, other
    in-house, and agent-created ones).
  - Agents see ONLY customers they created or that are assigned to them.
  - Agent-created customers can be edited/deleted ONLY by that agent. In-house
    customers can be edited/deleted by any in-house user with manage_customers.
"""

from __future__ import annotations

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, BackgroundTasks, Depends, File, HTTPException, Query,
    UploadFile, status,
)
from fastapi.responses import StreamingResponse

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import (
    AuditAction, PolicyStatus, RecordOrigin, is_inhouse,
)
from app.core.permissions import (
    can,
    EXPORT_DATA,
    MANAGE_CUSTOMERS,
    VIEW_AGENCY_PROFIT,
    VIEW_CUSTOMERS,
)
from app.models.base import utcnow
from app.models.customer import Customer
from app.models.document import DocumentRecord, DocumentRequest
from app.models.lead import Lead
from app.models.insurer import Insurer
from app.models.policy import Policy
from app.models.reward import Reward
from app.models.user import User
from app.routers._helpers import (
    parse_object_id, read_upload, search_regex,
)
from app.schemas.common import Message, Page
from app.schemas.customer import (
    CustomerCreate, CustomerImportFailure, CustomerImportResult, CustomerOut,
    CustomerStats, CustomerUpdate, SendResultOut,
)
from app.schemas.policy import PolicyOut
from app.services import customer_import, messaging, policy_scope, references, s3
from app.services.audit import describe_changes, diff_dict_async, log_action
from app.services.codes import next_customer_code
from app.services.exporters import export_response

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/customers", tags=["customers"],
                   dependencies=[Depends(get_inhouse_user)])

# Bulk-import limits. The file is read against the byte cap (read_upload) and
# the parsed row count is checked before any writing starts — an import does a
# few DB round-trips per row inside the 30s request timeout, so an unbounded
# file times out half-applied.
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 5000


async def ensure_mobile_unique(mobile: str | None,
                               *, exclude_id: str | None = None) -> None:
    """Raise 409 if another customer already has this mobile. Uniqueness is only
    enforced when a mobile is provided (it always is for new customers)."""
    if not mobile:
        return
    existing = await Customer.find_one({"mobile": mobile})
    if existing and str(existing.id) != (exclude_id or ""):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"A customer with mobile {mobile} already exists "
            f"({existing.name} · {existing.code}).",
        )


# --- Scoping / permission helpers ----------------------------------------------


def _origin_value(c: Customer) -> str:
    return c.origin.value if hasattr(c.origin, "value") else c.origin


def _scope_query(actor: User) -> dict:
    if is_inhouse(actor.account_type):
        return {}
    uid = str(actor.id)
    return {"$or": [{"owner_user_id": uid}, {"partner_id": uid}]}


def _can_view(actor: User, c: Customer) -> bool:
    if is_inhouse(actor.account_type):
        return True
    uid = str(actor.id)
    return c.owner_user_id == uid or c.partner_id == uid


def _can_edit(actor: User, c: Customer) -> bool:
    if not can(actor, MANAGE_CUSTOMERS):
        return False
    if _origin_value(c) == RecordOrigin.CHANNEL_PARTNER.value:
        return c.owner_user_id == str(actor.id)
    return is_inhouse(actor.account_type)


def _out(actor: User, c: Customer, agg: dict | None = None,
         in_use: bool | None = None) -> CustomerOut:
    agg = agg or {}
    total = agg.get("total", 0)
    return CustomerOut.from_model(
        c, can_edit=_can_edit(actor, c),
        total_policies=total,
        active_policies=agg.get("active", 0),
        # Where the caller hasn't looked it up, a policy count is already a
        # sufficient answer for the list view; the delete route does the full
        # check (policies AND ledger rows) before acting on it either way.
        in_use=total > 0 if in_use is None else in_use)


async def _load_viewable(actor: User, customer_id: str) -> Customer:
    cust = await Customer.get(await parse_object_id(customer_id))
    if cust is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found.")
    if not _can_view(actor, cust):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "This customer is outside your access.")
    return cust


async def _load_editable(actor: User, customer_id: str) -> Customer:
    cust = await _load_viewable(actor, customer_id)
    if not _can_edit(actor, cust):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You can't modify this customer. Agent customers can only be edited "
            "by the agent who created them.",
        )
    return cust


# Simple Mongo sorts (no per-customer aggregation needed).
_SORTS = {"recent": "-created_at", "oldest": "+created_at",
          "name_asc": "+name", "name_desc": "-name"}
# Sorts that need per-customer policy/profit aggregates (computed in Python).
_COMPUTED_SORTS = {"profit", "policies", "active_policies", "renewals"}


async def _customer_aggregates(customer_ids: list[str], *,
                               want_profit: bool,
                               scope: dict | None = None) -> dict[str, dict]:
    """Per-customer policy stats keyed by customer_id: total/active policy
    counts, soonest upcoming expiry (days, for the renewals sort) and — when
    requested — house profit. One grouped query each over the small dataset.

    `scope` is the caller's policy scope (owner 2026-08-24). Customers are not
    scoped and policies are, so the "4 policies" on a customer row has to count
    only the ones the reader may open — otherwise the Customers list quietly
    reports the size of somebody else's book, one row at a time.
    """
    from datetime import timedelta
    now = utcnow()
    agg: dict[str, dict] = {
        cid: {"total": 0, "active": 0, "soonest": None, "profit": 0}
        for cid in customer_ids}
    if not customer_ids:
        return agg
    async for p in Policy.find(policy_scope.merge(
            {"customer_id": {"$in": customer_ids}}, scope)):
        row = agg.get(p.customer_id)
        if row is None:
            continue
        row["total"] += 1
        st = p.status.value if hasattr(p.status, "value") else p.status
        if st == PolicyStatus.ACTIVE.value:
            row["active"] += 1
        if st in (PolicyStatus.ACTIVE.value, PolicyStatus.RENEWAL_DUE.value) \
                and p.expiry_date:
            exp = p.expiry_date
            if exp.tzinfo is None:
                from datetime import timezone
                exp = exp.replace(tzinfo=timezone.utc)
            days = (exp - now) / timedelta(days=1)
            if days >= 0 and (row["soonest"] is None or days < row["soonest"]):
                row["soonest"] = days
    if want_profit:
        pipeline = [
            {"$match": {"customer_id": {"$in": customer_ids}}},
            {"$group": {"_id": "$customer_id",
                        "house": {"$sum": "$house_amount"}}},
        ]
        for r in await Reward.aggregate(pipeline).to_list():
            if r["_id"] in agg:
                agg[r["_id"]]["profit"] = int(r["house"])
    return agg


# --- Endpoints ------------------------------------------------------------------


@router.get("", response_model=Page[CustomerOut],
            dependencies=[Depends(require_permission(VIEW_CUSTOMERS))])
async def list_customers(
    actor: User = Depends(get_active_user),
    q: str | None = Query(default=None),
    origin: RecordOrigin | None = Query(default=None),
    sort: str = Query(default="recent"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=500),
    include_archived: bool = Query(default=False),
    has_active_policy: bool = Query(default=False),
    renewal_due_days: int | None = Query(default=None),
) -> Page[CustomerOut]:
    filters: list[dict] = [_scope_query(actor)]
    if not include_archived:
        # Archived customers stay out of lists/search (owner Q9).
        filters.append({"is_archived": {"$ne": True}})
    if origin and is_inhouse(actor.account_type):
        filters.append({"origin": origin.value})
    if q:
        rx = search_regex(q)
        filters.append({"$or": [
            {"name": rx}, {"mobile": rx}, {"code": rx}, {"email": rx},
        ]})
    query = {"$and": filters} if len(filters) > 1 else filters[0]

    computed = sort in _COMPUTED_SORTS
    need_agg = (computed or has_active_policy or renewal_due_days is not None)
    # Resolved ONCE for the whole request. It costs one indexed roster lookup
    # and both aggregate paths below need the same answer.
    pscope = await policy_scope.visible_filter(actor)

    # Fast path: simple sort, no policy-derived filters. Paginate in Mongo and
    # only aggregate counts for the current page.
    if not need_agg:
        total = await Customer.find(query).count()
        items = (await Customer.find(query).sort(_SORTS.get(sort, "-created_at"))
                 .skip((page - 1) * page_size).limit(page_size).to_list())
        agg = await _customer_aggregates(
            [str(c.id) for c in items], want_profit=False, scope=pscope)
        return Page[CustomerOut](
            items=[_out(actor, c, agg.get(str(c.id))) for c in items],
            total=total, page=page, page_size=page_size)

    # Computed path: load the whole scoped set (per-agency data is small),
    # aggregate, filter, sort, then paginate in Python.
    all_items = await Customer.find(query).limit(20000).to_list()
    want_profit = (sort == "profit" and can(actor, VIEW_AGENCY_PROFIT))
    agg = await _customer_aggregates(
        [str(c.id) for c in all_items], want_profit=want_profit,
        scope=pscope)

    def keep(c: Customer) -> bool:
        row = agg.get(str(c.id), {})
        if has_active_policy and row.get("active", 0) <= 0:
            return False
        if renewal_due_days is not None:
            s = row.get("soonest")
            if s is None or s > renewal_due_days:
                return False
        return True

    filtered = [c for c in all_items if keep(c)]

    def sort_key(c: Customer):
        row = agg.get(str(c.id), {})
        if sort == "profit":
            return -row.get("profit", 0)
        if sort == "policies":
            return -row.get("total", 0)
        if sort == "active_policies":
            return -row.get("active", 0)
        # renewals: soonest upcoming expiry first; none last.
        s = row.get("soonest")
        return s if s is not None else float("inf")

    filtered.sort(key=sort_key)
    total = len(filtered)
    start = (page - 1) * page_size
    page_items = filtered[start:start + page_size]
    return Page[CustomerOut](
        items=[_out(actor, c, agg.get(str(c.id))) for c in page_items],
        total=total, page=page, page_size=page_size)


@router.get("/export",
            dependencies=[Depends(require_permission(VIEW_CUSTOMERS)),
                          Depends(require_permission(EXPORT_DATA))])
async def export_customers(
    background: BackgroundTasks,
    actor: User = Depends(get_active_user),
    q: str | None = Query(default=None),
    fmt: str = Query(default="excel", pattern="^(excel|xlsx|csv)$"),
):
    filters: list[dict] = [_scope_query(actor),
                           {"is_archived": {"$ne": True}}]
    if q:
        rx = search_regex(q)
        filters.append({"$or": [
            {"name": rx}, {"mobile": rx}, {"code": rx}, {"email": rx},
        ]})
    query = {"$and": filters} if len(filters) > 1 else filters[0]
    items = await Customer.find(query).sort("-created_at").limit(20000).to_list()

    headers = ["Code", "Name", "Mobile", "Email", "Created"]
    rows = ([c.code, c.name,
             c.mobile or "", c.email or "",
             c.created_at.strftime("%Y-%m-%d")] for c in items)

    background.add_task(
        log_action, AuditAction.REPORT_EXPORTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer",
        summary=f"Exported {len(items)} customers ({fmt})")
    return export_response(fmt, "customers", headers, rows,
                           sheet_title="Customers")


@router.get("/import/template",
            dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def download_customer_template(_: User = Depends(get_active_user)):
    """Download an Excel (or CSV fallback) customer-import template."""
    try:
        data = customer_import.build_template_xlsx()
        return StreamingResponse(
            iter([data]),
            media_type=("application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet"),
            headers={"Content-Disposition":
                     "attachment; filename=customer_import_template.xlsx"})
    except Exception:  # noqa: BLE001
        return StreamingResponse(
            iter([customer_import.build_template_csv()]), media_type="text/csv",
            headers={"Content-Disposition":
                     "attachment; filename=customer_import_template.csv"})


@router.post("/import", response_model=CustomerImportResult,
             dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def import_customers(
    file: UploadFile = File(...),
    actor: User = Depends(get_active_user),
) -> CustomerImportResult:
    content = await read_upload(file, MAX_IMPORT_BYTES, label="The file")
    try:
        rows = customer_import.parse_file(file.filename or "", content)
    except customer_import.ImportFormatError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc))
    if not rows:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "No data rows found in the file.")
    if len(rows) > MAX_IMPORT_ROWS:
        # Each row costs DB round-trips, and the whole import runs inside the
        # 30s request timeout — a file big enough to blow through it would be
        # abandoned half-applied, with no way to tell which half.
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That file has {len(rows):,} rows. Please split it into files of "
            f"{MAX_IMPORT_ROWS:,} rows or fewer.")

    origin = (RecordOrigin.INHOUSE if is_inhouse(actor.account_type)
              else RecordOrigin.CHANNEL_PARTNER)
    partner_id = None if is_inhouse(actor.account_type) else str(actor.id)
    created = 0
    failures: list[CustomerImportFailure] = []
    # Track mobiles seen in this file so a duplicate row also fails cleanly.
    seen: set[str] = set()

    # Pre-load the mobiles already on file in ONE query, keyed on the numbers
    # this upload actually mentions. The per-row find_one it replaces meant a
    # 500-row import made 500 extra round-trips before writing anything.
    file_mobiles = {
        digits for digits in
        ("".join(ch for ch in (r.get("mobile") or "") if ch.isdigit())
         for r in rows)
        if len(digits) == 10}
    existing_mobiles = {
        c.mobile for c in await Customer.find(
            {"mobile": {"$in": list(file_mobiles)}}).to_list()
    } if file_mobiles else set()

    for idx, row in enumerate(rows):
        rownum = idx + 2
        name = (row.get("full name") or "").strip()
        if len(name) < 2:
            failures.append(CustomerImportFailure(
                row=rownum, reason="Full Name is required."))
            continue
        mobile = "".join(ch for ch in (row.get("mobile") or "")
                         if ch.isdigit())
        if len(mobile) != 10:
            failures.append(CustomerImportFailure(
                row=rownum, reason="A valid 10-digit mobile is required."))
            continue
        if mobile in seen or mobile in existing_mobiles:
            failures.append(CustomerImportFailure(
                row=rownum, reason=f"Duplicate mobile {mobile}."))
            continue

        try:
            cust = Customer(
                code=await next_customer_code(),
                name=name, mobile=mobile,
                email=(row.get("email") or "").strip() or None,
                notes=(row.get("notes") or "").strip() or None,
                origin=origin, owner_user_id=str(actor.id),
                partner_id=partner_id, created_by=str(actor.id),
                created_by_name=actor.full_name,
            )
            await cust.insert()
            seen.add(mobile)
            created += 1
        except Exception:  # noqa: BLE001
            failures.append(CustomerImportFailure(
                row=rownum, reason="Could not be saved."))

    await log_action(
        AuditAction.CUSTOMER_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer",
        summary=f"Imported {created} customers ({len(failures)} failed)",
        meta={"created": created, "failed": len(failures)})

    total = len(rows)
    if failures:
        rows_txt = ", ".join(str(f.row) for f in failures[:20])
        detail = (f"Imported {created} of {total} customers. "
                  f"{len(failures)} failed (rows: {rows_txt}"
                  f"{'…' if len(failures) > 20 else ''}).")
    else:
        detail = f"Successfully imported all {created} customers."
    return CustomerImportResult(total=total, created=created, failed=failures,
                                detail=detail)


@router.get("/{customer_id}", response_model=CustomerOut,
            dependencies=[Depends(require_permission(VIEW_CUSTOMERS))])
async def get_customer(customer_id: str,
                       actor: User = Depends(get_active_user)) -> CustomerOut:
    cust = await _load_viewable(actor, customer_id)
    return _out(actor, cust,
                in_use=references.in_use(
                    await references.customer_refs(str(cust.id))))


@router.get("/{customer_id}/stats", response_model=CustomerStats,
            dependencies=[Depends(require_permission(VIEW_CUSTOMERS))])
async def customer_stats(customer_id: str,
                         actor: User = Depends(get_active_user)) -> CustomerStats:
    """Contribution stats for the detail view. Profit is only revealed to
    viewers holding view_agency_profit."""
    cust = await _load_viewable(actor, customer_id)
    query: dict = {"customer_id": str(cust.id)}
    if not is_inhouse(actor.account_type):
        query["partner_id"] = str(actor.id)
    # The SAME scope the list below it applies (owner 2026-08-24). A stats tile
    # counting policies the list refuses to show is two numbers on one screen
    # disagreeing, which is this app's worst bug — and it would leak the size of
    # somebody else's relationship with the customer besides.
    query = policy_scope.merge(query, await policy_scope.visible_filter(actor))
    policies = await Policy.find(query).to_list()
    total = len(policies)

    def _st(p) -> str:
        return p.status.value if hasattr(p.status, "value") else p.status

    active = sum(1 for p in policies if _st(p) == PolicyStatus.ACTIVE.value)
    total_premium = sum(p.premium_amount for p in policies)

    # Renewal rate: renewed / (renewed + lapsed + expired).
    renewed = sum(1 for p in policies if _st(p) == PolicyStatus.RENEWED.value)
    lost = sum(1 for p in policies
               if _st(p) in (PolicyStatus.LAPSED.value,
                             PolicyStatus.EXPIRED.value))
    renewal_rate = (round(renewed / (renewed + lost) * 100, 1)
                    if (renewed + lost) else None)

    can_profit = can(actor, VIEW_AGENCY_PROFIT)
    profit = None
    if can_profit:
        pipeline = [
            {"$match": {"customer_id": str(cust.id)}},
            {"$group": {"_id": None, "house": {"$sum": "$house_amount"}}},
        ]
        res = await Reward.aggregate(pipeline).to_list()
        profit = int(res[0]["house"]) if res else 0

    # Sourcing: Direct (no partner), a single partner's name, or Mixed.
    partner_ids = {p.partner_id for p in policies if p.partner_id}
    direct_count = sum(1 for p in policies if not p.partner_id)
    if total == 0:
        source = "—"
    elif not partner_ids:
        source = "Direct"
    elif direct_count == 0 and len(partner_ids) == 1:
        partner = await User.get(next(iter(partner_ids)))
        source = f"Via {partner.full_name}" if partner else "Via channel partner"
    elif direct_count == 0:
        source = "Via channel partners"
    else:
        source = "Mixed (Direct + Partner)"

    return CustomerStats(
        total_policies=total, active_policies=active,
        total_premium=total_premium, renewal_rate=renewal_rate,
        profit_contribution=profit, can_view_profit=can_profit,
        source=source)


@router.post("/{customer_id}/policies/{policy_id}/send",
             response_model=SendResultOut,
             # Sending is an OUTBOUND action (email + WhatsApp to the customer),
             # not a read. On view_policies alone a read-only account could
             # repeat the call and spam a customer in the agency's name.
             dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def send_policy_document(
    customer_id: str, policy_id: str, background: BackgroundTasks,
    to_partner: bool = Query(default=False),
    actor: User = Depends(get_active_user),
) -> SendResultOut:
    """Manually send a policy document to the customer (WhatsApp + email), and
    optionally to the attributed channel partner. Delivery runs in the
    background so the request returns immediately."""
    cust = await _load_viewable(actor, customer_id)
    policy = await Policy.get(await parse_object_id(policy_id))
    if policy is None or policy.customer_id != str(cust.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "Policy not found for this customer.")
    background.add_task(
        messaging.send_policy_document, policy, trigger="manual",
        to_customer=True, to_partner=to_partner)
    await log_action(
        AuditAction.CUSTOMER_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy", entity_id=str(policy.id), entity_code=policy.code,
        summary=f"Sent policy {policy.code} document to customer {cust.code}")
    return SendResultOut(detail="Sending the policy document…", channels={})


@router.get("/{customer_id}/policies", response_model=list[PolicyOut],
            dependencies=[Depends(require_permission(VIEW_CUSTOMERS))])
async def customer_policies(customer_id: str,
                            actor: User = Depends(get_active_user)
                            ) -> list[PolicyOut]:
    cust = await _load_viewable(actor, customer_id)
    if not can(actor, VIEW_CUSTOMERS):
        return []
    is_partner = not is_inhouse(actor.account_type)
    query: dict = {"customer_id": customer_id}
    if is_partner:
        # Partners only ever see their own policies on a shared customer.
        query["partner_id"] = str(actor.id)
    # AND STAFF SEE ONLY THEIR OWN BOOK (owner 2026-08-24). Customers are NOT
    # scoped — every in-house user may open every customer — so without this
    # clause the customer page would be a way straight round the policy scope:
    # open any customer, read every policy on them.
    #
    # Scoped in the QUERY, through the same `visible_filter` the Policies list
    # uses. A second definition of "my book" is how one screen starts showing
    # what another hides.
    query = policy_scope.merge(query, await policy_scope.visible_filter(actor))
    policies = await Policy.find(query).sort("-created_at").to_list()
    ins_ids = {PydanticObjectId(p.insurer_id) for p in policies if p.insurer_id}
    ins_map = {str(i.id): i.name for i in
               await Insurer.find({"_id": {"$in": list(ins_ids)}}).to_list()}
    return [PolicyOut.from_model(
        p, customer_name=cust.name, insurer_name=ins_map.get(p.insurer_id),
        hide_agency=is_partner)
        for p in policies]


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def create_customer(payload: CustomerCreate,
                          actor: User = Depends(get_active_user)) -> CustomerOut:
    origin = RecordOrigin.INHOUSE if is_inhouse(actor.account_type) else RecordOrigin.CHANNEL_PARTNER
    data = payload.model_dump()
    # Re-adding an archived customer's mobile restores that record (owner Q9):
    # its code, policies and finance history come back instead of a duplicate.
    if data.get("mobile"):
        archived = await Customer.find_one(
            {"mobile": data["mobile"], "is_archived": True})
        if archived is not None:
            for field, value in data.items():
                if value is not None:
                    setattr(archived, field, value)
            archived.is_archived = False
            archived.archived_at = None
            archived.updated_at = utcnow()
            await archived.save()
            await log_action(
                AuditAction.CUSTOMER_UPDATED, actor_id=str(actor.id),
                actor_name=actor.full_name,
                actor_role=actor.account_type.value,
                entity_type="customer", entity_id=str(archived.id),
                entity_code=archived.code,
                summary=f"Restored archived customer {archived.name} "
                        f"({archived.code})",
            )
            return _out(actor, archived)
    await ensure_mobile_unique(data.get("mobile"))
    # An agent always owns the customers they create.
    if not is_inhouse(actor.account_type):
        data["partner_id"] = str(actor.id)
    cust = Customer(
        code=await next_customer_code(),
        origin=origin,
        owner_user_id=str(actor.id),
        created_by=str(actor.id),
        created_by_name=actor.full_name,
        **data,
    )
    await cust.insert()
    await log_action(
        AuditAction.CUSTOMER_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer", entity_id=str(cust.id), entity_code=cust.code,
        summary=f"Created customer {cust.name} ({cust.code})",
    )
    return _out(actor, cust,
                in_use=references.in_use(
                    await references.customer_refs(str(cust.id))))


@router.patch("/{customer_id}", response_model=CustomerOut,
              dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def update_customer(customer_id: str, payload: CustomerUpdate,
                          actor: User = Depends(get_active_user)) -> CustomerOut:
    cust = await _load_editable(actor, customer_id)
    updates = payload.model_dump(exclude_unset=True)
    if "mobile" in updates and updates["mobile"] != cust.mobile:
        await ensure_mobile_unique(updates["mobile"], exclude_id=str(cust.id))
    before = {k: getattr(cust, k, None) for k in updates}
    for field, value in updates.items():
        setattr(cust, field, value)
    cust.updated_at = utcnow()
    await cust.save()
    changes = await diff_dict_async(
        before, {k: getattr(cust, k, None) for k in updates})
    clause = describe_changes(changes)
    await log_action(
        AuditAction.CUSTOMER_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer", entity_id=str(cust.id), entity_code=cust.code,
        summary=f"Updated customer {cust.name} ({cust.code})"
                + (f": {clause}" if clause else ""),
        meta={"changes": changes},
    )
    return _out(actor, cust,
                in_use=references.in_use(
                    await references.customer_refs(str(cust.id))))


@router.patch("/{customer_id}/archive", response_model=Message,
              dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def set_customer_archive(
    customer_id: str,
    archived: bool = Query(default=True),
    actor: User = Depends(get_active_user),
) -> Message:
    """Archive / unarchive a customer (owner 2026-07-17: archive REPLACES delete
    everywhere). Archived customers stay out of lists/search but keep all their
    policies and finance history intact for attribution."""
    cust = await _load_editable(actor, customer_id)
    cust.is_archived = archived
    cust.archived_at = utcnow() if archived else None
    cust.updated_at = utcnow()
    await cust.save()
    await log_action(
        AuditAction.CUSTOMER_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer", entity_id=str(cust.id), entity_code=cust.code,
        summary=f"{'Archived' if archived else 'Unarchived'} customer "
                f"{cust.name} ({cust.code})",
    )
    return Message(detail=f"Customer {'archived' if archived else 'unarchived'}.")


@router.delete("/{customer_id}", response_model=Message,
               dependencies=[Depends(require_permission(MANAGE_CUSTOMERS))])
async def delete_customer(customer_id: str, background: BackgroundTasks,
                          actor: User = Depends(get_active_user)) -> Message:
    """Delete a customer who has no policy and no money against them.

    The LINKS decide, not who is asking (owner 2026-07-26). A customer with a
    policy or a ledger row is load-bearing for finance — premium dues,
    statements, snapshots all read them — so that case is refused and archiving
    is the answer. Anyone else is someone added by mistake, and should be
    removable.

    What the customer OWNS goes with them rather than blocking the delete:
    their uploaded documents are purged from S3, any outstanding
    document-request links are dropped, and a lead they were converted from has
    its pointer cleared so it stops referring to a customer that is gone. This
    route used to archive silently when it found policies, so a DELETE could
    quietly do something other than delete.
    """
    cust = await _load_editable(actor, customer_id)
    code = cust.code
    refs = await references.customer_refs(str(cust.id))
    if references.in_use(refs):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            references.blocked_message(
                "customer", refs,
                alternative="Archive them instead"))

    # --- relational undo, in dependency order -------------------------------
    purged = 0
    async for doc in DocumentRecord.find(
            DocumentRecord.entity_type == "customer",
            DocumentRecord.entity_id == customer_id):
        # S3 is best-effort in the background; the record goes now so nothing
        # points at a file that is on its way out.
        background.add_task(s3.delete_object, doc.s3_key)
        await doc.delete()
        purged += 1
    async for req in DocumentRequest.find(
            DocumentRequest.customer_id == customer_id):
        await req.delete()
    # The lead survives — it just stops claiming it converted into someone who
    # no longer exists.
    async for lead in Lead.find(Lead.converted_customer_id == customer_id):
        lead.converted_customer_id = None
        lead.updated_at = utcnow()
        await lead.save()

    await cust.delete()
    await log_action(
        AuditAction.CUSTOMER_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="customer", entity_id=customer_id, entity_code=code,
        summary=f"Deleted customer {code} (no policies; "
                f"{purged} document(s) purged)",
    )
    return Message(detail="Customer deleted.")
