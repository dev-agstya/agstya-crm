"""User account model — covers Owner, Employee and Channel Partner accounts."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

import pymongo
from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.core.enums import AccountStatus, AccountType
from app.models.base import utcnow


class BankDetails(BaseModel):
    """Payout / salary bank details."""

    account_holder: Optional[str] = None
    account_number: Optional[str] = None
    ifsc: Optional[str] = None
    bank_name: Optional[str] = None
    upi_id: Optional[str] = None


class ChannelPartnerProfile(BaseModel):
    """Extra fields relevant only to Channel Partner accounts."""

    # Personal (captured during onboarding).
    dob: Optional[date] = None
    gender: Optional[str] = None
    address: Optional[str] = None
    # Regulatory / KYC for a partner in India.
    pan: Optional[str] = None
    aadhaar_last4: Optional[str] = None       # never store full aadhaar in clear
    irdai_license_no: Optional[str] = None    # partner license (optional)
    license_expiry: Optional[datetime] = None
    # Default reward share this partner earns when not overridden per policy.
    # Basis + value interpreted like reward terms (percent*100 or paise).
    default_partner_basis: Optional[str] = None   # 'percent' | 'flat'
    default_partner_value: Optional[int] = None    # percent*100 or paise
    bank: Optional[BankDetails] = None


class EmergencyContact(BaseModel):
    name: Optional[str] = None
    relationship: Optional[str] = None
    phone: Optional[str] = None


class EmployeeProfile(BaseModel):
    """HR / onboarding fields for Employee accounts.

    The Workplace HR module (attendance, leave, holidays) shipped on 2026-08-20
    and reads three things from here: `date_of_joining`, the optional shift
    override and the optional leave-accrual override.
    """

    dob: Optional[date] = None
    gender: Optional[str] = None
    address: Optional[str] = None
    designation: Optional[str] = None
    department: Optional[str] = None
    # LOAD-BEARING since 2026-08-20. Leave accrues from this date and attendance
    # never counts a day before it as an absence — somebody who joined on the
    # 18th did not fail to come in on the 4th. It existed on the model from the
    # beginning and no form ever collected it; the Add-employee wizard and the
    # profile editor both ask for it now.
    date_of_joining: Optional[date] = None
    employment_type: Optional[str] = None      # full_time | part_time | contract

    # --- Salary ---
    #
    # STORED, AND READ BY NOTHING (owner 2026-08-20). Payslips were designed and
    # dropped in the same conversation: "we will store the salary on the
    # employee's profile, but it is calculated manually at the end". So this is
    # a reference figure on the record, gated on `view_salary` like house profit
    # is gated on `view_agency_profit` — stripped server-side, not merely
    # hidden — and no code multiplies it by anything.
    #
    # Replaced `salary_ctc` (an ANNUAL figure, in paise), which the owner never
    # asked for and which no editor in the entire app ever wrote, so no live
    # account carried a value: there was nothing to migrate. Monthly, because
    # monthly is the number an Indian agency actually says out loud.
    monthly_salary_paise: Optional[int] = None

    # --- Attendance overrides (both optional; blank = the agency default) ---
    #
    # For the genuine exception — the one part-timer who starts at 11 — without
    # making thirty people carry a copy of "the office opens at 10" (owner B8).
    shift_start: Optional[str] = None          # "HH:MM", IST
    shift_end: Optional[str] = None            # "HH:MM", IST
    # Days credited per month. Blank uses SystemSettings.hr.monthly_leave_accrual
    # (1.5); set it for the senior person on a different arrangement (owner E1).
    monthly_leave_accrual: Optional[float] = None

    pan: Optional[str] = None
    aadhaar_last4: Optional[str] = None
    emergency_contact: Optional[EmergencyContact] = None
    bank: Optional[BankDetails] = None


class User(Document):
    # --- Identity ---
    # Unique across all accounts. Employees/Owner get an auto USR-xxxxx code;
    # partners are assigned a short custom code (checked for availability) so it
    # matches the agency's existing partner codes (e.g. "PB", "NEELAM").
    code: Indexed(str, unique=True)
    full_name: str
    # Plain indexed string (not EmailStr) so soft-deleted accounts can hold a
    # non-routable tombstone address. Validated as EmailStr at the schema layer.
    email: Indexed(str, unique=True)
    mobile: Optional[str] = None
    account_type: AccountType

    # --- Auth ---
    hashed_password: str
    must_change_password: bool = True           # forced on first login
    token_version: int = 0                       # bump invalidates issued tokens
    last_login_at: Optional[datetime] = None
    pending_email: Optional[str] = None          # awaiting OTP confirmation
    # First-login onboarding: employees/partners complete a KYC + password wizard
    # before reaching the app. Owner accounts are onboarded by definition.
    onboarded: bool = True
    # Emailed temp password is only valid for a limited window (7 days).
    temp_password_expires_at: Optional[datetime] = None

    # --- Brute-force protection ---
    failed_login_count: int = 0
    lockout_until: Optional[datetime] = None

    # --- Account state ---
    status: AccountStatus = AccountStatus.ACTIVE
    status_reason: Optional[str] = None
    suspended_until: Optional[datetime] = None

    # --- Soft delete ---
    is_deleted: bool = False
    deleted_at: Optional[datetime] = None
    former_email: Optional[str] = None

    # --- RBAC ---
    # For employees: the custom Role assigned. Owner/Channel Partner leave this None.
    role_id: Optional[str] = None
    role_name: Optional[str] = None              # denormalised label for display
    # Per-user fine-tuning granted on top of the role (employees only).
    extra_permissions: list[str] = Field(default_factory=list)
    # Effective, denormalised permission set used for request-time checks.
    permissions: list[str] = Field(default_factory=list)
    # Which permission VOCABULARY the two lists above are written in.
    #
    # Needed because the 2026-08-07 split kept some flag names and narrowed their
    # meaning: `view_policies` used to open Leads, Customers, Policies, Renewals,
    # Quotes, Claims and the whole catalog, and now opens Policies. So a stored
    # set cannot be translated by looking at it — the reader has to know which
    # vocabulary wrote it. 1 = pre-split, 2 = one pair per page.
    #
    # Defaults to 1 so every document already in Mongo (which has no such field)
    # is correctly treated as legacy. New accounts are stamped with the current
    # version at creation. See core/permissions.LEGACY_FLAG_MAP.
    permissions_version: int = 1

    # --- Org hierarchy ---
    #
    # ONE hierarchy, deliberately (owner 2026-08-05). There used to be three —
    # this, a named `Team` with its own membership list, and `reports_to_id`
    # (employee -> senior employee) which nothing in the app ever read. A
    # partner's team was itself INHERITED from their relationship manager, so
    # the Team object was a copy of a fact already stored here, and copies
    # drift. Team and reports_to are gone; this is the structure.
    #
    # Channel Partner: the employee who manages them. MANDATORY — a partner
    # nobody owns is a partner nobody calls, so `create_partner` refuses
    # without one and an employee holding partners cannot be deactivated until
    # they are reassigned.
    relationship_manager_id: Optional[str] = None

    # --- Partner portal ---
    # Per-partner switch (owner A1.5): partners exist as records by default and
    # only the ones you deliberately let in can sign in. Ignored for owner and
    # employee accounts, who always have access.
    portal_access: bool = False

    # --- Role-specific profiles ---
    partner_profile: Optional[ChannelPartnerProfile] = None
    employee_profile: Optional[EmployeeProfile] = None

    # --- Provenance ---
    created_by: Optional[str] = None            # user id of creator
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)

    class Settings:
        name = "users"
        indexes = [
            [("account_type", pymongo.ASCENDING)],
            [("role_id", pymongo.ASCENDING)],
            [("relationship_manager_id", pymongo.ASCENDING)],
            [("status", pymongo.ASCENDING)],
            [("is_deleted", pymongo.ASCENDING)],
        ]

    @property
    def is_active(self) -> bool:
        return self.status == AccountStatus.ACTIVE

    @property
    def is_owner(self) -> bool:
        return self.account_type == AccountType.OWNER

    @property
    def is_partner(self) -> bool:
        return self.account_type == AccountType.CHANNEL_PARTNER

    @property
    def is_employee(self) -> bool:
        return self.account_type == AccountType.EMPLOYEE

    def has(self, permission: str) -> bool:
        return permission in self.permissions
