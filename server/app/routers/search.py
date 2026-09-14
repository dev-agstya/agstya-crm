"""Global quick-search across customers, policies, leads and people — scoped to
what the caller may see. Powers the top-bar command palette (Ctrl/Cmd-K)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.dependencies import (
    get_active_user, get_inhouse_user,
)
from app.core.enums import AccountType, is_inhouse
from app.core.permissions import (
    can, can_any, PEOPLE_VIEW_ANY, VIEW_AUDIT_LOGS, VIEW_CUSTOMERS,
    VIEW_LEADS, VIEW_POLICIES,
)
from app.models.audit import AuditLog
from app.models.customer import Customer
from app.models.lead import Lead
from app.models.policy import Policy
from app.models.user import User
from app.routers._helpers import build_scope_query, search_regex
from app.services import policy_scope

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/search", tags=["search"],
                   dependencies=[Depends(get_inhouse_user)])


class SearchHit(BaseModel):
    type: str          # customer | policy | lead | person | log
    id: str
    label: str
    sub: str = ""
    link: str
    # A POLICY THAT EXISTS AND THAT YOU MAY NOT OPEN (owner 2026-08-24).
    #
    # The one place in this app that admits a record exists to somebody who
    # cannot read it, and that admission IS the feature: "I will be shown that
    # this policy exists, but I do not have the permission to view this... there
    # should be one request like button." A scoped system with no way to
    # discover what you are missing is one where people ring each other up.
    #
    # The leak is bounded to the code, the number and who holds it — `sub`
    # carries the holder's name and nothing else. No customer, no premium, no
    # insurer. `link` points at the request flow rather than at the record.
    locked: bool = False


class SearchResult(BaseModel):
    hits: list[SearchHit] = []


@router.get("", response_model=SearchResult)
async def global_search(
    q: str = Query(min_length=2),
    actor: User = Depends(get_active_user),
) -> SearchResult:
    rx = search_regex(q)
    hits: list[SearchHit] = []

    if can(actor, VIEW_POLICIES):
        query = await build_scope_query(actor, {"$or": [
            {"name": rx}, {"code": rx}, {"mobile": rx}]})
        for c in await Customer.find(query).limit(6).to_list():
            hits.append(SearchHit(
                type="customer", id=str(c.id), label=c.name,
                sub=f"{c.code} · {c.mobile or ''}".strip(" ·"),
                link=f"/customers?q={c.code}"))

    if can(actor, VIEW_POLICIES):
        # SCOPED IN THE QUERY, exactly as routers/policies does it — the global
        # search reads the same collection and would otherwise be a way round
        # the whole thing. `merge` because the search's own `$or` and the
        # scope's `$or` have to be AND-ed rather than one replacing the other.
        base = {"$or": [{"code": rx}, {"policy_number": rx}]}
        query = policy_scope.merge(
            base, await policy_scope.visible_filter(actor))
        for p in await Policy.find(query).limit(6).to_list():
            hits.append(SearchHit(
                type="policy", id=str(p.id), label=p.code,
                sub=p.policy_number or p.category_key,
                link=f"/policies?q={p.code}"))
        hits.extend(await _locked_policy_hits(actor, base))

    if can(actor, VIEW_POLICIES):
        query = await build_scope_query(actor, {"$or": [
            {"name": rx}, {"code": rx}, {"mobile": rx}]})
        for ld in await Lead.find(query).limit(5).to_list():
            hits.append(SearchHit(
                type="lead", id=str(ld.id), label=ld.name,
                sub=f"{ld.code} · {ld.stage.value if hasattr(ld.stage, 'value') else ld.stage}",
                link="/leads"))

    # Audit logs — only for those who can read the trail. Matches the readable
    # summary, the reference/entity code, or the actor name.
    if can(actor, VIEW_AUDIT_LOGS):
        logs = await AuditLog.find({"$or": [
            {"summary": rx}, {"entity_code": rx}, {"actor_name": rx},
        ]}).sort("-created_at").limit(5).to_list()
        for lg in logs:
            link = f"/audit?q={lg.entity_code}" if lg.entity_code else "/audit"
            hits.append(SearchHit(
                type="log", id=str(lg.id), label=lg.summary or lg.action.value,
                sub=f"{lg.actor_name or 'system'} · "
                    f"{lg.created_at.strftime('%d %b %Y')}",
                link=link))

    # People (employees / partners) — only for those who can see the team.
    if is_inhouse(actor.account_type) and can_any(actor, *PEOPLE_VIEW_ANY):
        people = await User.find({
            "is_deleted": {"$ne": True},
            "account_type": {"$ne": AccountType.OWNER.value},
            "$or": [{"full_name": rx}, {"code": rx}, {"email": rx}],
        }).limit(5).to_list()
        for u in people:
            is_emp = u.account_type == AccountType.EMPLOYEE
            hits.append(SearchHit(
                type="person", id=str(u.id), label=u.full_name,
                sub=f"{u.code} · {u.account_type.value}",
                link="/people/employees" if is_emp else "/people/partners"))

    return SearchResult(hits=hits)


async def _locked_policy_hits(actor, base: dict) -> list[SearchHit]:
    """Matching policies this person may NOT read, as request-access rows.

    Runs only for a scoped caller, and only over the SAME `$or` the visible
    search used — so it can never surface a policy the search itself would not
    have matched by code or number. Customer-name matching is deliberately not
    part of it: confirming a policy number somebody is holding a document for is
    a different disclosure from letting them enumerate the agency's client list
    one guess at a time.
    """
    if policy_scope.sees_everything(actor):
        return []
    scope = await policy_scope.visible_filter(actor)
    matches = await Policy.find(base).limit(6).to_list()
    if not matches:
        return []
    visible: set[str] = set()
    if scope is not None:
        rows = await Policy.find({"$and": [
            {"_id": {"$in": [p.id for p in matches]}}, scope]}).to_list()
        visible = {str(p.id) for p in rows}

    hidden = [p for p in matches if str(p.id) not in visible]
    if not hidden:
        return []
    # One shared resolver with the restricted-search endpoint, so the two
    # screens name the same person as the holder of the same policy.
    from app.routers.policy_access import _holder_names

    holders = await _holder_names(hidden)
    # The link carries BOTH the search term and the policy id.
    #
    # `request` alone is not enough: the Policies page only renders the
    # restricted panel once a search is in the box, so a link without `q` would
    # land somebody on their own list with nothing to explain why they were sent
    # there. The term is the policy's own code, so the panel finds exactly the
    # row the hit was about.
    return [SearchHit(
        type="policy", id=str(p.id), label=p.code,
        sub=(f"Held by {holders[str(p.id)]}" if holders.get(str(p.id))
             else "Not on your desk"),
        link=f"/policies?q={p.code}&request={p.id}", locked=True)
        for p in hidden]
