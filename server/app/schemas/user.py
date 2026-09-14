"""User management schemas (employees & partners)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.enums import AccountStatus
from app.core.permissions import effective_permissions
from app.models.user import ChannelPartnerProfile, EmployeeProfile


def _validate_mobile(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    digits = "".join(ch for ch in str(v) if ch.isdigit())
    if len(digits) != 10:
        raise ValueError("Mobile number must be exactly 10 digits.")
    return digits


class EmployeeCreate(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    mobile: str = Field(min_length=10, max_length=10)   # compulsory, 10 digits
    # The employee's permission set (assembled in the UI by picking roles and/or
    # ticking individual flags). Roles are not stored on the employee.
    extra_permissions: list[str] = Field(default_factory=list)
    employee_profile: Optional[EmployeeProfile] = None

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class ChannelPartnerCreate(BaseModel):
    # A channel partner is identified by name + an auto-generated account code
    # (CP-...). The old manually-entered "broker code" is gone — "broker code"
    # now means one of the agency's registered accounts on an insurer.
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    mobile: str = Field(min_length=10, max_length=10)
    # A channel partner must always be assigned to a relationship manager.
    relationship_manager_id: str = Field(min_length=1)
    partner_profile: Optional[ChannelPartnerProfile] = None
    # NOTE: there is deliberately no `portal_access` field here any more (owner
    # 2026-08-04, A1a). Creating a channel partner now ALWAYS grants portal
    # access and emails the invitation — the temporary password exists only in
    # that email, so "create quietly, invite later" was a partner who could
    # never sign in until someone reset them. The per-partner switch is still
    # real and still revocable; it is just no longer a decision made at the
    # moment of creation. It is edited from the partner's own page (UserUpdate).

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class UserUpdate(BaseModel):
    """Edit an existing user."""

    full_name: Optional[str] = Field(default=None, min_length=2, max_length=120)
    email: Optional[EmailStr] = None
    mobile: Optional[str] = Field(default=None, min_length=10, max_length=10)
    new_password: Optional[str] = Field(default=None, min_length=8, max_length=128)
    relationship_manager_id: Optional[str] = None      # partners only
    portal_access: Optional[bool] = None               # partners only
    employee_profile: Optional[EmployeeProfile] = None
    partner_profile: Optional[ChannelPartnerProfile] = None

    @field_validator("mobile")
    @classmethod
    def _mobile(cls, v):
        return _validate_mobile(v)


class PermissionsUpdate(BaseModel):
    # The employee's full permission set (the ticked flags). Roles are only a
    # bulk-apply helper in the UI, not stored on the user.
    extra_permissions: list[str]


class StatusUpdate(BaseModel):
    status: AccountStatus
    reason: Optional[str] = None
    # Deactivating a partner the agency still owes money is allowed — you may
    # well be switching someone off precisely BECAUSE you are in dispute — but
    # it must not happen by accident. The server refuses once and says what is
    # outstanding; the client re-sends with this set. See
    # `routers/users.update_status`.
    acknowledge_balance: bool = False


class CodeAvailability(BaseModel):
    code: str
    available: bool


class AssignableManager(BaseModel):
    """A candidate for reports-to (employees) / relationship-manager (partners):
    every active employee plus the Owner."""
    id: str
    full_name: str
    account_type: str


class AssignableColleague(BaseModel):
    """An in-house colleague who holds a given permission — the options in a
    "who can I give this to" picker. Name and email only: enough to tell two
    people with the same first name apart, and nothing else."""

    id: str
    full_name: str
    email: Optional[str] = None
    account_type: str


class AssignablePartner(BaseModel):
    """An active channel partner a staff member can attribute a policy to."""
    id: str
    full_name: str
    code: str


class DeleteConfirm(BaseModel):
    otp: str = Field(min_length=1)


class UserOut(BaseModel):
    id: str
    code: str
    full_name: str
    email: EmailStr
    mobile: Optional[str] = None
    account_type: str
    status: str
    role_id: Optional[str] = None
    role_name: Optional[str] = None
    permissions: list[str]
    extra_permissions: list[str] = Field(default_factory=list)
    must_change_password: bool
    onboarded: bool = True
    relationship_manager_id: Optional[str] = None
    # Denormalised for display: who this partner's relationship manager is.
    relationship_manager_name: Optional[str] = None
    # Partners only: whether this account can sign in to the portal at all.
    portal_access: bool = False
    partner_profile: Optional[ChannelPartnerProfile] = None
    employee_profile: Optional[EmployeeProfile] = None
    last_login_at: Optional[datetime] = None
    suspended_until: Optional[datetime] = None
    is_deleted: bool = False
    # True when this person is named on any policy, lead, ledger row, wallet
    # entry or finance snapshot. Such an account can only be DEACTIVATED — the
    # owner set the rule at "0 policies / transactions linked can be deleted,
    # else archive" (2026-07-26). Defaults to True so anything that forgets to
    # compute it errs towards the safe answer.
    in_use: bool = True
    # EMPLOYEES ONLY: how many channel partners sit under them right now.
    #
    # The Team tab on an employee's record has existed since 2026-08-05 and the
    # owner could not find it — because nothing on the directory said a team was
    # in there. Every row looked identical, so opening one to check was a
    # gamble, and you do not take that gamble twenty times. The count IS the
    # signpost. Not windowed: a roster is a fact about now, like the balance on
    # a partner's row.
    partners_under: int = 0
    created_at: datetime

    @classmethod
    def from_model(cls, u, *, mask_pii: bool = False,
                   hide_salary: bool = True,
                   in_use: bool = True,
                   manager_name: Optional[str] = None,
                   partners_under: int = 0) -> "UserOut":
        pp = _mask_profile(u.partner_profile) if mask_pii else u.partner_profile
        ep = _mask_profile(u.employee_profile) if mask_pii else u.employee_profile
        # Two INDEPENDENT gates on the same object (see _mask_profile).
        # `hide_salary` defaults to True so a call site that forgets it errs
        # towards not leaking — the opposite default would make every new
        # serialisation path a potential disclosure.
        if hide_salary:
            ep = _strip_salary(ep)
        return cls(
            relationship_manager_name=manager_name,
            id=str(u.id),
            in_use=in_use,
            partners_under=partners_under,
            code=u.code,
            full_name=u.full_name,
            email=u.email,
            mobile=u.mobile,
            account_type=u.account_type.value if hasattr(u.account_type, "value")
            else u.account_type,
            status=u.status.value if hasattr(u.status, "value") else u.status,
            role_id=u.role_id,
            role_name=u.role_name,
            permissions=effective_permissions(u),
            extra_permissions=u.extra_permissions,
            must_change_password=u.must_change_password,
            onboarded=getattr(u, "onboarded", True),
            portal_access=getattr(u, "portal_access", False),
            relationship_manager_id=u.relationship_manager_id,
            partner_profile=pp,
            employee_profile=ep,
            last_login_at=u.last_login_at,
            suspended_until=u.suspended_until,
            is_deleted=getattr(u, "is_deleted", False),
            created_at=u.created_at,
        )


_MASK = "••••"


def _mask_profile(prof):
    """A copy with PAN / Aadhaar / bank masked, for viewers without
    `view_sensitive_pii`.

    SALARY IS NO LONGER MASKED HERE. It used to be, which quietly meant the
    salary rode on `view_sensitive_pii` — the flag for unmasking identity
    documents. Those are different decisions about different kinds of trust: an
    accountant may well need somebody's PAN and have no business knowing what
    they are paid, and in a small office the reverse is just as common. Since
    2026-08-20 the salary has its own flag (`view_salary`) and its own stripper,
    `_strip_salary`, applied independently — see `UserOut.from_model`.
    """
    if prof is None:
        return None
    p = prof.model_copy(deep=True)
    for f in ("pan", "aadhaar_last4"):
        if getattr(p, f, None):
            setattr(p, f, _MASK)
    bank = getattr(p, "bank", None)
    if bank is not None:
        for f in ("account_number", "ifsc", "upi_id"):
            if getattr(bank, f, None):
                setattr(bank, f, _MASK)
    return p


def _strip_salary(prof):
    """Remove the monthly salary for viewers without `view_salary`.

    STRIPPED SERVER-SIDE, not hidden client-side — the same treatment
    `view_agency_profit` gets on house profit, and for the same reason: a figure
    that reaches the browser is a figure anybody can read out of devtools. In a
    small office this is the most sensitive field on a staff record.
    """
    if prof is None or getattr(prof, "monthly_salary_paise", None) is None:
        return prof
    p = prof.model_copy(deep=True)
    p.monthly_salary_paise = None
    return p


class ResetPasswordResult(BaseModel):
    detail: str
    # `temp_password` is deliberately NOT part of this response. The generated
    # password goes to the account holder by email only — handing it back to
    # whoever clicked Reset turned manage_team into "log in as them".
    # Kept as a field name in the docs on purpose: if it reappears, that's a bug.
