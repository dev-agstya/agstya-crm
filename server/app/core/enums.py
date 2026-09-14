"""Enumerations shared across models, schemas and business logic.

Account model (v2):
  - AccountType is the fixed, system-level kind of account (owner / employee /
    partner). It replaces the old hard-coded Role enum.
  - "Roles" are now editable data (see app.models.role.Role) that the Owner
    creates in-app and assigns to EMPLOYEE accounts. A role bundles permission
    flags and a data-visibility scope.
"""

from enum import Enum


class AccountType(str, Enum):
    """The fixed kind of an account. Drives fundamental behaviour."""

    OWNER = "owner"        # super admin, created only by create_owner.py
    EMPLOYEE = "employee"  # internal staff; capabilities come from a Role
    CHANNEL_PARTNER = "channel_partner"      # external agent; own records + a payout wallet


# Ordering used for coarse "is this account at least as powerful as" checks.
ACCOUNT_RANK: dict[str, int] = {
    AccountType.OWNER.value: 3,
    AccountType.EMPLOYEE.value: 2,
    AccountType.CHANNEL_PARTNER.value: 1,
}

# Account types that count as "in-house" (agency staff), vs external partners.
INHOUSE_ACCOUNTS = {AccountType.OWNER.value, AccountType.EMPLOYEE.value}


def is_inhouse(account_type) -> bool:
    value = account_type.value if isinstance(account_type, AccountType) \
        else account_type
    return value in INHOUSE_ACCOUNTS


class AccountStatus(str, Enum):
    ACTIVE = "active"
    # Temporary security cool-down (e.g. suspected compromise). Removable by a
    # manager/owner. Optionally auto-expires but never auto-removed by a job.
    SUSPENDED = "suspended"
    # Hard-disabled account.
    INACTIVE = "inactive"


class LeadType(str, Enum):
    """What kind of prospect a lead is (owner 2026-08-03).

    Three mutually exclusive values, deliberately. CUSTOMER and BUSINESS are
    both people who will buy a policy — one a person, one a company — and
    CHANNEL_PARTNER is someone who will bring business in instead. Splitting
    "will become" from "person or company" into two fields is more correct on
    paper but is two dropdowns and two filters; the owner chose the flat list.

    Replaces the old CustomerType (individual/business), which by then was used
    by nothing except this field.
    """

    CUSTOMER = "customer"
    CHANNEL_PARTNER = "channel_partner"
    BUSINESS = "business"


class LeadStage(str, Enum):
    NEW = "new"
    CONTACTED = "contacted"
    QUOTED = "quoted"
    CONVERTED = "converted"
    LOST = "lost"


class RecordOrigin(str, Enum):
    """Who created a lead/customer — drives visibility and edit rules.

    INHOUSE = created by owner/employee (shared across all in-house users).
    CHANNEL_PARTNER  = created by a partner (private to that partner; visible read-only to
              in-house users).
    """

    INHOUSE = "inhouse"
    CHANNEL_PARTNER = "channel_partner"


class QuoteStage(str, Enum):
    """Where a partner's quote request has got to.

    Every transition is timestamped onto the request's timeline and is visible
    to the partner — the old submission flow was a form that swallowed things,
    and being able to see it move is most of why this object exists.
    """

    SUBMITTED = "submitted"        # raised; nobody has touched it
    IN_REVIEW = "in_review"        # a named person picked it up
    INFO_NEEDED = "info_needed"    # we asked for something; ball with partner
    QUOTED = "quoted"              # an option is on the table
    ACCEPTED = "accepted"          # customer took it; we go and issue
    ISSUED = "issued"              # a real Policy exists and links back
    DECLINED = "declined"          # we cannot quote it, with a reason
    LOST = "lost"                  # quoted but not taken
    CANCELLED = "cancelled"        # the partner withdrew it (owner B5)


# Stages a partner may still cancel from — after this the agency has committed
# work or a policy exists.
QUOTE_CANCELLABLE = (QuoteStage.SUBMITTED, QuoteStage.IN_REVIEW,
                     QuoteStage.INFO_NEEDED, QuoteStage.QUOTED)
# Nothing more will happen on these.
QUOTE_CLOSED = (QuoteStage.ISSUED, QuoteStage.DECLINED, QuoteStage.LOST,
                QuoteStage.CANCELLED)


class ClaimStage(str, Enum):
    """The general Indian general-insurance claim path (owner C2).

    Same shape for motor, health and property; only the paperwork differs, and
    that is handled by the per-type document checklist.
    """

    INTIMATED = "intimated"            # reported to us
    REGISTERED = "registered"          # insurer has given a claim number
    DOCS_PENDING = "docs_pending"      # waiting on the claimant
    SURVEY = "survey"                  # surveyor appointed / assessment running
    APPROVED = "approved"              # insurer approved an amount
    SETTLED = "settled"                # paid (cashless or reimbursement)
    REJECTED = "rejected"              # insurer refused, with a reason
    CLOSED = "closed"                  # closed without settlement (withdrawn)


CLAIM_OPEN_STAGES = (ClaimStage.INTIMATED, ClaimStage.REGISTERED,
                     ClaimStage.DOCS_PENDING, ClaimStage.SURVEY,
                     ClaimStage.APPROVED)


class ClaimSettlementMode(str, Enum):
    CASHLESS = "cashless"              # insurer pays the garage / hospital
    REIMBURSEMENT = "reimbursement"    # customer pays, insurer refunds


class AnnouncementAudience(str, Enum):
    """Who a broadcast goes to. Deliberately no performance-based segments
    (owner D1) — the owner picks people, not a leaderboard."""

    ALL = "all"
    MANAGER = "manager"                # everyone under one relationship manager
    SELECTED = "selected"              # a hand-picked list
    NEW_PARTNERS = "new_partners"      # joined within N days


class AnnouncementCategory(str, Enum):
    OFFER = "offer"
    RATE_CHANGE = "rate_change"
    NOTICE = "notice"
    TRAINING = "training"


# =============================================================================
# Workplace HR — attendance, leave, holidays  (2026-08-20)
# =============================================================================
# NO MONEY LIVES HERE, deliberately (owner 2026-08-20). The module records what
# happened — who was in, for how long, who was off and why — and stops there.
# The salary sits on the employee's profile as a reference figure and is worked
# out by hand at month end from the summary these statuses add up to. Payslips
# were designed and dropped in the same conversation; nothing below computes a
# rupee, and nothing below should start.


class AttendanceStatus(str, Enum):
    """What one calendar day was, for one employee.

    The order of PRECEDENCE when several of these could apply to the same day is
    fixed in services/hr_attendance and is worth stating here because it decides
    every count on the month summary:

        HOLIDAY > WEEK_OFF > a manager's override > a punch > approved leave
        > ABSENT

    A punch beating approved leave is deliberate (owner C10): somebody who came
    in and worked was present, they get the day back on their balance, and
    punishing them for turning up is indefensible.
    """

    PRESENT = "present"          # cleared the full-day threshold
    HALF_DAY = "half_day"        # cleared half but not full
    ABSENT = "absent"            # a working day with nothing on it
    ON_LEAVE = "on_leave"        # approved leave, paid from the balance
    LEAVE_UNPAID = "leave_unpaid"  # approved leave beyond the balance
    WEEK_OFF = "week_off"        # Sunday, or whatever the settings say
    HOLIDAY = "holiday"          # declared on the Holidays page
    WFH = "wfh"                  # work from home / on duty — a full paid day
    # A working day that has not resolved yet: today before anyone clocked out,
    # and every day still in the future. NEVER counted as absent — "we have not
    # been told" and "they did not come" are different facts.
    NOT_MARKED = "not_marked"


# Statuses that count as a day worked for the payable-days figure.
ATTENDANCE_WORKED_STATUSES = {
    AttendanceStatus.PRESENT, AttendanceStatus.WFH,
}
# Non-working days. Never deductible, never absent, never counted against
# anybody — they are inside the monthly salary by definition (owner A4).
ATTENDANCE_OFF_STATUSES = {
    AttendanceStatus.WEEK_OFF, AttendanceStatus.HOLIDAY,
}


class AttendanceSource(str, Enum):
    """How a day's record came to exist. Shown on the day, so an edited day is
    never mistaken for one somebody actually punched."""

    PUNCH = "punch"              # the employee pressed the button
    MANUAL = "manual"            # a manager set it
    CORRECTION = "correction"    # an approved correction request
    SYSTEM = "system"            # the nightly job closed a forgotten punch-out


class WorkLocation(str, Enum):
    """WHERE a day was worked, decided from the clock-in's coordinates.

    A separate fact from `AttendanceStatus`, and deliberately so. Status answers
    "how much did they work" (hours), location answers "where from" (place). Two
    questions, two fields — merging them would mean a two-hour day worked at home
    had to choose between reading as a half day and reading as work-from-home,
    and it is both.

    UNKNOWN is a first-class answer, not a failure. A browser that refuses the
    location permission, a desktop with no GPS, or a reading too vague to place
    inside a 150m circle all produce "we were not told" — which is a different
    fact from "they were not at the office", and only one of them is the
    employee's doing.
    """

    OFFICE = "office"        # inside the geofence at clock-in
    REMOTE = "remote"        # outside it — work from home
    UNKNOWN = "unknown"      # no usable reading; never treated as a lie


class HrRequestStatus(str, Enum):
    """Shared by leave requests and attendance-correction requests — they are
    the same object socially (someone asks, someone decides) and giving them two
    near-identical enums is how the two queues start behaving differently."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    # Withdrawn by the person who raised it. Distinct from REJECTED, which is a
    # decision somebody else made and which they may want to explain.
    CANCELLED = "cancelled"


HR_REQUEST_OPEN = (HrRequestStatus.PENDING,)
HR_REQUEST_CLOSED = (HrRequestStatus.APPROVED, HrRequestStatus.REJECTED,
                     HrRequestStatus.CANCELLED)


class LeaveDayPart(str, Enum):
    """Half days are the reason people apply for leave at all (owner E8).

    Only meaningful on a SINGLE-day request; a range is always FULL days, and
    the schema refuses a half-day part on a multi-day range rather than quietly
    ignoring it.
    """

    FULL = "full"
    FIRST_HALF = "first_half"
    SECOND_HALF = "second_half"


class LeaveReason(str, Enum):
    """A LABEL, not a second balance (owner E7).

    There is exactly ONE pool of leave. This says why somebody was off so the
    pattern is visible on a roster; it does not split the accrual, it has no
    rules of its own, and adding a value here can never change what anything
    costs.
    """

    SICK = "sick"
    PERSONAL = "personal"
    TRAVEL = "travel"
    EMERGENCY = "emergency"
    OTHER = "other"


class LeaveLedgerEntry(str, Enum):
    """Why the leave balance moved. The balance is a SUM of these rows, never a
    stored number — the same append-only shape PartyAccount and BankAccount use,
    for the same reason: a cached total that anything can overwrite is a total
    nobody can argue with.
    """

    OPENING = "opening"          # what somebody carried in on day one
    ACCRUAL = "accrual"          # the monthly credit
    USAGE = "usage"              # spent on an approved leave
    REFUND = "refund"            # a cancelled leave, or a leave day worked
    ADJUSTMENT = "adjustment"    # a human decided, with a reason
    LAPSE = "lapse"              # cleared at the end of the leave year


class PolicyStatus(str, Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    RENEWAL_DUE = "renewal_due"
    RENEWED = "renewed"
    LAPSED = "lapsed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"




class RewardBasis(str, Enum):
    PERCENT = "percent"      # percentage of the commissionable premium
    FLAT = "flat"            # fixed INR (stored in paise)


class BuyerType(str, Enum):
    """Who the policy was sold to (drives whether reward is shared)."""

    DIRECT = "direct"                    # end customer directly (agency keeps all)
    CHANNEL_PARTNER = "channel_partner"  # via a partner (reward is shared)


class PayerType(str, Enum):
    """Who fronts the premium cash to the insurer for a policy."""

    AGENCY = "agency"                    # we pay the insurer, then collect
    CHANNEL_PARTNER = "channel_partner"  # the partner pays the insurer directly
    CUSTOMER = "customer"                # the customer pays the insurer directly


class SettlementStatus(str, Enum):
    """Premium-cash settlement state for a policy (derived from the ledger)."""

    PENDING = "pending"      # nothing collected yet
    PARTIAL = "partial"      # part collected; a receivable remains
    SETTLED = "settled"      # fully squared off


class PartyType(str, Enum):
    """A counterparty the agency has a running money position with."""

    CHANNEL_PARTNER = "channel_partner"
    CUSTOMER = "customer"
    BROKER = "broker"                     # a brokerage (premium payable + reward)
    # The agency itself — used for house expenses (salary, rent, …). Never carries
    # a receivable/payable position; excluded from every party-balance view.
    EXPENSE = "expense"


class LedgerTxnType(str, Enum):
    """A cash / obligation movement recorded on the finance ledger."""

    # Auto-booked when a policy is finalised: what the buyer owes the agency for
    # the premium (full premium if the agency fronted it, minus any discount; can
    # be negative when the buyer paid the insurer but is owed a discount back).
    PREMIUM_DUE = "premium_due"
    PREMIUM_TO_INSURER = "premium_to_insurer"    # agency paid the broker the premium
    # Auto-logged (informational) when a policy's premium is fronted by the agency:
    # a visible "Agency paid the premium" row on the broker so it shows in the
    # transactions list without manual entry. Balance-neutral — the premium is a
    # pass-through recovered from the buyer (tracked via PREMIUM_DUE), so it must
    # not move the broker's running balance.
    PREMIUM_PAID_BY_AGENCY = "premium_paid_by_agency"
    PREMIUM_COLLECTED = "premium_collected"      # cash received from customer/partner
    REWARD_RECEIVED = "reward_received"          # broker paid the agency its reward
    TDS_DEDUCTED = "tds_deducted"                # TDS the broker withheld on our reward
    PARTNER_PAYOUT = "partner_payout"            # agency paid the partner their share
    # Cash paid to a channel partner OVER their reward balance: booked as an
    # advance they owe back (+ve on their premium account, so their net balance
    # goes negative until recovered / eaten by future rewards).
    PARTNER_ADVANCE = "partner_advance"
    REFUND = "refund"                            # agency paid a customer/partner back
    DISCOUNT = "discount"                        # discount granted (house-borne)
    ADJUSTMENT = "adjustment"                    # manual correction / write-off
    # Informational (balance-neutral) row on a broker when a policy's reward is
    # marked NOT eligible, so the drop in that broker's pending-to-collect is
    # visible in the transactions list + statement. The commission is already
    # removed from expected via the zeroed PolicyFinance snapshot.
    REWARD_CANCELLED = "reward_cancelled"
    # A house expense (salary, rent, office, …). Party is the agency itself
    # (PartyType.EXPENSE); stored as a negative outflow and never touches a
    # party balance. Subtracted from net profit.
    EXPENSE = "expense"
    # Money moved between the agency's OWN accounts (bank -> cash, account A ->
    # account B). Booked as a PAIR of rows (one negative, one positive) against
    # the EXPENSE party sentinel, so it never touches a counterparty balance and
    # never reaches profit (services/finance_profit only counts EXPENSE rows).
    # Its bank effect is the row's own sign — see services/bank.cash_delta.
    TRANSFER = "transfer"


class BankAccountType(str, Enum):
    """A place the agency's own money sits.

    CREDIT_CARD is a LIABILITY, not cash: spending on it makes the balance more
    negative (what you owe), and paying the card is a TRANSFER from a bank
    account. It is therefore excluded from the "cash + bank in hand" total.
    """

    BANK = "bank"
    CASH = "cash"                 # cash in hand / petty cash
    UPI = "upi"                   # UPI or prepaid wallet float
    CREDIT_CARD = "credit_card"   # liability, see the note above


# Account kinds whose balance is money you HOLD. A credit card is money you OWE,
# so it is summed separately and never added into "cash in hand".
CASH_ASSET_ACCOUNT_TYPES = {
    BankAccountType.BANK, BankAccountType.CASH, BankAccountType.UPI,
}


class TargetMetric(str, Enum):
    POLICIES = "policies"          # count of policies booked
    PREMIUM = "premium"            # gross premium (paise)
    HOUSE_PROFIT = "house_profit"  # agency spread (paise)
    RENEWALS = "renewals"          # count of renewed policies


class TargetPeriod(str, Enum):
    MONTH = "month"
    QUARTER = "quarter"
    YEAR = "year"


class RewardStatus(str, Enum):
    PENDING = "pending"      # policy issued, payout not yet received from insurer
    RECEIVED = "received"    # agency received the reward from the insurer
    PAID_OUT = "paid_out"    # partner's share paid out (legacy; tracked in wallet)
    CANCELLED = "cancelled"  # policy cancelled — reward reversed
    # Per-policy reward outcomes driven from the Policies page. All of the below
    # (plus CANCELLED) reverse any partner wallet credit, so the partner is not
    # paid and the agency won't collect for that policy.
    REJECTED = "rejected"           # insurer refused our reward claim
    NOT_ELIGIBLE = "not_eligible"   # policy never earned a reward
    ZERO_PCT = "zero_pct"           # reward rate is 0% (amounts already zero)
    REFUNDED = "refunded"           # policy/premium refunded — reward reversed


# Reward outcomes that mean nothing is owed to the partner (reverse the wallet).
REWARD_REVERSAL_STATES = {
    RewardStatus.REJECTED, RewardStatus.NOT_ELIGIBLE, RewardStatus.ZERO_PCT,
    RewardStatus.REFUNDED, RewardStatus.CANCELLED,
}

# House-expense sub-categories under the single "Expenses" head. "other" is the
# catch-all. Kept as a simple constant list (no DB collection) — order = UI order.
EXPENSE_CATEGORIES = [
    "salary", "rent", "utilities", "marketing", "software", "travel",
    "office_supplies", "taxes_fees", "reward_payout", "other",
]
EXPENSE_CATEGORY_LABELS = {
    "salary": "Salary", "rent": "Rent", "utilities": "Utilities",
    "marketing": "Marketing", "software": "Software / Tools", "travel": "Travel",
    "office_supplies": "Office Supplies", "taxes_fees": "Taxes / Fees",
    "reward_payout": "Reward / Incentive", "other": "Other",
}


class WithdrawalStatus(str, Enum):
    REQUESTED = "requested"  # partner asked to withdraw; awaiting review
    APPROVED = "approved"    # approved, payout in progress
    PAID = "paid"            # money transferred (UTR recorded)
    REJECTED = "rejected"    # declined


class WalletTxnType(str, Enum):
    REWARD_CREDIT = "reward_credit"        # partner share credited from a policy
    REWARD_REVERSAL = "reward_reversal"    # credit reversed (policy cancelled)
    WITHDRAWAL_DEBIT = "withdrawal_debit"  # paid out via a withdrawal
    ADJUSTMENT = "adjustment"              # manual correction by the agency


class DocumentStatus(str, Enum):
    REQUESTED = "requested"  # asked from customer, not yet provided
    UPLOADED = "uploaded"
    VERIFIED = "verified"
    REJECTED = "rejected"


class OtpPurpose(str, Enum):
    PASSWORD_RESET = "password_reset"
    LOGIN_VERIFICATION = "login_verification"
    EMAIL_CHANGE = "email_change"
    ACCOUNT_DELETE = "account_delete"


class AuditAction(str, Enum):
    LOGIN_SUCCESS = "login_success"
    LOGIN_FAILED = "login_failed"
    LOGOUT = "logout"
    PASSWORD_CHANGED = "password_changed"
    PASSWORD_RESET = "password_reset"
    ACCOUNT_CREATED = "account_created"
    ACCOUNT_UPDATED = "account_updated"
    ACCOUNT_DEACTIVATED = "account_deactivated"
    ACCOUNT_REACTIVATED = "account_reactivated"
    ACCOUNT_DELETED = "account_deleted"
    ROLE_ASSIGNED = "role_assigned"
    PROFILE_UPDATED = "profile_updated"
    EMAIL_CHANGED = "email_changed"
    PERMISSIONS_CHANGED = "permissions_changed"
    # Roles-as-data
    ORG_ROLE_CREATED = "org_role_created"
    ORG_ROLE_UPDATED = "org_role_updated"
    ORG_ROLE_DELETED = "org_role_deleted"
    CUSTOMER_CREATED = "customer_created"
    CUSTOMER_UPDATED = "customer_updated"
    CUSTOMER_DELETED = "customer_deleted"
    LEAD_CREATED = "lead_created"
    LEAD_UPDATED = "lead_updated"
    LEAD_STAGE_CHANGED = "lead_stage_changed"
    LEAD_COMMENTED = "lead_commented"
    LEAD_DELETED = "lead_deleted"
    INSURER_CREATED = "insurer_created"
    INSURER_UPDATED = "insurer_updated"
    INSURER_DELETED = "insurer_deleted"
    BROKER_CREATED = "broker_created"
    BROKER_UPDATED = "broker_updated"
    BROKER_DELETED = "broker_deleted"
    RATE_RULE_CREATED = "rate_rule_created"
    RATE_RULE_UPDATED = "rate_rule_updated"
    RATE_RULE_DELETED = "rate_rule_deleted"
    CATEGORY_CREATED = "category_created"
    CATEGORY_UPDATED = "category_updated"
    POLICY_CREATED = "policy_created"
    POLICY_UPDATED = "policy_updated"
    POLICY_STATUS_CHANGED = "policy_status_changed"
    POLICY_CANCELLED = "policy_cancelled"
    POLICY_DELETED = "policy_deleted"
    POLICY_APPROVED = "policy_approved"
    POLICY_REJECTED = "policy_rejected"
    REWARD_UPDATED = "reward_updated"
    REWARD_STATUS_CHANGED = "reward_status_changed"
    # Finance engine
    FINANCE_BOOKED = "finance_booked"
    PAYMENT_RECORDED = "payment_recorded"
    LEDGER_ADJUSTED = "ledger_adjusted"
    # Targets
    TARGET_CREATED = "target_created"
    TARGET_UPDATED = "target_updated"
    TARGET_DELETED = "target_deleted"
    # Wallet & withdrawals
    WALLET_CREDITED = "wallet_credited"
    WALLET_ADJUSTED = "wallet_adjusted"
    WITHDRAWAL_REQUESTED = "withdrawal_requested"
    WITHDRAWAL_APPROVED = "withdrawal_approved"
    WITHDRAWAL_REJECTED = "withdrawal_rejected"
    WITHDRAWAL_PAID = "withdrawal_paid"
    # Bank / cash accounts
    BANK_ACCOUNT_CREATED = "bank_account_created"
    BANK_ACCOUNT_UPDATED = "bank_account_updated"
    BANK_ACCOUNT_DELETED = "bank_account_deleted"
    BANK_TRANSFER = "bank_transfer"
    # The real-world balance did not match ours and somebody said so. Its own
    # action because it is the one bank event with no counterparty and no
    # originating document — the only evidence it ever happened is this row.
    BANK_RECONCILED = "bank_reconciled"
    # Reminders (leads now; customers/policies later)
    REMINDER_CREATED = "reminder_created"
    REMINDER_UPDATED = "reminder_updated"
    REMINDER_COMPLETED = "reminder_completed"
    REMINDER_DELETED = "reminder_deleted"
    # Teams
    # Teams were replaced by relationship managers on 2026-08-05. These stay
    # because AUDIT ROWS ALREADY IN THE DATABASE carry them — removing an enum
    # value does not remove the history that used it, it only makes that history
    # fail to deserialise. Nothing writes them any more.
    TEAM_CREATED = "team_created"
    TEAM_UPDATED = "team_updated"
    TEAM_DELETED = "team_deleted"
    TEAM_MEMBER_CHANGED = "team_member_changed"
    DOCUMENT_UPLOADED = "document_uploaded"
    DOCUMENT_DOWNLOADED = "document_downloaded"
    DOCUMENT_DELETED = "document_deleted"
    DOCUMENT_REQUESTED = "document_requested"
    EMAIL_SENT = "email_sent"
    REPORT_EXPORTED = "report_exported"
    # Workplace HR (2026-08-20). Attendance is evidence — an edited day is a
    # claim one person made about another person's working hours, so every one
    # of these carries who changed what, and the manager edits carry a reason.
    ATTENDANCE_PUNCHED_IN = "attendance_punched_in"
    ATTENDANCE_PUNCHED_OUT = "attendance_punched_out"
    ATTENDANCE_EDITED = "attendance_edited"
    ATTENDANCE_CORRECTION_REQUESTED = "attendance_correction_requested"
    ATTENDANCE_CORRECTION_DECIDED = "attendance_correction_decided"
    LEAVE_REQUESTED = "leave_requested"
    LEAVE_UPDATED = "leave_updated"
    LEAVE_DECIDED = "leave_decided"
    LEAVE_CANCELLED = "leave_cancelled"
    LEAVE_BALANCE_ADJUSTED = "leave_balance_adjusted"
    # Payroll (2026-08-24). A payslip is a claim about what somebody is owed,
    # so every state change on one carries who did it — the same treatment a
    # ledger correction gets, for the same reason.
    PAYSLIP_GENERATED = "payslip_generated"
    PAYSLIP_ADJUSTED = "payslip_adjusted"
    PAYSLIP_FINALISED = "payslip_finalised"
    PAYSLIP_REOPENED = "payslip_reopened"
    PAYSLIP_PAID = "payslip_paid"
    PAYSLIP_CANCELLED = "payslip_cancelled"
    # Pending transactions parked out of a bank-statement import (2026-08-24).
    # Discarding one is the only way a statement line leaves the system, so it
    # is the one that must be on the record.
    PENDING_TXN_PARKED = "pending_txn_parked"
    PENDING_TXN_RECORDED = "pending_txn_recorded"
    PENDING_TXN_DISCARDED = "pending_txn_discarded"
    # Time-limited access to a policy somebody does not own (2026-08-24).
    POLICY_ACCESS_REQUESTED = "policy_access_requested"
    POLICY_ACCESS_DECIDED = "policy_access_decided"
    POLICY_ACCESS_REVOKED = "policy_access_revoked"
    # A channel partner moved between relationship managers. Its own action
    # because it moves an entire book of business between two people's screens
    # in one edit — ACCOUNT_UPDATED buries that inside a field diff.
    PARTNER_REASSIGNED = "partner_reassigned"
    HOLIDAY_CREATED = "holiday_created"
    HOLIDAY_UPDATED = "holiday_updated"
    HOLIDAY_DELETED = "holiday_deleted"
    SETTINGS_UPDATED = "settings_updated"
