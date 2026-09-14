"""Owner-editable runtime settings (single document).

Holds third-party service toggles so the Owner can enable/disable integrations
without a redeploy. There is exactly ONE document (``singleton_key == "system"``).
Read through ``app.services.settings_svc`` which caches it in-process.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from beanie import Document, Indexed
from pydantic import BaseModel, Field

from app.models.base import utcnow


class WhatsAppSettings(BaseModel):
    # Master switch — nothing sends on WhatsApp unless this is True.
    enabled: bool = False

    # On policy CREATE, auto-send the policy PDF to…
    send_policy_on_create_customer: bool = False
    send_policy_on_create_partner: bool = False

    # Renewal reminders over WhatsApp to…
    renewal_reminders_customers: bool = False
    renewal_reminders_partners: bool = False

    # Restrict which customers we may message: all | inhouse | channel_partner.
    customer_send_scope: str = "all"

    # Approved Meta template names + language. Empty => that message type no-ops
    # with a logged reason until a real template name is provided.
    tpl_policy_customer: str = ""
    tpl_policy_partner: str = ""
    tpl_statement_partner: str = ""
    tpl_renewal_customer: str = ""
    tpl_renewal_partner: str = ""
    # Broadcasts to channel partners (routers/announcements).
    tpl_announcement_partner: str = ""
    default_lang: str = "en"


class EmailSettings(BaseModel):
    # Master switch for all transactional email (OTP always allowed so nobody is
    # locked out — enforced in the email layer, not here).
    enabled: bool = True


class PartnerPortalSettings(BaseModel):
    """The Channel Partner portal's master switch and what partners may do.

    TWO gates: this switch, and a per-partner `portal_access` flag on the
    account. Both must be on. Turning `enabled` off locks every partner out
    immediately without a deploy — which is the point of it being a setting
    rather than a constant. (The third, config-level launch gate was removed on
    2026-08-05 when the portal shipped.)

    The capability flags decide what a signed-in partner can DO. They are
    enforced server-side in routers/portal.py, never trusted from the client.

    A partner's WRITE surface is deliberately tiny: a quote request and a claim.
    Everything else in the portal is read-only. Policies, premiums, rewards and
    payouts are written by staff, on staff screens — see the module docstring in
    routers/portal.py.
    """

    enabled: bool = True

    # Owner 2026-08-05 — the capability list for the v2 portal.
    can_request_quotes: bool = True        # raise an enquiry for a new case
    can_raise_claims: bool = True          # report a claim on their own policy
    can_view_earnings: bool = True         # the earnings + transactions screen
    can_download_policy_pdf: bool = True   # their own policy documents
    can_view_renewals: bool = True         # chase their own renewals
    can_upload_kyc: bool = True            # their own KYC documents

    # How long a quote is good for by default, in days. Premiums move; a quote
    # with no expiry is a promise the agency did not make (owner B3).
    quote_validity_days: int = 3

    # Stamped the first time the portal is opened, by
    # services/partner_access.open_portal_to_existing_partners(). Its presence
    # is what stops that backfill running twice — after it has run once, a
    # partner with portal_access=False has been deliberately revoked and must
    # stay revoked.
    access_backfilled_at: Optional[datetime] = None


class HrSettings(BaseModel):
    """Attendance and leave policy for the whole agency (owner 2026-08-20).

    ONE place, set once. The alternative — these values on every employee — is
    thirty copies of "the office opens at 10", twenty-nine of which are right.
    A per-person override exists on `EmployeeProfile` for the genuine exception
    (the one part-timer who starts at 11), and it is read only when set.

    NOTHING HERE IS MONEY, and that survived payroll coming back. The owner
    dropped payslips on 2026-08-20 and asked for them again on 2026-08-24, so
    the module DOES multiply now — but only in `services/payroll`, which reads
    the register's day counts and never the other way round. Both money-adjacent
    values here are DAY COUNTS for that reader: `late_penalty_days` is days off
    the payable figure, `payroll_auto_finalise_days` is how long the register
    stays open for correction. If a rupee ever appears in this class, the
    arithmetic has moved back inside the register the figure is meant to be
    arguable from.
    """

    # --- The week ---
    # Python's weekday(): Monday=0 ... Sunday=6. The agency works Monday to
    # Saturday with Sunday off and nothing else (owner), but this is a SET
    # rather than a hard-coded Sunday so the day somebody decides to close on
    # alternate Saturdays is a setting rather than a deploy.
    week_off_days: list[int] = Field(default_factory=lambda: [6])

    # --- The shift ---
    # "HH:MM" in IST. Strings rather than times because they are edited as text,
    # rendered as text, and never arithmetic'd without being parsed first —
    # storing a `time` would only move the parsing to the other end.
    shift_start: str = "10:00"
    shift_end: str = "19:00"
    # Clock in at 10:15:00 with a 15-minute grace and you are on time; 10:15:01
    # is a late mark.
    late_grace_minutes: int = 15
    early_out_grace_minutes: int = 15

    # --- What a day has to be worth ---
    full_day_minutes: int = 480       # 8h of WORK, breaks already subtracted
    half_day_minutes: int = 240       # below this the day does not count at all
    # Break time is subtracted from worked minutes but never punished on its
    # own: a three-hour lunch turns the day into a half day by itself, which is
    # consequence enough. This value is what the UI warns against, not a rule.
    max_break_minutes: int = 60

    # --- Late marks ---
    # Three lates in a calendar month cost half a day off the payable-days
    # count. A mark with no consequence is ignored within a fortnight; a mark
    # that costs a day is disproportionate for being ten minutes late.
    late_marks_per_penalty: int = 3
    late_penalty_days: float = 0.5

    # --- Leave ---
    monthly_leave_accrual: float = 1.5
    # Carried forward WITHIN the leave year and capped. 18 is a full year's
    # accrual — the cap exists so a missed lapse cannot compound for ever.
    max_leave_balance: float = 18.0
    # The Indian financial year starts in April, and so does the leave year
    # (owner E2/E3): balances carry inside it and lapse at the end of it.
    leave_year_start_month: int = 4

    # --- Nudges ---
    # Minutes after shift start at which somebody who is neither clocked in nor
    # on approved leave gets a bell. Removes most missed punches before they
    # become corrections. 0 switches it off.
    missing_punch_nudge_minutes: int = 30

    # --- Where the punch came from (owner 2026-08-21) ---
    #
    # "HMWQ+FQ Udaipur, Rajasthan is the location of this office, so if the user
    # clicks on login from this location it should be marked as present, if user
    # is not in this location and marks the attendance it should be marked as
    # work from home attendance… allowed radius from this should be 150m."
    #
    # The rule itself lives in services/hr_geo — this is only where the office
    # is. OFF BY DEFAULT: switching it on changes what every future punch means,
    # so it is a decision somebody makes on the settings page after checking the
    # pin, not something that starts happening on deploy.
    geofence_enabled: bool = False
    # Shown on the punch tile ("You are at Head office"), so it is worth a name
    # rather than a bare coordinate.
    office_label: str = "Head office"
    # Decoded from the owner's Plus Code HMWQ+FQ Udaipur → full code
    # 7JPMHMWQ+FQ. Pre-filled rather than left blank so the settings page opens
    # on the right pin, and CONFIRMABLE on that page against a map link, because
    # a wrong centre marks the whole office work-from-home and nothing on screen
    # would explain why.
    office_lat: float = 24.596187
    office_lng: float = 73.689437
    # Metres. The owner's number.
    office_radius_m: int = 150
    # A reading whose OWN reported accuracy is worse than this cannot place
    # somebody inside a 150m circle, so it is recorded as UNKNOWN instead of
    # being guessed at. Defaulting it to the radius keeps the two in step: the
    # fence and the confidence needed to sit inside it are the same distance.
    max_accuracy_m: int = 150
    # What an unplaceable punch counts as for the day's STATUS. The reading
    # stays UNKNOWN in the data either way — this only decides which way the
    # doubt falls. Default is remote, matching the owner's rule that anything
    # not confirmed at the office is work from home.
    unknown_counts_as_office: bool = False
    # Refuse a punch with no location at all, rather than recording it as
    # unplaceable. OFF by default and that is deliberate: a browser that denies
    # the permission, an old phone, a laptop with no location service — none of
    # those are the employee's fault, and an attendance system that will not let
    # somebody clock in is worse than one that records the day and flags it.
    require_location: bool = False

    # --- The correction window before pay locks (owner 2026-09-06) ---
    #
    # "We will also give one-two days buffer for the admin or the owner or the
    # managers to check the attendance or make any corrections if required, so
    # that their salaries are calculated automatically and correctly."
    #
    # WORKING days, counted from the day after the month ends, and it is a DAY
    # COUNT rather than money — the rule that no rupee lives in this class still
    # holds. Working rather than calendar because the entire point of the window
    # is that a human gets a chance to look: a month ending on a Friday with a
    # 2-CALENDAR-day buffer would lock on Sunday, having offered nobody
    # anything. `services/payroll.auto_finalise_on` turns this into a date.
    #
    # 0 SWITCHES IT OFF and leaves today's behaviour exactly as it was —
    # payslips generate as drafts and wait for somebody to press Finalise. Kept
    # as one number rather than a boolean beside a number, because a switch and
    # a count can contradict each other and this cannot.
    payroll_auto_finalise_days: int = 2


class SystemSettings(Document):
    singleton_key: Indexed(str, unique=True) = "system"
    whatsapp: WhatsAppSettings = Field(default_factory=WhatsAppSettings)
    email: EmailSettings = Field(default_factory=EmailSettings)
    partner_portal: PartnerPortalSettings = Field(
        default_factory=PartnerPortalSettings)
    hr: HrSettings = Field(default_factory=HrSettings)

    # Stamped once by services/manager_backfill, on the boot that ships the
    # relationship-manager stamp on policies. Presence = the backfill has run.
    manager_backfilled_at: Optional[datetime] = None

    updated_at: datetime = Field(default_factory=utcnow)
    updated_by: Optional[str] = None

    class Settings:
        name = "system_settings"
