"""Authentication endpoints: login, logout, token refresh, password reset."""

from __future__ import annotations

from datetime import timedelta

from beanie import PydanticObjectId
from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status,
)

from app.config import settings
from app.core.dependencies import (
    get_active_user,
    get_current_user,
    get_current_user_allow_pwchange,
)
from app.core.enums import (
    AccountStatus, AccountType, AuditAction, DocumentStatus, OtpPurpose,
)
from app.core.feature_flags import (
    PARTNER_PORTAL_BLOCKED_MESSAGE,
    partner_portal_blocked,
)
from app.core.permissions import effective_permissions
from app.core.rate_limit import (
    client_ip as _client_ip,
    forgot_rate_limit, login_rate_limit, refresh_rate_limit, reset_rate_limit,
)
from app.core.security import (
    REFRESH_TOKEN,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models.base import utcnow
from app.models.document import DocumentRecord
from app.models.user import (
    BankDetails, ChannelPartnerProfile, EmployeeProfile, User,
)
from app.routers._helpers import read_upload
from app.schemas.auth import (
    ChangePasswordRequest,
    EmailChangeWithPassword,
    ForgotPasswordRequest,
    LoginRequest,
    MeResponse,
    OnboardingRequest,
    ProfileUpdate,
    RefreshRequest,
    ResetPasswordRequest,
    TokenResponse,
)
from app.schemas.common import Message
from app.schemas.document import DocumentOut, DownloadUrlResponse
from app.services import captcha
from app.services import email as email_svc
from app.services import s3
from app.services import target_alerts
from app.services.audit import log_action
from app.services.otp import OtpResult, issue_otp, verify_otp

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Generic message so we never reveal whether an email exists.
_GENERIC_LOGIN_ERROR = "Invalid email or password."
# Shown when a channel partner's account is not allowed into the portal — the
# global switch is off, or this partner has not been given access.
_PARTNER_PORTAL_BLOCKED = PARTNER_PORTAL_BLOCKED_MESSAGE


async def _partner_blocked(user: User) -> bool:
    """Both portal gates, resolved against the cached settings document."""
    from app.services import settings_svc

    if user.account_type != AccountType.CHANNEL_PARTNER:
        return False
    return partner_portal_blocked(user, await settings_svc.get_settings())


def _me(user: User) -> MeResponse:
    return MeResponse(
        id=str(user.id),
        code=user.code,
        full_name=user.full_name,
        email=user.email,
        mobile=user.mobile,
        account_type=user.account_type.value,
        role_id=user.role_id,
        role_name=user.role_name,
        # Effective, not stored: an owner holds every flag even if their
        # document predates one (core/permissions.effective_permissions).
        permissions=effective_permissions(user),
        status=user.status.value,
        must_change_password=user.must_change_password,
        onboarded=getattr(user, "onboarded", True),
        last_login_at=user.last_login_at,
        relationship_manager_id=user.relationship_manager_id,
    )


def _tokens_for(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(
            str(user.id), user.account_type.value, user.token_version
        ),
        refresh_token=create_refresh_token(str(user.id), user.token_version),
        must_change_password=user.must_change_password,
    )


@router.post("/login", response_model=TokenResponse,
             dependencies=[Depends(login_rate_limit)])
async def login(payload: LoginRequest, request: Request) -> TokenResponse:
    ip = _client_ip(request)
    # After repeated failures from this IP, require a CAPTCHA (when configured).
    if captcha.required(ip) and not await captcha.verify(payload.captcha_token, ip):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Please complete the verification challenge and try again.")

    user = await User.find_one(User.email == payload.email.lower())

    if user is None:
        captcha.record_failure(ip)
        await log_action(
            AuditAction.LOGIN_FAILED, request=request,
            summary=f"Login attempt for unknown email {payload.email}",
            meta={"email": payload.email},
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _GENERIC_LOGIN_ERROR)

    # Temporary auto-lock after too many failures.
    if user.lockout_until and user.lockout_until > utcnow():
        await log_action(
            AuditAction.LOGIN_FAILED, actor_id=str(user.id),
            actor_name=user.full_name, actor_role=user.account_type.value,
            request=request, summary="Login blocked: account temporarily locked",
        )
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many failed attempts. Try again later or reset your password.",
        )

    # NOTE: the password is checked BEFORE any account-state branch below.
    # Answering "this account is inactive" to someone who never proved they own
    # the account turns the login form into a staff-directory lookup: it
    # confirms the address exists and says whether the person still works here.
    # Everything that identifies the account now sits behind a correct password.
    if not verify_password(payload.password, user.hashed_password):
        captcha.record_failure(ip)
        user.failed_login_count += 1
        alerted = False
        if user.failed_login_count >= settings.max_failed_logins:
            user.lockout_until = utcnow() + timedelta(
                minutes=settings.lockout_minutes)
            # Notify the account owner of suspicious activity. Use the same
            # trusted-proxy-aware IP as the rate limiter — reading the raw
            # header here would print whatever the attacker chose to send.
            await email_svc.send_login_alert_email(
                user.email, user.full_name, user.failed_login_count, ip,
                utcnow().strftime("%d %b %Y %H:%M UTC"),
            )
            alerted = True
        await user.save()
        await log_action(
            AuditAction.LOGIN_FAILED, actor_id=str(user.id),
            actor_name=user.full_name, actor_role=user.account_type.value,
            request=request,
            summary="Failed login (wrong password)",
            meta={"failed_count": user.failed_login_count, "alert_sent": alerted},
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, _GENERIC_LOGIN_ERROR)

    # --- Password is correct from here down; the caller owns this account. ---

    if user.status == AccountStatus.INACTIVE:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Account is inactive. Contact your administrator.")
    if user.status == AccountStatus.SUSPENDED:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "Account is temporarily suspended.")

    # Channel partners need both gates open: the owner's master switch and
    # their own per-partner access flag.
    if await _partner_blocked(user):
        await log_action(
            AuditAction.LOGIN_FAILED, actor_id=str(user.id),
            actor_name=user.full_name, actor_role=user.account_type.value,
            request=request,
            summary="Login blocked: partner portal access not granted",
        )
        raise HTTPException(status.HTTP_403_FORBIDDEN, _PARTNER_PORTAL_BLOCKED)

    # The emailed temp password is only valid for a limited window.
    if (user.must_change_password and user.temp_password_expires_at
            and user.temp_password_expires_at < utcnow()):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Your temporary password has expired. Ask your administrator to "
            "resend your invitation.")

    # Success — reset counters.
    captcha.reset(ip)
    user.failed_login_count = 0
    user.lockout_until = None
    user.last_login_at = utcnow()
    await user.save()
    await log_action(
        AuditAction.LOGIN_SUCCESS, actor_id=str(user.id),
        actor_name=user.full_name, actor_role=user.account_type.value,
        request=request, summary="Login successful",
    )
    return _tokens_for(user)


@router.post("/refresh", response_model=TokenResponse,
             dependencies=[Depends(refresh_rate_limit)])
async def refresh(payload: RefreshRequest) -> TokenResponse:
    data = decode_token(payload.refresh_token)
    if not data or data.get("type") != REFRESH_TOKEN:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token.")
    try:
        user = await User.get(PydanticObjectId(data["sub"]))
    except Exception:  # noqa: BLE001
        user = None
    if user is None or data.get("tv", 0) != user.token_version:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token.")
    if await _partner_blocked(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, _PARTNER_PORTAL_BLOCKED)
    if user.status != AccountStatus.ACTIVE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Account not active.")
    return _tokens_for(user)


@router.post("/logout", response_model=Message)
async def logout(request: Request,
                 user: User = Depends(get_current_user)) -> Message:
    """Sign out and REVOKE the tokens, not just forget them client-side.

    Logout used to write an audit row and return: the access and refresh tokens
    it claimed to revoke kept working until they expired (3 hours / 7 days), so
    "log out" on a shared or lost machine did nothing an attacker couldn't undo
    by reading localStorage. Bumping token_version invalidates them server-side
    immediately.

    Note this signs the user out of every device, which is the correct
    behaviour for the case that matters (a device you no longer trust) — there
    is no per-session token id to revoke selectively.
    """
    user.token_version += 1
    await user.save()
    await log_action(
        AuditAction.LOGOUT, actor_id=str(user.id), actor_name=user.full_name,
        actor_role=user.account_type.value, request=request, summary="Logout",
    )
    return Message(detail="Logged out.")


@router.post("/forgot-password", response_model=Message,
             dependencies=[Depends(forgot_rate_limit)])
async def forgot_password(payload: ForgotPasswordRequest,
                          request: Request) -> Message:
    generic = Message(
        detail="If an account exists for that email, a reset code has been sent."
    )
    user = await User.find_one(User.email == payload.email.lower())
    if user is None or user.status == AccountStatus.INACTIVE \
            or await _partner_blocked(user):
        return generic  # do not disclose existence

    code = await issue_otp(str(user.id), OtpPurpose.PASSWORD_RESET)
    channel = (payload.channel or "email").lower()
    delivered_wa = False
    if channel == "whatsapp":
        from app.services import settings_svc, whatsapp
        s = await settings_svc.get_settings()
        if s.whatsapp.enabled and user.mobile:
            res = await whatsapp.send_template(
                user.mobile, s.whatsapp.tpl_renewal_customer or "otp_code",
                language=s.whatsapp.default_lang,
                body_params=[code, str(settings.otp_expire_minutes)],
                operation="password_otp")
            delivered_wa = res.ok
    # Always also email the code (works even if the WhatsApp template isn't
    # approved yet), so the user is never locked out.
    if channel != "whatsapp" or not delivered_wa:
        await email_svc.send_otp_email(
            user.email, user.full_name, code, settings.otp_expire_minutes)
    await log_action(
        AuditAction.PASSWORD_RESET, actor_id=str(user.id),
        actor_name=user.full_name, actor_role=user.account_type.value, request=request,
        summary=f"Password reset code requested (via {channel})",
    )
    return generic


@router.post("/reset-password", response_model=Message,
             dependencies=[Depends(reset_rate_limit)])
async def reset_password(payload: ResetPasswordRequest,
                         request: Request) -> Message:
    # This endpoint had no limit of its own — only the coarse global one — while
    # it is the endpoint that actually GUESSES the code. The per-account budget
    # in services.otp is the real defence; this simply keeps the volume down.
    user = await User.find_one(User.email == payload.email.lower())
    # An inactive or suspended account cannot be reset back into life with a
    # code that was issued before it was switched off.
    if (user is None
            or await _partner_blocked(user)
            or user.status != AccountStatus.ACTIVE):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Invalid or expired reset code.")

    result = await verify_otp(str(user.id), OtpPurpose.PASSWORD_RESET, payload.otp)
    if result != OtpResult.OK:
        mapping = {
            OtpResult.EXPIRED: "This reset code has expired. Request a new one.",
            OtpResult.TOO_MANY: "Too many incorrect attempts. Request a new code.",
        }
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            mapping.get(result, "Invalid or expired reset code."),
        )

    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    user.token_version += 1        # invalidate existing sessions
    user.failed_login_count = 0
    user.lockout_until = None
    await user.save()
    await log_action(
        AuditAction.PASSWORD_CHANGED, actor_id=str(user.id),
        actor_name=user.full_name, actor_role=user.account_type.value, request=request,
        summary="Password reset via OTP",
    )
    return Message(detail="Password has been reset. You can now sign in.")


@router.post("/change-password", response_model=TokenResponse)
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    user: User = Depends(get_current_user_allow_pwchange),
) -> TokenResponse:
    """Used both for the forced first-login change and voluntary changes."""
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Current password is incorrect.")
    if verify_password(payload.new_password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "New password must be different from the current one.")

    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    user.token_version += 1
    await user.save()
    await log_action(
        AuditAction.PASSWORD_CHANGED, actor_id=str(user.id),
        actor_name=user.full_name, actor_role=user.account_type.value, request=request,
        summary="Password changed",
    )
    # Issue fresh tokens carrying the new token_version so the client stays logged in.
    return _tokens_for(user)


# --- User KYC documents (shared helper) -----------------------------------------


async def _store_user_document(
    user: User, doc_key: str, file: UploadFile, label: str | None = None,
) -> DocumentRecord:
    """Store a user's KYC document on S3 with replace-on-reupload semantics:
    a fresh upload for the same doc_key deletes the previous file + record."""
    data = await read_upload(file, 10 * 1024 * 1024, label="Document")

    # Replace any existing file in this slot.
    old_docs = await DocumentRecord.find(
        DocumentRecord.entity_type == "user",
        DocumentRecord.entity_id == str(user.id),
        DocumentRecord.doc_key == doc_key,
    ).to_list()
    for old in old_docs:
        s3.delete_object(old.s3_key)
        await old.delete()

    key = s3.build_key("user", str(user.id), file.filename or f"{doc_key}.bin")
    s3.get_s3_client().put_object(
        Bucket=settings.aws_bucket_name, Key=key, Body=data,
        ContentType=file.content_type or "application/octet-stream",
    )
    doc = DocumentRecord(
        entity_type="user",
        entity_id=str(user.id),
        doc_key=doc_key,
        label=(label.strip() if label and label.strip()
               else doc_key.replace("_", " ").title()),
        s3_key=key,
        filename=file.filename or doc_key,
        content_type=file.content_type,
        size_bytes=len(data),
        status=DocumentStatus.UPLOADED,
        uploaded_by=str(user.id),
    )
    await doc.insert()
    return doc


# --- First-login onboarding (employees & partners) -------------------------------


@router.post("/onboarding/document", response_model=Message)
async def upload_onboarding_document(
    doc_key: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user_allow_pwchange),
) -> Message:
    """Upload a KYC document (PAN / Aadhaar) during onboarding. Stored on S3 and
    recorded against the user so staff can review it later."""
    if user.account_type == AccountType.OWNER:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Owners do not require onboarding.")
    doc = await _store_user_document(user, doc_key, file)
    return Message(detail=f"{doc.label} uploaded.")


# --- Self-service KYC documents (post-onboarding: My Documents page) -------------


@router.get("/me/documents", response_model=list[DocumentOut])
async def list_my_documents(
    user: User = Depends(get_active_user),
) -> list[DocumentOut]:
    docs = await DocumentRecord.find(
        DocumentRecord.entity_type == "user",
        DocumentRecord.entity_id == str(user.id),
    ).sort("-created_at").to_list()
    return [DocumentOut.from_model(d) for d in docs]


@router.post("/me/documents", response_model=DocumentOut)
async def upload_my_document(
    doc_key: str = Form(...),
    file: UploadFile = File(...),
    label: str | None = Form(default=None),
    user: User = Depends(get_active_user),
) -> DocumentOut:
    """Upload / replace one of my own documents (KYC or a custom document).
    Available to every account, including owners, who use this as a personal
    document store."""
    doc = await _store_user_document(user, doc_key, file, label=label)
    return DocumentOut.from_model(doc)


@router.delete("/me/documents/{document_id}", response_model=Message)
async def delete_my_document(
    document_id: str,
    user: User = Depends(get_active_user),
) -> Message:
    """Delete one of my own documents (file on S3 + record)."""
    try:
        doc = await DocumentRecord.get(PydanticObjectId(document_id))
    except Exception:  # noqa: BLE001
        doc = None
    if doc is None or doc.entity_type != "user" \
            or doc.entity_id != str(user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    s3.delete_object(doc.s3_key)
    await doc.delete()
    return Message(detail="Document deleted.")


@router.get("/me/documents/{document_id}/download",
            response_model=DownloadUrlResponse)
async def download_my_document(
    document_id: str,
    user: User = Depends(get_active_user),
) -> DownloadUrlResponse:
    try:
        doc = await DocumentRecord.get(PydanticObjectId(document_id))
    except Exception:  # noqa: BLE001
        doc = None
    if doc is None or doc.entity_type != "user" \
            or doc.entity_id != str(user.id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    url = s3.presigned_download(doc.s3_key, doc.filename)
    return DownloadUrlResponse(url=url,
                               expires_in=settings.s3_presign_expire_seconds)


@router.post("/onboarding", response_model=TokenResponse)
async def complete_onboarding(
    payload: OnboardingRequest,
    request: Request,
    user: User = Depends(get_current_user_allow_pwchange),
) -> TokenResponse:
    """Save the onboarding KYC + bank details, set the user's own password, and
    mark the account onboarded. Returns fresh tokens (token_version bumps)."""
    if user.account_type == AccountType.OWNER:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Owners do not require onboarding.")

    # KYC is mandatory for STAFF and optional for a channel partner (owner I1,
    # 2026-08-06). The requirement lives here rather than on the schema because
    # it depends on WHO is onboarding, which the schema cannot see. A partner
    # who skips it keeps `pan`/`aadhaar_last4` empty and is chased by the team;
    # the fields are on their profile and on their KYC documents tab either way.
    if user.account_type != AccountType.CHANNEL_PARTNER:
        if not payload.pan_number:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Enter your PAN to finish setting up.")
        if not payload.aadhaar_number:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Enter your Aadhaar number to finish setting "
                                "up.")

    bank = BankDetails(
        account_holder=payload.bank.account_holder,
        account_number=payload.bank.account_number,
        ifsc=(payload.bank.ifsc or "").upper() or None,
        bank_name=payload.bank.bank_name,
        upi_id=payload.bank.upi_id,
    )
    aadhaar_last4 = (payload.aadhaar_number or "")[-4:] or None

    if user.account_type == AccountType.CHANNEL_PARTNER:
        prof = user.partner_profile or ChannelPartnerProfile()
        prof.dob = payload.dob
        prof.gender = payload.gender
        prof.address = payload.address
        # A skipped KYC field must not WIPE one staff already recorded on the
        # account — omitted means "not supplied now", not "clear it".
        prof.pan = payload.pan_number or prof.pan
        prof.aadhaar_last4 = aadhaar_last4 or prof.aadhaar_last4
        if payload.irdai_license_no:
            prof.irdai_license_no = payload.irdai_license_no
        prof.bank = bank
        user.partner_profile = prof
    else:
        prof = user.employee_profile or EmployeeProfile()
        prof.dob = payload.dob
        prof.gender = payload.gender
        prof.address = payload.address
        prof.pan = payload.pan_number
        prof.aadhaar_last4 = aadhaar_last4
        prof.bank = bank
        user.employee_profile = prof

    user.hashed_password = hash_password(payload.new_password)
    user.must_change_password = False
    user.onboarded = True
    user.token_version += 1
    user.updated_at = utcnow()
    await user.save()
    await log_action(
        AuditAction.PROFILE_UPDATED, actor_id=str(user.id),
        actor_name=user.full_name, actor_role=user.account_type.value,
        request=request, summary="Completed account onboarding",
    )
    # First thing they see in the bell: a real quick-start, not an empty
    # "you're all set" with no further details (owner, 2026-07-26).
    await target_alerts.notify_welcome(user)
    return _tokens_for(user)


@router.patch("/me", response_model=MeResponse)
async def update_profile(payload: ProfileUpdate, request: Request,
                         user: User = Depends(get_current_user)) -> MeResponse:
    """Update the logged-in user's own name / mobile (not email — needs OTP)."""
    changed: list[str] = []
    if payload.full_name is not None:
        user.full_name = payload.full_name
        changed.append("name")
    if payload.mobile is not None:
        user.mobile = payload.mobile
        changed.append("mobile")
    if changed:
        user.updated_at = utcnow()
        await user.save()
        await log_action(
            AuditAction.PROFILE_UPDATED, actor_id=str(user.id),
            actor_name=user.full_name, actor_role=user.account_type.value, request=request,
            summary="Updated own profile", meta={"fields": changed},
        )
    return _me(user)


@router.post("/change-email", response_model=Message)
async def change_email(payload: EmailChangeWithPassword, request: Request,
                       user: User = Depends(get_current_user)) -> Message:
    """Change email after confirming the account password. On success the session
    is invalidated (token_version bump) so the user is logged out and must sign
    in again with the new email."""
    new_email = payload.new_email.lower()
    if new_email == user.email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "That is already your email address.")
    if not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password is incorrect.")
    clash = await User.find_one(User.email == new_email,
                                {"is_deleted": {"$ne": True}})
    if clash is not None and str(clash.id) != str(user.id):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "That email is already in use.")
    old_email = user.email
    user.email = new_email
    user.pending_email = None
    user.token_version += 1        # invalidate current session -> forces re-login
    await user.save()
    await log_action(
        AuditAction.EMAIL_CHANGED, actor_id=str(user.id), actor_name=user.full_name,
        actor_role=user.account_type.value, request=request,
        summary=f"Email changed from {old_email} to {new_email}",
    )
    return Message(detail="Email updated. Please sign in again with your new email.")


@router.get("/me", response_model=MeResponse)
async def me(user: User = Depends(get_current_user)) -> MeResponse:
    return _me(user)
