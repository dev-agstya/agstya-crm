"""Account management: create/edit/soft-delete employees and partners."""

from __future__ import annotations

import logging

from datetime import datetime, timedelta
from typing import Optional

from beanie import PydanticObjectId
from pydantic import BaseModel
from fastapi import (
    APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status,
)

from app.config import settings
from app.core.dependencies import (
    get_active_user, get_inhouse_user, require_any_permission,
    require_permission,
)
from app.core.enums import (
    AccountStatus, AccountType, AuditAction, OtpPurpose, PartyType,
)
from app.core.permissions import (
    can,
    can_any,
    effective_permissions,
    ASSIGNABLE_PERMISSIONS,
    MANAGE_POLICIES,
    MANAGE_ROLES_PERMISSIONS,
    MANAGE_EMPLOYEES,
    MANAGE_PARTNERS,
    PEOPLE_MANAGE_ANY,
    PEOPLE_VIEW_ANY,
    VIEW_SALARY,
    VIEW_SENSITIVE_PII,
    VIEW_EMPLOYEES,
    VIEW_PARTNERS,
)
from app.core.security import generate_temp_password, hash_password
from app.models.base import utcnow
from app.models.document import DocumentRecord
from app.models.user import User
from app.schemas.common import Message, Page
from app.schemas.document import DocumentOut, DownloadUrlResponse
from app.schemas.user import (
    AssignableColleague,
    AssignableManager,
    AssignablePartner,
    ChannelPartnerCreate,
    DeleteConfirm,
    EmployeeCreate,
    PermissionsUpdate,
    ResetPasswordResult,
    StatusUpdate,
    UserOut,
    UserUpdate,
)
from app.services import email as email_svc
from app.services import notifications
from app.services import policy_scope
from app.services import references
from app.services import reminder_svc
from app.services import s3
from app.services.audit import describe_changes, diff_dict_async, log_action
from app.services.codes import next_code
from app.services.otp import OtpResult, issue_otp, verify_otp
from app.services.permissions_svc import recompute_permissions

logger = logging.getLogger(__name__)
from app.routers._helpers import search_regex

# Staff-only. The guard is attached to the WHOLE router, not per
# endpoint, so a new route added here is closed to channel partners by
# default — see core/dependencies.get_inhouse_user.
router = APIRouter(prefix="/api/users", tags=["users"],
                   dependencies=[Depends(get_inhouse_user)])


# --- Helpers --------------------------------------------------------------------


# How long an emailed temporary password stays usable.
#
# Staff get a week — they are on site, they were told the invite was coming, and
# a credential sitting in a mailbox for a month is a liability.
#
# A CHANNEL PARTNER gets no expiry at all (owner 2026-08-04, A4): they are
# external, they are onboarded by a phone call rather than by a calendar, and
# an invitation that quietly dies is the agency's problem to notice, not theirs.
# It lasts until their FIRST login, which is not much of a window in practice —
# `must_change_password` forces them straight into onboarding, where they set
# their own password and this one stops working.
_STAFF_TEMP_PASSWORD_DAYS = 7


def _temp_password_expiry(account_type: AccountType) -> Optional[datetime]:
    """When an emailed temporary password stops working. None = never."""
    if account_type == AccountType.CHANNEL_PARTNER:
        return None
    return utcnow() + timedelta(days=_STAFF_TEMP_PASSWORD_DAYS)


def _ensure_invitable(target: User) -> None:
    """Refuse to email sign-in credentials to someone who cannot sign in.

    A channel partner whose access was revoked has nowhere to sign in. Staff
    are never blocked here — they always have an account to come back to.
    """
    if target.account_type != AccountType.CHANNEL_PARTNER:
        return
    if not target.portal_access:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "This channel partner has no portal access. Switch on Portal "
            "access first, then send them an invitation.")


def _temp_password_validity_note(account_type: AccountType) -> str:
    """The sentence a staff member reads back after sending an invitation."""
    if account_type == AccountType.CHANNEL_PARTNER:
        return ("The temporary password stays valid until they sign in for the "
                "first time.")
    return (f"The temporary password is valid for "
            f"{_STAFF_TEMP_PASSWORD_DAYS} days.")


def _can_manage(actor: User, account_type: AccountType) -> bool:
    """Staff and partners are separate grants (2026-08-07 split).

    This function was already the one place that branched on WHICH population a
    target belongs to, so it is where `manage_team` divides. Every write path
    reaches it through _load_managed, which means the route-level guard can stay
    the loose "may manage somebody" check and the precise one happens against
    the actual target."""
    if account_type == AccountType.EMPLOYEE:
        return can(actor, MANAGE_EMPLOYEES)
    if account_type == AccountType.CHANNEL_PARTNER:
        return can(actor, MANAGE_PARTNERS)
    return False  # owners are never managed here


async def _email_taken(email: str, exclude_id: str | None = None) -> bool:
    existing = await User.find_one(
        User.email == email.lower(), {"is_deleted": {"$ne": True}})
    return existing is not None and str(existing.id) != (exclude_id or "")


def _is_my_partner(actor: User, target: User) -> bool:
    """Is `target` a channel partner on `actor`'s own roster?

    The one exception to `view_team` on the People surface (owner G1,
    2026-08-06). A relationship manager has to be able to open the partners they
    manage — set their targets, ring them about a renewal — and `view_team` is
    the right to read the STAFF DIRECTORY, which is a different thing entirely.

    This is NOT a return of record-level scoping (deleted on purpose, see
    CLAUDE.md). It widens who may read a roster; it narrows nothing. Everyone
    who could open this record before still can.
    """
    manager_id = target.relationship_manager_id or ""
    # An UNASSIGNED partner belongs to nobody, and that has to be true by
    # construction rather than by luck: without this clause an actor whose id
    # stringified to "" would match every orphan on file.
    if not manager_id:
        return False
    return (target.account_type == AccountType.CHANNEL_PARTNER
            and manager_id == str(actor.id))


async def _load_target(actor: User, user_id: str) -> User:
    """Load an account the actor is allowed to LOOK at.

    `view_team`, or one of your own channel partners (see `_is_my_partner`).
    """
    try:
        target = await User.get(PydanticObjectId(user_id))
    except Exception:  # noqa: BLE001
        target = None
    if target is None or getattr(target, "is_deleted", False):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found.")
    if target.account_type == AccountType.OWNER and actor.account_type \
            != AccountType.OWNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot view owner accounts.")
    needed = (VIEW_PARTNERS
              if target.account_type == AccountType.CHANNEL_PARTNER
              else VIEW_EMPLOYEES)
    if not can(actor, needed) and not _is_my_partner(actor, target):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot view accounts.")
    return target


def _assert_not_higher_privileged(actor: User, target: User) -> None:
    """Refuse to ACT on someone who can do more than the actor can.

    manage_team was, in effect, "impersonate anyone": it can set a password,
    email a fresh one, or move the login email to an address the actor controls.
    None of those went through _check_no_elevation, which only guards permission
    GRANTS — so an HR account could take over the finance manager and read the
    agency's profit through their session, a right HR was never given.

    The rule: you may only manage someone whose permissions are a SUBSET of your
    own. Taking over such an account gains the actor nothing they did not
    already hold. The owner is exempt (they hold everything anyway).
    """
    if actor.account_type == AccountType.OWNER:
        return
    if str(target.id) == str(actor.id):
        return                              # managing yourself is always fine
    beyond = set(target.permissions) - set(actor.permissions)
    if beyond:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "This account holds permissions you don't have yourself, so you "
            "can't manage it. Ask an owner.")


async def _load_managed(actor: User, user_id: str) -> User:
    """Load an account the actor is allowed to CHANGE (manage_team + not more
    privileged than the actor)."""
    target = await _load_target(actor, user_id)
    # An owner may still manage another owner (they are peers); _load_target has
    # already refused any non-owner who aimed at one.
    if target.account_type != AccountType.OWNER \
            and not _can_manage(actor, target.account_type):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot manage this account.")
    _assert_not_higher_privileged(actor, target)
    return target


def _validate_perms(perms: list[str]) -> None:
    unknown = [p for p in perms if p not in ASSIGNABLE_PERMISSIONS]
    if unknown:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown permissions: {', '.join(unknown)}")




def _check_no_elevation(actor: User, perms: list[str]) -> None:
    """A non-owner may not grant permissions they don't hold themselves."""
    if actor.account_type == AccountType.OWNER:
        return
    held = set(effective_permissions(actor))
    elevated = [p for p in perms if p not in held]
    if elevated:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You cannot grant permissions you don't have yourself.")


# --- Create employee ------------------------------------------------------------


@router.post("/employees", response_model=UserOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_EMPLOYEES))])
async def create_employee(payload: EmployeeCreate, request: Request,
                          background: BackgroundTasks,
                          actor: User = Depends(get_active_user)) -> UserOut:
    if await _email_taken(payload.email):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "An account with this email already exists.")
    _validate_perms(payload.extra_permissions)
    _check_no_elevation(actor, payload.extra_permissions)

    temp_password = generate_temp_password()
    user = User(
        code=await next_code("user"),
        full_name=payload.full_name,
        email=payload.email.lower(),
        mobile=payload.mobile,
        account_type=AccountType.EMPLOYEE,
        hashed_password=hash_password(temp_password),
        must_change_password=True,
        onboarded=False,
        temp_password_expires_at=_temp_password_expiry(AccountType.EMPLOYEE),
        status=AccountStatus.ACTIVE,
        role_id=None,
        extra_permissions=payload.extra_permissions,
        employee_profile=payload.employee_profile,
        created_by=str(actor.id),
    )
    await user.insert()
    await recompute_permissions(user)

    # Send the welcome email in the background so the request returns fast.
    background.add_task(_send_welcome, user.email, user.full_name,
                        user.account_type.value, temp_password)
    await log_action(
        AuditAction.ACCOUNT_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(user.id), entity_code=user.code,
        request=request,
        summary=f"Created employee {user.code} ({user.email})",
    )
    return UserOut.from_model(user, in_use=False)


# --- Create partner --------------------------------------------------------------


@router.post("/partners", response_model=UserOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(require_permission(MANAGE_PARTNERS))])
async def create_partner(payload: ChannelPartnerCreate, request: Request,
                        background: BackgroundTasks,
                        actor: User = Depends(get_active_user)) -> UserOut:
    if await _email_taken(payload.email):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "An account with this email already exists.")
    manager_id = (payload.relationship_manager_id or "").strip()
    if not manager_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "A relationship manager must be assigned.")
    # The SAME check reassignment applies (see update_user). A partner created
    # under a deactivated account is born orphaned, and from 2026-08-24 it is
    # worse than that: their policies land on a set of screens nobody can open.
    if manager_id not in await policy_scope.assignable_manager_ids():
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A channel partner can only be assigned to an active employee.")

    temp_password = generate_temp_password()
    user = User(
        code=await next_code("partner"),
        full_name=payload.full_name,
        email=payload.email.lower(),
        mobile=payload.mobile,
        account_type=AccountType.CHANNEL_PARTNER,
        hashed_password=hash_password(temp_password),
        must_change_password=True,
        onboarded=False,
        temp_password_expires_at=_temp_password_expiry(
            AccountType.CHANNEL_PARTNER),
        status=AccountStatus.ACTIVE,
        relationship_manager_id=payload.relationship_manager_id or None,
        # Portal access is granted on creation, ALWAYS (owner 2026-08-04, A1a).
        # It used to default off and the invitation was skipped with it, which
        # meant every partner was created mute: no password, no email, and a
        # second trip to their detail page before they could sign in. The
        # request payload no longer has a say — `portal_access` remains a real
        # per-partner switch, but it is switched off from the partner's page
        # afterwards, not left off at birth.
        portal_access=True,
        partner_profile=payload.partner_profile,
        created_by=str(actor.id),
    )
    await user.insert()
    await recompute_permissions(user)

    # Every new partner is invited, in the same breath as the account. The
    # temporary password exists nowhere else — skipping the email loses it, and
    # the partner would have to be reset before they could ever sign in.
    background.add_task(_send_welcome, user.email, user.full_name,
                        user.account_type.value, temp_password)
    await log_action(
        AuditAction.ACCOUNT_CREATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(user.id), entity_code=user.code,
        request=request,
        summary=f"Created partner {user.code} ({user.email}) "
                "with portal access; invitation emailed",
    )
    return UserOut.from_model(user, in_use=False)


async def _send_welcome(email: str, full_name: str, role: str,
                        temp_password: str) -> None:
    login_url = f"{settings.frontend_base_url}/login"
    await email_svc.send_account_created_email(
        email, full_name, role, temp_password, login_url)


async def _resolve_manager_names(users: list[User]) -> dict[str, str]:
    """Relationship-manager id -> name, for a page of accounts.

    The People list is a list endpoint, so it bulk-resolves display names into a
    map; the single-record path resolves its own. Both go through UserOut, which
    is the shared serialiser — resolving at one call site and not the other is
    exactly how a list and the record one click away start disagreeing.
    """
    ids = {u.relationship_manager_id for u in users if u.relationship_manager_id}
    if not ids:
        return {}
    oids = []
    for i in ids:
        try:
            oids.append(PydanticObjectId(i))
        except Exception:  # noqa: BLE001 — a stale id resolves to no name
            continue
    return {str(m.id): m.full_name
            async for m in User.find({"_id": {"$in": oids}})}


async def partners_under(manager_id: str) -> int:
    """How many live channel partners this employee still holds.

    An employee cannot be deactivated while this is non-zero (owner T5.2): an
    orphaned partner is a partner nobody calls, and the relationship manager is
    a mandatory field precisely so that cannot happen.
    """
    return await User.find({
        "relationship_manager_id": manager_id,
        "account_type": AccountType.CHANNEL_PARTNER.value,
        "is_deleted": {"$ne": True},
    }).count()


async def _partner_owed(partner_id: str) -> int:
    """Paise the AGENCY owes this channel partner right now (0 if none).

    `finance_balance.partner_net_balance` is the one definition — the same
    function behind the Balance Sheet, the partner's own statement, the roster
    and the portal wallet. Recomputing it here from the wallet alone would give
    a different answer from the screen the partner is looking at, which is the
    worst bug this app can have.
    """
    from app.models.finance import PartyAccount
    from app.models.wallet import Wallet
    from app.services.finance_balance import partner_net_balance

    wallet = await Wallet.find_one(Wallet.partner_id == partner_id)
    account = await PartyAccount.find_one(
        PartyAccount.party_type == PartyType.CHANNEL_PARTNER.value,
        PartyAccount.party_id == partner_id)
    reward_owed = (wallet.available_paise + wallet.pending_paise) if wallet else 0
    net = partner_net_balance(reward_owed,
                              account.balance_paise if account else 0)
    # Positive = we owe them. Negative means THEY owe US, which is not a reason
    # to keep an account switched on.
    return max(0, net)


# --- List / get -----------------------------------------------------------------


@router.get("", response_model=Page[UserOut])
async def list_users(
    actor: User = Depends(get_active_user),
    account_type: AccountType | None = Query(default=None),
    q: str | None = Query(default=None),
    status_filter: AccountStatus | None = Query(default=None, alias="status"),
    inactive: bool = Query(default=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> Page[UserOut]:
    # Reading the People lists needs view_team; acting on a row needs
    # manage_team (checked per-endpoint below).
    #
    # ONE exception (owner G1, 2026-08-06): an employee with no view_team may
    # list CHANNEL PARTNERS, and sees only their own roster. The Channel
    # Partners page is where a relationship manager works — it was behind
    # view_team, which is the staff-directory right, so an ordinary employee
    # could not open the page their own partners live on.
    #
    # The scope is applied to the QUERY, so typing a URL cannot widen it. It is
    # a roster filter, not a return of record-level scoping: every in-house user
    # can still open every customer, policy and lead.
    allowed = [AccountType.EMPLOYEE.value, AccountType.CHANNEL_PARTNER.value]
    wants_partners = account_type == AccountType.CHANNEL_PARTNER
    can_see_everyone = can(actor, VIEW_PARTNERS if wants_partners
                           else VIEW_EMPLOYEES)
    own_roster_only = False
    if not can_see_everyone:
        if not wants_partners:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "You cannot view accounts.")
        own_roster_only = True

    if account_type:
        if account_type.value not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "You cannot list this account type.")
        type_filter = [account_type.value]
    else:
        type_filter = allowed

    # Two mutually exclusive views (owner 2026-07-26). The default list is
    # accounts that WORK; `inactive=true` is everyone switched off, whether they
    # were deactivated or removed back when removal was the normal action. The
    # old param listed only removed accounts, which made the page's "Show
    # deactivated" switch skip the people it names.
    switched_off = {"$or": [{"is_deleted": True},
                            {"status": {"$ne": AccountStatus.ACTIVE.value}}]}
    working = {"$and": [{"is_deleted": {"$ne": True}},
                        {"status": AccountStatus.ACTIVE.value}]}
    filters: list[dict] = [
        switched_off if inactive else working,
        {"account_type": {"$in": type_filter}},
    ]
    if own_roster_only:
        filters.append({"relationship_manager_id": str(actor.id)})
    if status_filter:
        filters.append({"status": status_filter.value})
    if q:
        rx = search_regex(q)
        filters.append({"$or": [
            {"full_name": rx}, {"email": rx}, {"code": rx},
        ]})
    query = {"$and": filters}

    total = await User.find(query).count()
    users = (await User.find(query).sort("-created_at")
             .skip((page - 1) * page_size).limit(page_size).to_list())
    mask = not can(actor, VIEW_SENSITIVE_PII)
    # Salary has its OWN flag, decided independently of the PII mask
    # (2026-08-20). Riding it on view_sensitive_pii meant "may see identity
    # documents" and "may see what people are paid" were one decision, and they
    # are not the same kind of trust.
    hide_salary = not can(actor, VIEW_SALARY)
    # Who is named on any policy/lead/ledger row — the People page offers the
    # permanent-delete action only where it would actually be allowed.
    used = await references.users_in_use(str(u.id) for u in users)
    managers = await _resolve_manager_names(users)
    rosters = await _roster_sizes(users)
    return Page[UserOut](
        items=[UserOut.from_model(u, mask_pii=mask and str(u.id) != str(actor.id),
                                  hide_salary=(hide_salary
                                               and str(u.id) != str(actor.id)),
                                  in_use=str(u.id) in used,
                                  manager_name=managers.get(
                                      u.relationship_manager_id or ""),
                                  partners_under=rosters.get(str(u.id), 0))
               for u in users],
        total=total, page=page, page_size=page_size,
    )


async def _roster_sizes(users: list[User]) -> dict[str, int]:
    """{employee id: how many channel partners sit under them}.

    ONE grouped query for the whole page, not one per row — the employee
    directory is 15 rows and this must not become 15 round trips.

    It is what makes the Team tab findable. That tab has existed since
    2026-08-05 and the owner could not find it, because the directory gave no
    sign a team was behind any particular row. A count in the list is the
    difference between "click every employee and see" and "click Rahul".
    """
    ids = [str(u.id) for u in users
           if u.account_type in (AccountType.EMPLOYEE, AccountType.OWNER)]
    if not ids:
        return {}
    pipeline = [
        {"$match": {"account_type": AccountType.CHANNEL_PARTNER.value,
                    "is_deleted": {"$ne": True},
                    "relationship_manager_id": {"$in": ids}}},
        {"$group": {"_id": "$relationship_manager_id", "n": {"$sum": 1}}},
    ]
    out: dict[str, int] = {}
    async for row in User.get_motor_collection().aggregate(pipeline):
        if row["_id"]:
            out[str(row["_id"])] = int(row["n"])
    return out


# NOTE: must stay registered before GET /{user_id}.
@router.get("/email-available")
async def email_available(email: str = Query(min_length=3),
                          actor: User = Depends(get_active_user)) -> dict:
    """Live pre-check while typing a new account's email in the create forms."""
    if not can_any(actor, *PEOPLE_MANAGE_ANY):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot manage accounts.")
    return {"email": email.lower(),
            "available": not await _email_taken(email)}


# NOTE: must stay registered before GET /{user_id}.
@router.get("/assignable-managers", response_model=list[AssignableManager])
async def assignable_managers(
    actor: User = Depends(get_active_user),
) -> list[AssignableManager]:
    """Candidates for an employee's reports-to or a partner's relationship
    manager: every active employee plus the Owner. Anyone who can see the team
    may read this — the create/edit forms need it to populate their pickers."""
    if not can(actor, VIEW_EMPLOYEES):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot view accounts.")
    query = {"$and": [
        {"is_deleted": {"$ne": True}},
        {"status": AccountStatus.ACTIVE.value},
        {"account_type": {"$in": [AccountType.OWNER.value,
                                  AccountType.EMPLOYEE.value]}},
    ]}
    # The UI labels the Owner explicitly and defaults reports-to to it, so plain
    # name ordering here is fine.
    users = await User.find(query).sort("full_name").to_list()
    return [AssignableManager(id=str(u.id), full_name=u.full_name,
                              account_type=u.account_type.value)
            for u in users]


# NOTE: must stay registered before GET /{user_id}.
@router.get("/attributable-partners", response_model=list[AssignablePartner])
async def attributable_partners(
    actor: User = Depends(get_active_user),
) -> list[AssignablePartner]:
    """Active channel partners a staff member can attribute a policy to. Available
    to anyone who can book policies (not just partner managers); channel partners
    themselves don't attribute (they book for themselves)."""
    if actor.account_type == AccountType.CHANNEL_PARTNER:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not available.")
    if not can(actor, MANAGE_POLICIES):
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "You cannot book policies.")
    query = {"$and": [
        {"is_deleted": {"$ne": True}},
        {"status": AccountStatus.ACTIVE.value},
        {"account_type": AccountType.CHANNEL_PARTNER.value},
    ]}
    users = await User.find(query).sort("full_name").to_list()
    return [AssignablePartner(id=str(u.id), full_name=u.full_name, code=u.code)
            for u in users]


# NOTE: must stay registered before GET /{user_id}.
class ReassignPreview(BaseModel):
    """What moving this partner is about to change, before it is done.

    Shown in the confirmation dialog. Reassignment moves an entire book of
    business between two people's screens in one edit, and "12 policies move to
    Rahul" is a sentence somebody can sanity-check where a toast saying "Saved"
    is not.
    """

    partner_id: str
    partner_name: str
    policy_count: int = 0
    from_manager: Optional[str] = None
    to_manager: Optional[str] = None


@router.get("/{user_id}/reassign-preview", response_model=ReassignPreview,
            dependencies=[Depends(require_permission(MANAGE_PARTNERS))])
async def reassign_preview(
    user_id: str,
    manager_id: Optional[str] = Query(default=None),
    actor: User = Depends(get_active_user),
) -> ReassignPreview:
    """Dry run. Reads only — nothing here writes, and the caller may abandon it."""
    target = await _load_managed(actor, user_id)
    if target.account_type != AccountType.CHANNEL_PARTNER:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Only a channel partner has a relationship manager.")
    return ReassignPreview(**await policy_scope.roster_move_summary(
        target, manager_id))


@router.get("/with-permission", response_model=list[AssignableColleague])
async def colleagues_with_permission(
    actor: User = Depends(get_active_user),
    permission: str = Query(..., min_length=3),
) -> list[AssignableColleague]:
    """Active in-house colleagues who hold `permission`.

    For "who can I give this to" pickers — assigning a lead reminder to someone
    without `view_policies` would put a task on a page they cannot open (owner
    Q4.2). Deliberately NOT the People list: that needs `view_team`, and an
    executive who can work the pipeline but not read the staff directory still
    has to be able to name a colleague on a follow-up.

    Returns names and emails only, and only to someone who holds the same
    permission — you can see who else does the job you do, and nothing more.
    """
    if permission not in ASSIGNABLE_PERMISSIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown permission.")
    if not can(actor, permission):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You cannot list colleagues for a permission you do not hold.")

    query = {"$and": [
        {"is_deleted": {"$ne": True}},
        {"status": AccountStatus.ACTIVE.value},
        {"$or": [
            # An owner holds every flag by definition. Matching on account type
            # as well as the stored list means an owner whose denormalised
            # permissions have not been healed yet still shows up.
            {"account_type": AccountType.OWNER.value},
            {"$and": [{"account_type": AccountType.EMPLOYEE.value},
                      {"permissions": permission}]},
        ]},
    ]}
    users = await User.find(query).sort("full_name").to_list()
    return [AssignableColleague(id=str(u.id), full_name=u.full_name,
                                email=u.email,
                                account_type=u.account_type.value)
            for u in users]


@router.get("/{user_id}", response_model=UserOut)
async def get_user(user_id: str,
                   actor: User = Depends(get_active_user)) -> UserOut:
    # Reading one row needs the same right as reading the list (view_team).
    # This used to demand manage_team, so a view-only account saw the People
    # list and got a 403 the moment it opened a row.
    target = await _load_target(actor, user_id)
    mask = (not can(actor, VIEW_SENSITIVE_PII)
            and str(target.id) != str(actor.id))
    # Everybody may see their OWN salary — it is on their own record and they
    # already know it. `view_salary` is about other people's, like every other
    # flag in this app.
    hide_salary = (not can(actor, VIEW_SALARY)
                   and str(target.id) != str(actor.id))
    # Resolve the manager's name HERE too. A list endpoint bulk-resolves display
    # names into a map and the single-record path has to do its own — the two
    # drifting apart is a bug this repo has already shipped once (see the
    # policy detail serialiser note in CLAUDE.md).
    managers = await _resolve_manager_names([target])
    return UserOut.from_model(
        target, mask_pii=mask, hide_salary=hide_salary,
        manager_name=managers.get(target.relationship_manager_id or ""),
        in_use=references.in_use(await references.user_refs(user_id)))


# --- Edit -----------------------------------------------------------------------


def _user_audit_snapshot(u: User) -> dict:
    """Flat snapshot of a user's auditable fields (incl. nested bank/profile) so
    edits can be diffed old -> new."""
    ep = u.employee_profile
    bp = u.partner_profile
    bank = (bp.bank if bp and bp.bank else
            ep.bank if ep and ep.bank else None)
    return {
        "full_name": u.full_name, "email": u.email, "mobile": u.mobile,
        "relationship_manager_id": u.relationship_manager_id,
        "designation": ep.designation if ep else None,
        "pan": (bp.pan if bp else ep.pan if ep else None),
        "bank_account": bank.account_number if bank else None,
        "ifsc": bank.ifsc if bank else None,
        "bank_name": bank.bank_name if bank else None,
        "upi_id": bank.upi_id if bank else None,
    }


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(user_id: str, payload: UserUpdate, request: Request,
                      actor: User = Depends(get_active_user)) -> UserOut:
    target = await _load_managed(actor, user_id)
    before = _user_audit_snapshot(target)
    password_reset = False

    if payload.full_name is not None:
        target.full_name = payload.full_name

    if payload.email is not None and payload.email.lower() != target.email:
        if await _email_taken(payload.email, exclude_id=str(target.id)):
            raise HTTPException(status.HTTP_409_CONFLICT,
                                "That email is already in use.")
        target.email = payload.email.lower()
        target.token_version += 1

    if payload.mobile is not None:
        target.mobile = payload.mobile

    if payload.new_password:
        # Setting a password is a reset. FORCE a change on next login so an
        # admin-chosen password can never become a silent backdoor into
        # someone's account (Q-A3).
        if not _can_manage(actor, target.account_type):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "You need the manage permission for this account to set a "
                "password. "
                "Use the reset-password action to email the user a temporary one.")
        target.hashed_password = hash_password(payload.new_password)
        target.must_change_password = True
        target.temp_password_expires_at = _temp_password_expiry(
            target.account_type)
        target.token_version += 1
        target.failed_login_count = 0
        target.lockout_until = None
        password_reset = True

    # --- Reassignment: one field, an entire book of business ---
    #
    # Moving a channel partner to another employee moves EVERY POLICY that
    # partner ever booked onto the new manager's screens, and off the old one's,
    # in the same instant. That is the owner's requirement (2026-08-24) and it
    # works because visibility is DERIVED from this field on every read rather
    # than copied onto policies — see services/policy_scope.
    #
    # Nothing about the policies is rewritten. `Policy.manager_id` stays frozen
    # at booking, so the old manager keeps CREDIT for what they brought in while
    # they held this partner; only who may READ the records changes. Two
    # questions, two answers, and they are meant to diverge.
    reassigned_from = None
    if payload.relationship_manager_id is not None:
        new_manager = (payload.relationship_manager_id or "").strip() or None
        if new_manager and new_manager != target.relationship_manager_id:
            # An inactive manager is an orphaned partner with extra steps: the
            # records move onto an account nobody can sign into, and nothing on
            # any screen says so. Refused with the reason.
            if new_manager not in await policy_scope.assignable_manager_ids():
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "A channel partner can only be assigned to an active "
                    "employee. Reactivate that account first, or pick "
                    "somebody else.")
        if (target.account_type == AccountType.CHANNEL_PARTNER
                and new_manager != target.relationship_manager_id):
            reassigned_from = target.relationship_manager_id
        target.relationship_manager_id = new_manager
    if payload.portal_access is not None:
        if target.account_type != AccountType.CHANNEL_PARTNER:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Portal access only applies to channel partners; staff always "
                "have access.")
        target.portal_access = payload.portal_access
        if not payload.portal_access:
            # Revoking access must end the session NOW, not whenever their
            # token happens to expire.
            target.token_version += 1
    if payload.employee_profile is not None:
        target.employee_profile = payload.employee_profile
    if payload.partner_profile is not None:
        target.partner_profile = payload.partner_profile

    target.updated_at = utcnow()
    await target.save()

    changes = await diff_dict_async(before, _user_audit_snapshot(target))
    kind = ("Channel Partner" if target.account_type.value == "channel_partner"
            else target.account_type.value.title())
    clause = describe_changes(changes) if changes else ""
    if password_reset:
        clause = f"{clause}; password reset" if clause else "password reset"
    summary = (f"Updated {kind} {target.full_name} ({target.code})"
               + (f": {clause}" if clause else ""))
    await log_action(
        AuditAction.ACCOUNT_UPDATED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(target.id), entity_code=target.code,
        request=request, summary=summary,
        meta={"changes": changes, "password_reset": password_reset},
    )
    if reassigned_from is not None or (
            reassigned_from is None and payload.relationship_manager_id
            and target.account_type == AccountType.CHANNEL_PARTNER
            and "relationship_manager_id" in changes):
        await _record_reassignment(target, reassigned_from, actor, request)
    return UserOut.from_model(target)


async def _record_reassignment(partner: User, from_manager_id,
                               actor: User, request: Request) -> None:
    """Audit and announce a partner moving between relationship managers.

    ITS OWN AUDIT ACTION rather than a line inside ACCOUNT_UPDATED's field diff,
    because this is not a field edit in any sense that matters: it moves a book
    of business between two people's screens, and burying "12 policies changed
    hands" inside a diff of `relationship_manager_id` is how it becomes
    impossible to answer "when did this move?" six months later.

    BOTH MANAGERS ARE TOLD. The new one, because they have just inherited work
    they know nothing about; the old one, because a set of policies disappearing
    from their list with no explanation reads as data loss. Notifications are
    best-effort by construction (services/notifications swallows its own
    errors), so neither can stop the reassignment that has already happened.
    """
    from app.models.policy import Policy

    partner_id = str(partner.id)
    count = await Policy.find({"partner_id": partner_id}).count()
    to_id = partner.relationship_manager_id
    names: dict[str, str] = {}
    for raw in (from_manager_id, to_id):
        if not raw or raw in names:
            continue
        try:
            u = await User.get(PydanticObjectId(raw))
        except Exception:  # noqa: BLE001 — a dangling id on an old record
            continue
        if u is not None:
            names[raw] = u.full_name

    moved = (f"{count} polic{'y' if count == 1 else 'ies'}")
    await log_action(
        AuditAction.PARTNER_REASSIGNED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=partner_id, entity_code=partner.code,
        request=request,
        summary=f"Moved {partner.full_name} from "
                f"{names.get(from_manager_id or '', 'nobody')} to "
                f"{names.get(to_id or '', 'nobody')} ({moved} move with them)",
        meta={"from_manager_id": from_manager_id or "",
              "to_manager_id": to_id or "",
              "policy_count": str(count)})

    if to_id:
        await notifications.create_notification(
            to_id, f"{partner.full_name} is now yours",
            body=f"{moved} from this channel partner are now on your "
                 f"Policies list.",
            category="team", link=f"/people/partners/{partner_id}")
    if from_manager_id and from_manager_id != to_id:
        await notifications.create_notification(
            from_manager_id, f"{partner.full_name} was reassigned",
            body=f"{names.get(to_id or '', 'Someone else')} now handles them. "
                 f"{moved} have moved off your Policies list. You keep the "
                 f"credit for what they booked while they were yours.",
            category="team", link="/people/partners")


@router.patch("/{user_id}/permissions", response_model=UserOut,
              dependencies=[Depends(require_permission(MANAGE_ROLES_PERMISSIONS))])
async def update_permissions(user_id: str, payload: PermissionsUpdate,
                             request: Request,
                             actor: User = Depends(get_active_user)) -> UserOut:
    target = await _load_managed(actor, user_id)
    if target.account_type != AccountType.EMPLOYEE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Only employee permissions can be managed.")
    _validate_perms(payload.extra_permissions)
    _check_no_elevation(actor, payload.extra_permissions)
    target.extra_permissions = payload.extra_permissions
    target.token_version += 1
    target.updated_at = utcnow()
    await target.save()
    await recompute_permissions(target)
    await log_action(
        AuditAction.PERMISSIONS_CHANGED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(target.id), entity_code=target.code,
        request=request, summary=f"Changed permissions for {target.code}",
    )
    return UserOut.from_model(target)


@router.patch("/{user_id}/status", response_model=UserOut)
async def update_status(user_id: str, payload: StatusUpdate, request: Request,
                        actor: User = Depends(get_active_user)) -> UserOut:
    target = await _load_managed(actor, user_id)
    if str(target.id) == str(actor.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "You cannot change your own account status.")

    # An employee who still holds channel partners cannot be switched off —
    # their partners would be left with nobody to call, and the relationship
    # manager is a mandatory field precisely so that cannot happen (owner T5.2).
    if payload.status != AccountStatus.ACTIVE             and target.account_type != AccountType.CHANNEL_PARTNER:
        held = await partners_under(str(target.id))
        if held:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"{target.full_name} is the relationship manager for {held} "
                f"channel partner{'s' if held != 1 else ''}. Reassign them to "
                "another employee first, then deactivate this account.")

    # A channel partner switched off with reward still owed loses their portal
    # at the same moment — so the money the agency owes them stops being visible
    # to the one person it matters most to, and there is no screen left that
    # tells them it exists. Not a hard block (deactivating someone you are in
    # DISPUTE with is a real and common reason to do this); a
    # confirm-what-you-are-doing, refused once with the figure in the message.
    if (payload.status != AccountStatus.ACTIVE
            and target.account_type == AccountType.CHANNEL_PARTNER
            and not payload.acknowledge_balance):
        owed = await _partner_owed(str(target.id))
        if owed > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"The agency still owes {target.full_name} "
                f"Rs {owed / 100:,.2f}. Deactivating removes their portal "
                f"access, so they lose sight of it. Pay it out first, or "
                f"confirm to deactivate anyway.")

    previous = target.status
    target.status = payload.status
    target.status_reason = payload.reason
    if payload.status == AccountStatus.SUSPENDED:
        target.suspended_until = utcnow() + timedelta(
            hours=settings.deactivation_cooldown_hours)
        action = AuditAction.ACCOUNT_DEACTIVATED
    elif payload.status == AccountStatus.INACTIVE:
        target.suspended_until = None
        action = AuditAction.ACCOUNT_DEACTIVATED
    else:
        target.suspended_until = None
        action = AuditAction.ACCOUNT_REACTIVATED
    if payload.status != AccountStatus.ACTIVE:
        target.token_version += 1
    target.updated_at = utcnow()
    await target.save()

    # Their open follow-ups. A reminder is SHARED, and nothing removed a
    # switched-off account from `assignee_ids` — so one whose only assignee had
    # just been deactivated stopped appearing in every bell and every digest.
    # The task was not dropped, it was invisibly dropped. Never fatal: an
    # account that could not be switched off because a reminder would not move
    # is a worse outcome than a reminder that has to be found by hand.
    if payload.status != AccountStatus.ACTIVE:
        try:
            await reminder_svc.hand_over_on_deactivation(
                str(target.id), to_user=actor)
        except Exception:  # noqa: BLE001
            logger.exception("Could not hand over reminders held by %s",
                             target.id)
    await log_action(
        action, actor_id=str(actor.id), actor_name=actor.full_name,
        actor_role=actor.account_type.value, entity_type="user",
        entity_id=str(target.id), entity_code=target.code, request=request,
        summary=f"Status {previous.value} -> {payload.status.value} "
                f"for {target.code}",
        meta={"reason": payload.reason},
    )
    return UserOut.from_model(target)


@router.post("/{user_id}/resend-invite", response_model=ResetPasswordResult,
             dependencies=[Depends(require_any_permission(*PEOPLE_MANAGE_ANY))])
async def resend_invite(user_id: str, request: Request,
                        background: BackgroundTasks,
                        actor: User = Depends(get_active_user)
                        ) -> ResetPasswordResult:
    """Re-send the portal invitation with a fresh temporary password.

    Every new partner is already invited when the account is created, so this is
    the "it never arrived / they lost it" button — and the only way to get a
    partner a working password once they have set their own.
    """
    target = await _load_managed(actor, user_id)
    _ensure_invitable(target)

    temp_password = generate_temp_password()
    target.hashed_password = hash_password(temp_password)
    target.must_change_password = True
    target.temp_password_expires_at = _temp_password_expiry(
        target.account_type)
    target.token_version += 1        # any old invite link/session is dead
    target.failed_login_count = 0
    target.lockout_until = None
    target.updated_at = utcnow()
    await target.save()

    background.add_task(_send_welcome, target.email, target.full_name,
                        target.account_type.value, temp_password)
    await log_action(
        AuditAction.PASSWORD_RESET, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(target.id), entity_code=target.code,
        request=request, summary=f"Resent portal invitation to {target.code}")
    return ResetPasswordResult(
        detail=f"Invitation sent to {target.email}. "
               + _temp_password_validity_note(target.account_type))


@router.post("/{user_id}/reset-password", response_model=ResetPasswordResult,
             dependencies=[Depends(require_any_permission(*PEOPLE_MANAGE_ANY))])
async def admin_reset_password(user_id: str, request: Request,
                               background: BackgroundTasks,
                               actor: User = Depends(get_active_user)
                               ) -> ResetPasswordResult:
    target = await _load_managed(actor, user_id)
    # A partner with nowhere to sign in would only be confused by a password
    # email. Same rule as resend-invite, same sentence.
    _ensure_invitable(target)

    temp_password = generate_temp_password()
    target.hashed_password = hash_password(temp_password)
    target.must_change_password = True
    target.temp_password_expires_at = _temp_password_expiry(
        target.account_type)
    target.token_version += 1
    target.failed_login_count = 0
    target.lockout_until = None
    target.updated_at = utcnow()
    await target.save()

    background.add_task(_send_welcome, target.email, target.full_name,
                        target.account_type.value, temp_password)
    await log_action(
        AuditAction.PASSWORD_RESET, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(target.id), entity_code=target.code,
        request=request, summary=f"Admin reset password for {target.code}",
    )
    # The temp password is NOT returned. It used to come back in the response
    # body, which meant anyone with manage_team could read the credentials of
    # any account they reset instead of merely resetting it. It goes to the
    # account holder's inbox and nowhere else.
    return ResetPasswordResult(
        detail=f"Temporary password emailed to {target.email}. "
               + _temp_password_validity_note(target.account_type))


# --- KYC documents (staff review) -----------------------------------------------


@router.get("/{user_id}/documents", response_model=list[DocumentOut])
async def list_user_documents(user_id: str,
                              actor: User = Depends(get_active_user)
                              ) -> list[DocumentOut]:
    """List a user's uploaded KYC documents (PAN / Aadhaar, etc.)."""
    target = await _load_target(actor, user_id)
    docs = await DocumentRecord.find(
        DocumentRecord.entity_type == "user",
        DocumentRecord.entity_id == str(target.id),
    ).sort("-created_at").to_list()
    return [DocumentOut.from_model(d) for d in docs]


@router.get("/{user_id}/documents/{document_id}/download",
            response_model=DownloadUrlResponse)
async def download_user_document(user_id: str, document_id: str, request: Request,
                                 actor: User = Depends(get_active_user)
                                 ) -> DownloadUrlResponse:
    target = await _load_target(actor, user_id)
    # These files ARE the sensitive PII — a PAN card scan, an Aadhaar image, a
    # cancelled cheque. Masking those fields in the JSON while letting anyone
    # with manage_team download the originals protected nothing.
    if not can(actor, VIEW_SENSITIVE_PII) \
            and str(target.id) != str(actor.id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You need the view-sensitive-details permission to open someone "
            "else's identity documents.")
    try:
        doc = await DocumentRecord.get(PydanticObjectId(document_id))
    except Exception:  # noqa: BLE001
        doc = None
    if doc is None or doc.entity_type != "user" \
            or doc.entity_id != str(target.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    url = s3.presigned_download(doc.s3_key, doc.filename)
    await log_action(
        AuditAction.DOCUMENT_DOWNLOADED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(target.id), entity_code=target.code,
        request=request, summary=f"Downloaded {doc.label} of {target.code}",
    )
    return DownloadUrlResponse(url=url,
                               expires_in=settings.s3_presign_expire_seconds)


# --- Soft delete (OTP-verified) -------------------------------------------------


async def _assert_deletable(actor: User, user_id: str) -> User:
    """Load the target and refuse unless deleting it is actually allowed.

    The LINKS decide, not who is asking (owner 2026-07-26): an account with
    nothing against it can be deleted, while one that appears on any policy,
    lead, ledger row or wallet entry can only be DEACTIVATED, because reports
    and the audit trail read those links. Checked here rather than at the delete
    route alone, so a confirmation code is never emailed for an action that is
    going to be refused anyway.
    """
    target = await _load_managed(actor, user_id)
    if str(target.id) == str(actor.id):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "You cannot delete your own account.")
    refs = await references.user_refs(user_id)
    if references.in_use(refs):
        noun = ("channel partner"
                if target.account_type == AccountType.CHANNEL_PARTNER
                else "employee")
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            references.blocked_message(
                noun, refs,
                alternative="Deactivate the account instead"))
    return target


@router.post("/{user_id}/request-delete-otp", response_model=Message)
async def request_delete_otp(user_id: str, background: BackgroundTasks,
                             actor: User = Depends(get_active_user)) -> Message:
    """Email a one-time code to the acting admin to confirm a deletion."""
    target = await _assert_deletable(actor, user_id)
    code = await issue_otp(str(actor.id), OtpPurpose.ACCOUNT_DELETE)
    background.add_task(
        email_svc.send_delete_otp_email, actor.email, actor.full_name, code,
        settings.otp_expire_minutes, target.full_name, target.code)
    return Message(detail=f"A confirmation code was sent to {actor.email}.")


@router.delete("/{user_id}", response_model=Message)
async def delete_user(user_id: str, payload: DeleteConfirm, request: Request,
                      actor: User = Depends(get_active_user)) -> Message:
    """Remove an account that has nothing linked to it.

    Still a SOFT delete, deliberately: the point of removing an account rather
    than deactivating it is to RELEASE the login email (and a partner's code) so
    a future joiner can take them, and that is what this does. Everything else
    about the person is kept. Refused outright once anything points at them —
    see _assert_deletable.
    """
    target = await _assert_deletable(actor, user_id)

    result = await verify_otp(str(actor.id), OtpPurpose.ACCOUNT_DELETE,
                              payload.otp)
    if result != OtpResult.OK:
        messages = {
            OtpResult.INVALID: "Incorrect confirmation code.",
            OtpResult.EXPIRED: "Confirmation code expired. Request a new one.",
            OtpResult.TOO_MANY: "Too many attempts. Request a new code.",
            OtpResult.NOT_FOUND: "Request a confirmation code first.",
        }
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            messages.get(result, "Invalid confirmation code."))

    code = target.code
    original_email = target.email
    # Free the login email so it can be reused by a future account.
    target.former_email = original_email
    target.email = f"deleted+{target.id}@deleted.local"
    # Free the (manually-assigned) partner code so it can be reused later.
    if target.account_type == AccountType.CHANNEL_PARTNER:
        target.code = f"DEL-{target.id}"
    target.is_deleted = True
    target.deleted_at = utcnow()
    target.status = AccountStatus.INACTIVE
    target.token_version += 1
    target.updated_at = utcnow()
    await target.save()

    await log_action(
        AuditAction.ACCOUNT_DELETED, actor_id=str(actor.id),
        actor_name=actor.full_name, actor_role=actor.account_type.value,
        entity_type="user", entity_id=str(target.id), entity_code=code,
        request=request,
        summary=f"Soft-deleted account {code} ({original_email})",
    )
    return Message(detail="Account deleted. The email can be reused later.")
