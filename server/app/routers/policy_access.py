"""Asking to read a policy that is not yours, and deciding those asks.

THE SHAPE, AND WHERE IT COMES FROM
-----------------------------------
The owner described it from the support tooling at a previous job: "if I search
for a policy number which is 102, and I am one employee A, and other employee B
has this 101 policy, so I will be shown that this policy exists but I do not
have the permission to view this. If I want to see this, there should be one
request like button... it should send one request to the owner, or the one who
has this role of JIT approval, like a manager. Then he can approve my request so
that I can view this policy for like 12 hours."

Three endpoints do all of it: SEARCH tells you a policy exists without telling
you anything about it, REQUEST asks for it, DECIDE opens a window.

WHY THE SEARCH ENDPOINT LEAKS ON PURPOSE
-----------------------------------------
Everywhere else in this app a record you may not see is a 404, because a 403
confirms the record exists. Here, confirming it exists IS the feature — a
scoped system with no way to discover what you are missing is one where people
ring each other up, and the ringing-up is what this replaces.

The leak is bounded to exactly what a person needs in order to ask:

    the policy code, the policy number, and WHO HOLDS IT

and nothing else. No customer, no premium, no insurer, no reward, no dates. The
holder's name is included deliberately: the fastest resolution to "I need this
policy" is usually a two-minute conversation with the person whose desk it is
on, and a request queue that hides who to talk to makes that harder rather than
easier.

WHAT AN APPROVAL DOES **NOT** DO
---------------------------------
It never grants edit rights, and it never widens anything but the one policy. A
live grant adds that policy's id to the caller's `visible_filter` (see
services/policy_scope) and nothing more; `manage_policies` is still what decides
whether they can change it, and every other policy stays out of reach.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Optional

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, Depends, HTTPException, Query, Request, status,
)
from pydantic import BaseModel, Field

from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_permission,
)
from app.core.enums import AuditAction
from app.core.permissions import (
    MANAGE_POLICY_ACCESS, VIEW_POLICIES, can,
)
from app.models.base import utcnow
from app.models.policy import Policy
from app.models.policy_access import (
    DEFAULT_GRANT_HOURS, MAX_GRANT_HOURS, PolicyAccessRequest,
    PolicyAccessStatus,
)
from app.models.user import User
from app.routers._helpers import parse_object_id, search_regex
from app.schemas.common import Message, Page
from app.services import notifications, policy_scope
from app.services.audit import log_action
from app.services.codes import next_code

# Staff-only at ROUTER level. A channel partner reads their own policies through
# the portal and has no concept of somebody else's desk.
router = APIRouter(prefix="/api/policy-access", tags=["policies"],
                   dependencies=[Depends(get_inhouse_user)])


# --- Shapes ---------------------------------------------------------------------


class RestrictedPolicy(BaseModel):
    """A policy that exists and that you may not read.

    EVERY FIELD HERE IS DELIBERATE, and the ones that are absent more so. See
    the module docstring: this is the one place in the app that confirms a
    record exists to somebody who cannot open it, so what it says is the whole
    security decision.
    """

    id: str
    code: str
    policy_number: Optional[str] = None
    # Who to ask. A name, never an email or a phone number — the requester works
    # here and can find them.
    held_by: Optional[str] = None
    # Set when this person has already asked. Stops the button being pressed
    # four times and stops four rows appearing in the approver's queue.
    request_id: Optional[str] = None
    request_status: Optional[str] = None


class RestrictedSearch(BaseModel):
    items: list[RestrictedPolicy] = Field(default_factory=list)
    # True when the caller sees everything anyway, so the client can skip the
    # "you may not see these" framing entirely rather than rendering an empty
    # explanation.
    unscoped: bool = False


class AccessRequestOut(BaseModel):
    id: str
    code: str
    policy_id: str
    policy_code: str
    policy_number: Optional[str] = None
    requester_id: str
    requester_name: str
    reason: str
    status: str
    hours: int
    expires_at: Optional[str] = None
    decided_by_name: Optional[str] = None
    decided_at: Optional[str] = None
    decision_note: Optional[str] = None
    created_at: str
    # Computed, never stored — an approved row whose window closed a minute ago
    # must read as closed without a sweep having run.
    is_live: bool = False

    @classmethod
    def from_model(cls, r: PolicyAccessRequest) -> "AccessRequestOut":
        return cls(
            id=str(r.id), code=r.code, policy_id=r.policy_id,
            policy_code=r.policy_code, policy_number=r.policy_number,
            requester_id=r.requester_id, requester_name=r.requester_name,
            reason=r.reason, status=r.status, hours=r.hours,
            expires_at=r.expires_at.isoformat() if r.expires_at else None,
            decided_by_name=r.decided_by_name,
            decided_at=r.decided_at.isoformat() if r.decided_at else None,
            decision_note=r.decision_note,
            created_at=r.created_at.isoformat(),
            is_live=r.is_live())


class RequestIn(BaseModel):
    policy_id: str
    # MANDATORY, and short is fine. An approver deciding a queue of five needs
    # one line each; a request with no reason is one they have to chase before
    # they can decide, which makes the whole flow slower than walking over.
    reason: str = Field(min_length=3, max_length=300)


class DecideIn(BaseModel):
    approve: bool
    note: Optional[str] = Field(default=None, max_length=300)
    # The approver may shorten the window for a sensitive record or lengthen it
    # for somebody covering a week of leave. Clamped at the model, not trusted.
    hours: int = Field(default=DEFAULT_GRANT_HOURS, ge=1,
                       le=MAX_GRANT_HOURS)


# --- Finding what you cannot see -------------------------------------------------


@router.get("/search", response_model=RestrictedSearch,
            dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def restricted_search(
    q: str = Query(min_length=2, max_length=100),
    actor: User = Depends(get_active_user),
) -> RestrictedSearch:
    """Policies matching `q` that this person may NOT read.

    Called by the Policies page when a search comes back empty, and by the
    top-bar search alongside its ordinary hits. It answers the question a scoped
    list cannot: "is it not there, or is it not mine?"

    Matches only the CODE and the POLICY NUMBER, never the customer name. A
    customer-name search would let somebody enumerate the agency's client list
    one guess at a time, which is a materially different disclosure from
    confirming a policy number that the person is holding a document for.
    """
    if policy_scope.sees_everything(actor):
        # Nothing is restricted for this caller, so there is nothing to say.
        return RestrictedSearch(unscoped=True)

    rx = search_regex(q)
    matches = await Policy.find(
        {"$or": [{"code": rx}, {"policy_number": rx}]}).limit(20).to_list()
    if not matches:
        return RestrictedSearch()

    mine = await policy_scope.visible_filter(actor)
    visible_ids: set[str] = set()
    if mine is not None:
        ids = [p.id for p in matches]
        rows = await Policy.find({"$and": [{"_id": {"$in": ids}}, mine]}) \
            .to_list()
        visible_ids = {str(p.id) for p in rows}

    hidden = [p for p in matches if str(p.id) not in visible_ids]
    if not hidden:
        return RestrictedSearch()

    holders = await _holder_names(hidden)
    existing = await _my_requests_for(actor, [str(p.id) for p in hidden])

    out: list[RestrictedPolicy] = []
    for p in hidden:
        req = existing.get(str(p.id))
        out.append(RestrictedPolicy(
            id=str(p.id), code=p.code, policy_number=p.policy_number,
            held_by=holders.get(str(p.id)),
            request_id=str(req.id) if req else None,
            request_status=req.status if req else None))
    return RestrictedSearch(items=out)


async def _holder_names(policies: list[Policy]) -> dict[str, str]:
    """{policy id: who to ask about it}.

    The CHANNEL PARTNER's relationship manager when a partner is credited,
    otherwise the employee who booked it — which is the same resolution order
    `policy_ops.stamp_manager` uses, because it answers the same question. Read
    live rather than off the frozen `manager_id`, so the name offered is the
    person who can actually help today rather than whoever held the roster when
    the policy was written.
    """
    user_ids: set[str] = set()
    for p in policies:
        for raw in (p.partner_id, p.owner_user_id):
            if raw:
                try:
                    user_ids.add(str(PydanticObjectId(raw)))
                except Exception:  # noqa: BLE001 — a dangling id
                    continue
    if not user_ids:
        return {}
    users = {str(u.id): u for u in await User.find(
        {"_id": {"$in": [PydanticObjectId(i) for i in user_ids]}}).to_list()}

    # A second pass for the managers of any partners we just loaded.
    manager_ids = {u.relationship_manager_id for u in users.values()
                   if u.relationship_manager_id}
    managers: dict[str, User] = {}
    if manager_ids:
        ok = []
        for raw in manager_ids:
            try:
                ok.append(PydanticObjectId(raw))
            except Exception:  # noqa: BLE001
                continue
        if ok:
            managers = {str(u.id): u for u in await User.find(
                {"_id": {"$in": ok}}).to_list()}

    out: dict[str, str] = {}
    for p in policies:
        holder: Optional[User] = None
        if p.partner_id:
            partner = users.get(p.partner_id)
            if partner is not None and partner.relationship_manager_id:
                holder = managers.get(partner.relationship_manager_id)
        if holder is None:
            holder = users.get(p.owner_user_id)
        if holder is not None:
            out[str(p.id)] = holder.full_name
    return out


async def _my_requests_for(actor: User, policy_ids: list[str]
                           ) -> dict[str, PolicyAccessRequest]:
    """{policy id: this person's most recent request for it}.

    Most recent rather than "any open one", because a REJECTED request is worth
    showing too — otherwise the button reads "Request access" for ever and
    somebody asks the same question three times without ever being told no.
    """
    rows = await PolicyAccessRequest.find({
        "requester_id": str(actor.id),
        "policy_id": {"$in": policy_ids},
    }).sort("-created_at").to_list()
    out: dict[str, PolicyAccessRequest] = {}
    for r in rows:
        out.setdefault(r.policy_id, r)
    return out


# --- Asking ----------------------------------------------------------------------


@router.post("", response_model=AccessRequestOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(VIEW_POLICIES))])
async def request_access(payload: RequestIn, request: Request,
                         actor: User = Depends(get_active_user)
                         ) -> AccessRequestOut:
    """Ask to read one policy for a while."""
    policy = await Policy.get(await parse_object_id(payload.policy_id))
    if policy is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Policy not found.")

    if await policy_scope.can_see(actor, policy):
        # Told plainly rather than silently accepted. A queue full of requests
        # for policies the requester could already open is a queue the approver
        # stops reading.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "You can already open this policy.")

    live = await PolicyAccessRequest.find_one({
        "requester_id": str(actor.id), "policy_id": str(policy.id),
        "status": PolicyAccessStatus.PENDING})
    if live is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"You already asked for {policy.code}. It is waiting to be "
            f"approved.")

    row = PolicyAccessRequest(
        code=await next_code("policy_access"),
        policy_id=str(policy.id), policy_code=policy.code,
        policy_number=policy.policy_number,
        requester_id=str(actor.id), requester_name=actor.full_name,
        reason=payload.reason.strip())
    await row.insert()

    await log_action(
        AuditAction.POLICY_ACCESS_REQUESTED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy_access", entity_id=str(row.id),
        entity_code=row.code, request=request,
        summary=f"Requested access to policy {policy.code}",
        meta={"reason": row.reason, "policy_id": str(policy.id)})
    await notifications.notify_permission(
        MANAGE_POLICY_ACCESS, "Policy access request",
        body=f"{actor.full_name} asked to see {policy.code}: {row.reason}",
        category="policy_access", link="/policies?view=access-requests",
        exclude_user_id=str(actor.id))
    return AccessRequestOut.from_model(row)


@router.get("", response_model=Page[AccessRequestOut])
async def list_requests(
    mine: bool = Query(default=True),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    actor: User = Depends(get_active_user),
) -> Page[AccessRequestOut]:
    """`mine=true` is my own asks; `mine=false` is the approval queue.

    Defaulting to `mine` means a client that forgets the parameter gets the SAFE
    answer — its own requests — rather than everybody's, and asking for the
    queue without `manage_policy_access` silently narrows to the same thing
    rather than 403ing a page that legitimately shows both.

    Paginated (owner 2026-09-12): a queue that has been running for months is
    exactly the kind of list this app kept handing the browser whole. The
    filter is a plain Mongo query (not a Python-side aggregation like the
    finance reads), so the count, sort and page all happen at the database —
    no need to fetch every row to slice it in memory.
    """
    query: dict = {}
    if mine or not can(actor, MANAGE_POLICY_ACCESS):
        query["requester_id"] = str(actor.id)
    if status_filter and status_filter != "all":
        query["status"] = status_filter
    total = await PolicyAccessRequest.find(query).count()
    rows = await PolicyAccessRequest.find(query).sort("-created_at") \
        .skip((page - 1) * page_size).limit(page_size).to_list()
    return Page[AccessRequestOut](
        items=[AccessRequestOut.from_model(r) for r in rows],
        total=total, page=page, page_size=page_size)


# --- Deciding --------------------------------------------------------------------


@router.post("/{request_id}/decide", response_model=AccessRequestOut,
             dependencies=[Depends(require_permission(MANAGE_POLICY_ACCESS))])
async def decide(request_id: str, payload: DecideIn, req: Request,
                 actor: User = Depends(get_active_user)) -> AccessRequestOut:
    """Approve or refuse. Approving starts the clock FROM NOW.

    From now, and not from when the request was raised: a window that ticks
    while the request sits in a queue can be entirely spent before anybody says
    yes, and the requester would be granted access they never had.
    """
    row = await PolicyAccessRequest.get(await parse_object_id(request_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "That request is not there.")
    if row.status != PolicyAccessStatus.PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "That request has already been decided.")
    if row.requester_id == str(actor.id):
        # Even for the owner. Approving your own request is not an approval,
        # and somebody who may grant themselves access already holds
        # `view_all_policies` or does not need to ask.
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot decide your own access request.")

    now = utcnow()
    row.status = (PolicyAccessStatus.APPROVED if payload.approve
                  else PolicyAccessStatus.REJECTED)
    row.decided_by = str(actor.id)
    row.decided_by_name = actor.full_name
    row.decided_at = now
    row.decision_note = payload.note
    if payload.approve:
        row.hours = payload.hours
        row.expires_at = now + timedelta(hours=payload.hours)
    row.updated_at = now
    await row.save()

    await log_action(
        AuditAction.POLICY_ACCESS_DECIDED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy_access", entity_id=str(row.id),
        entity_code=row.code, request=req,
        summary=f"{'Approved' if payload.approve else 'Refused'} "
                f"{row.requester_name}'s access to {row.policy_code}"
                + (f" for {payload.hours}h" if payload.approve else ""),
        meta={"policy_id": row.policy_id, "note": payload.note or ""})
    await notifications.create_notification(
        row.requester_id,
        f"Access to {row.policy_code} "
        f"{'approved' if payload.approve else 'refused'}",
        body=(f"You can open it for the next {payload.hours} hours."
              if payload.approve
              else (payload.note or "Your request was not approved.")),
        category="policy_access",
        link=f"/policies/{row.policy_id}" if payload.approve else "/policies")
    return AccessRequestOut.from_model(row)


@router.post("/{request_id}/revoke", response_model=AccessRequestOut,
             dependencies=[Depends(require_permission(MANAGE_POLICY_ACCESS))])
async def revoke(request_id: str, req: Request,
                 actor: User = Depends(get_active_user)) -> AccessRequestOut:
    """Close a live window early.

    Takes effect on the requester's NEXT request, with nothing to invalidate:
    the scope is recomputed from this collection on every read, so there is no
    cached grant anywhere to go stale. That is the payoff for computing
    visibility rather than storing it.
    """
    row = await PolicyAccessRequest.get(await parse_object_id(request_id))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "That request is not there.")
    if not row.is_live():
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "That access is not open.")
    row.status = PolicyAccessStatus.REVOKED
    row.expires_at = utcnow()
    row.updated_at = utcnow()
    await row.save()
    await log_action(
        AuditAction.POLICY_ACCESS_REVOKED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="policy_access", entity_id=str(row.id),
        entity_code=row.code, request=req,
        summary=f"Revoked {row.requester_name}'s access to {row.policy_code}")
    await notifications.create_notification(
        row.requester_id, f"Access to {row.policy_code} was closed",
        category="policy_access", link="/policies")
    return AccessRequestOut.from_model(row)


@router.post("/{request_id}/cancel", response_model=Message)
async def cancel(request_id: str,
                 actor: User = Depends(get_active_user)) -> Message:
    """Withdraw your own request before anybody decides it.

    Usually because the two-minute conversation the search result pointed you
    at has already solved the problem, which is the outcome this whole flow
    would rather have than an approval.
    """
    row = await PolicyAccessRequest.get(await parse_object_id(request_id))
    if row is None or row.requester_id != str(actor.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "That request is not there.")
    if row.status != PolicyAccessStatus.PENDING:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "That request has already been decided.")
    row.status = PolicyAccessStatus.CANCELLED
    row.updated_at = utcnow()
    await row.save()
    return Message(detail="Request withdrawn.")


# --- Housekeeping ----------------------------------------------------------------


async def expire_lapsed(*, now=None) -> int:
    """Stamp EXPIRED on approved grants whose window has closed.

    READABILITY ONLY. Nothing depends on this having run — `is_live()` and
    `policy_scope.granted_policy_ids` both compare `expires_at` to the clock, so
    a missed cron cannot leave anybody's access open. What it fixes is a queue
    full of rows that say "approved" about windows that shut last week, which is
    a queue people stop believing.

    Rides the daily job. Idempotent by construction: the query only matches rows
    it is about to change.
    """
    now = now or utcnow()
    result = await PolicyAccessRequest.get_motor_collection().update_many(
        {"status": PolicyAccessStatus.APPROVED,
         "expires_at": {"$lte": now}},
        {"$set": {"status": PolicyAccessStatus.EXPIRED, "updated_at": now}})
    return int(getattr(result, "modified_count", 0) or 0)
