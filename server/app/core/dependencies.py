"""FastAPI dependencies: authentication and RBAC guards."""

from __future__ import annotations

from typing import Callable

from beanie import PydanticObjectId
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.core.enums import AccountStatus, AccountType, is_inhouse
from app.core.feature_flags import (
    PARTNER_PORTAL_BLOCKED_MESSAGE,
    partner_portal_blocked,
)
from app.core.permissions import can, can_any
from app.core.security import ACCESS_TOKEN, decode_token
from app.models.user import User
from app.services.permissions_svc import heal_owner_permissions

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

_CREDENTIALS_EXC = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(token: str | None = Depends(oauth2_scheme)) -> User:
    if not token:
        raise _CREDENTIALS_EXC
    payload = decode_token(token)
    if not payload or payload.get("type") != ACCESS_TOKEN:
        raise _CREDENTIALS_EXC

    user_id = payload.get("sub")
    if not user_id:
        raise _CREDENTIALS_EXC

    try:
        user = await User.get(PydanticObjectId(user_id))
    except Exception:  # noqa: BLE001 - malformed id
        raise _CREDENTIALS_EXC
    if user is None:
        raise _CREDENTIALS_EXC

    # Token invalidation via version bump (password change / forced logout).
    if payload.get("tv", 0) != user.token_version:
        raise _CREDENTIALS_EXC

    if user.status == AccountStatus.INACTIVE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is inactive. Contact your administrator.",
        )
    if user.status == AccountStatus.SUSPENDED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is temporarily suspended. Contact your administrator.",
        )
    # A channel partner needs both gates open: the owner's global switch and
    # their own per-partner flag. Checked on EVERY request, not just at login,
    # so revoking access takes effect immediately rather than whenever their
    # token happens to expire.
    if user.account_type == AccountType.CHANNEL_PARTNER:
        from app.services import settings_svc

        if partner_portal_blocked(user, await settings_svc.get_settings()):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=PARTNER_PORTAL_BLOCKED_MESSAGE,
            )

    # An owner always holds every flag. The set is stored, not computed, so it
    # goes stale the moment a new flag is added to the model — heal it here,
    # once, rather than at ~50 scattered `X in actor.permissions` call sites.
    await heal_owner_permissions(user)
    return user


async def get_current_user_allow_pwchange(
    user: User = Depends(get_current_user),
) -> User:
    """An authenticated user, WITHOUT the must-change-password / onboarded gates.

    Deliberately identical to get_current_user — the name documents intent at
    the call site. Use it only on the endpoints a half-set-up account has to be
    able to reach (change-password, the onboarding wizard); everything else
    takes get_active_user, which is the one that actually enforces those gates.
    """
    return user


async def get_active_user(user: User = Depends(get_current_user)) -> User:
    """Blocks access until the user has set their own password AND finished the
    first-login wizard.

    The `onboarded` check matters because /api/auth/change-password is reachable
    while must_change_password is set: changing the password there cleared the
    only flag being enforced, so a new employee could walk straight past the KYC
    and bank-details step and never come back to it. Owners are onboarded by
    definition and partners can't sign in at all, so this only gates employees.
    """
    if user.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password change required before continuing.",
        )
    if not getattr(user, "onboarded", True):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Please finish setting up your account before continuing.",
        )
    return user


async def get_inhouse_user(user: User = Depends(get_active_user)) -> User:
    """An active OWNER or EMPLOYEE. Channel partners are refused.

    THE SECURITY BOUNDARY OF THE PARTNER PORTAL.

    Roughly two hundred endpoints in this app were written when only staff could
    sign in, and they assume it: they return house profit, rate cards, other
    partners' balances, the whole customer book. Auditing each one for partner
    leakage — and remembering to audit every new one — is how a partner
    eventually sees a number they should not.

    So the rule is inverted: staff routers are closed to partners as a whole
    (this dependency is attached at the ROUTER level, not per endpoint), and
    partners reach only the explicitly partner-safe surface in routers/portal.py.
    A new staff endpoint is therefore safe by default, and a new partner-facing
    one has to be written deliberately.

    tests/test_partner_boundary.py fails if a staff router is added without it.
    """
    if not is_inhouse(user.account_type):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This section is for agency staff only.",
        )
    return user


def require_permission(*perms: str) -> Callable:
    """Dependency factory: user must hold ALL of the given permission flags.

    Reads through `permissions.can`, not `user.permissions` directly: an owner
    holds every flag by definition, and deriving that is safer than trusting the
    stored snapshot to have been healed. See the note on `can`.
    """

    async def _checker(user: User = Depends(get_active_user)) -> User:
        if not can(user, *perms):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to perform this action.",
            )
        return user

    return _checker


def require_any_permission(*perms: str) -> Callable:
    """Dependency factory: user must hold AT LEAST ONE of the given flags. Used
    where a broad umbrella permission (e.g. manage_finance) should still satisfy
    a newer, finer-grained one (e.g. delete_ledger)."""

    async def _checker(user: User = Depends(get_active_user)) -> User:
        if not can_any(user, *perms):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You don't have permission to perform this action.",
            )
        return user

    return _checker


def require_account_type(*types: AccountType) -> Callable:
    """Dependency factory: user's account type must be one of the given types."""
    allowed = {t.value if isinstance(t, AccountType) else t for t in types}

    async def _checker(user: User = Depends(get_active_user)) -> User:
        if user.account_type.value not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Your account type cannot perform this action.",
            )
        return user

    return _checker


# Backwards-compatible alias (audit router imports require_role).
require_role = require_account_type
