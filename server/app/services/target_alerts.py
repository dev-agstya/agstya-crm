"""Telling employees about their targets: assignment, milestones, welcome.

Three rules hold everywhere in this module, and they are the whole point of it:

  1. HOUSE PROFIT IS NEVER MENTIONED. Every goal list handed to a notification
     or an email is filtered through `targets.visible_metrics(..., False)`, and
     the percentage quoted is recomputed from what is left. An employee whose
     only goal is house profit therefore gets no target messages at all —
     which is correct: they are not supposed to know it exists (owner,
     2026-07-26).
  2. ONE MESSAGE PER MILESTONE. Crossing 50/90/100% announces itself once; the
     crossed marks are stored on the Target. A policy that takes someone from
     20% to 100% sends the 100% message only.
  3. NOTHING HERE MAY BREAK THE ACTION THAT TRIGGERED IT. Every entry point
     swallows its own errors — a failed SMTP connection must not roll back a
     booked policy.

CHANNEL PARTNERS ARE INCLUDED (owner E4/E5, 2026-08-06). They used to be
excluded, on the reasoning that "they have no login and no mailbox we message" —
which was true when the portal was switched off, and stopped being true when it
shipped. A partner now signs in, sees their target on their home screen, and
gets the same assignment notice and the same milestone congratulations as an
employee. Owners are still excluded: they set the numbers, they do not carry
one.

Rule 1 protects partners too, and more strictly — a partner must never learn the
agency's margin on their own business, and `visible_metrics(..., False)` is what
guarantees the word "profit" cannot reach either audience.
"""

from __future__ import annotations

import logging
from typing import Iterable, Optional

from app.core.enums import AccountType, TargetPeriod
from app.models.base import utcnow
from app.models.target import Target
from app.models.user import User
from app.services import email as email_svc
from app.services import targets as svc
from app.services.notifications import create_notification

log = logging.getLogger(__name__)

DASHBOARD_LINK = "/dashboard"
HELP_LINK = "/help"

# What each milestone says. Kept here (not inline) so the tone can be tuned in
# one place — the owner asked for genuinely motivating lines, not system beeps.
MILESTONE_COPY: dict[int, dict[str, str]] = {
    50: {
        "title": "Halfway to your {period} target! 🎯",
        "headline": "Halfway there!",
        "message": "That is a strong pace — keep the momentum going and this "
                   "month is yours.",
        "subject": "You are halfway to your {period} target",
    },
    90: {
        "title": "90% of your {period} target — nearly there! 🔥",
        "headline": "So close!",
        "message": "One final push and you are over the line. You have got "
                   "this.",
        "subject": "You are at 90% of your {period} target",
    },
    100: {
        "title": "Target achieved for {period}! 🎉",
        "headline": "Target achieved! 🎉",
        "message": "Outstanding work — you hit the number. Take a bow, then "
                   "let's see how far past it you can go.",
        "subject": "Congratulations — {period} target achieved!",
    },
}

WELCOME_TITLE = "Welcome aboard, {name}! 🎉"

# The first thing a new employee reads in the app. Plain steps, no jargon —
# it replaces the empty "No further details" notification the owner hit.
WELCOME_BODY = (
    "Here is the 60-second tour:\n\n"
    "1. Dashboard — the search box on your home page finds any customer, "
    "policy or setting instantly. Your monthly target sits at the bottom.\n"
    "2. Customers — add a customer once (name + mobile), then every policy "
    "you sell them hangs off that record.\n"
    "3. Policies — 'Add Policy' books new business. Pick the customer, the "
    "insurer and the broker, enter the premium, and the commission is worked "
    "out for you.\n"
    "4. Renewals — this list tells you which policies expire soon. Working it "
    "every week is the easiest business you will ever write.\n"
    "5. Leads — track people who have not bought yet, so nobody is forgotten.\n\n"
    "The bell in the corner is where we will nudge you about your target.\n\n"
    "For a full walkthrough, open the Help section from the sidebar."
)

# The same first-run notification, for a CHANNEL PARTNER. It used to be the one
# above, which walks a new partner through booking policies and adding
# customers — neither of which exists in their portal, and both of which the
# server would refuse. A welcome that describes somebody else's app is worse
# than none: it is the first thing they read, and it is wrong.
PARTNER_WELCOME_BODY = (
    "Here is the 60-second tour of your portal:\n\n"
    "1. Home — what you have earned, what is still owed either way, and how "
    "you are tracking against your target.\n"
    "2. My Policies — every policy credited to you, with what you earned on "
    "each one.\n"
    "3. Renewals — your customers whose cover is expiring, so you can reach "
    "them before somebody else does.\n"
    "4. Quote Requests — send us a case and we will come back with a price.\n"
    "5. Claims — report a claim on any of your policies and follow it through "
    "to settlement.\n"
    "6. Earnings — every transaction between you and us, in one statement.\n\n"
    "The bell in the corner is where we will nudge you about your target, and "
    "your relationship manager's number is on your profile whenever you need "
    "a person."
)


def _fmt_value(is_money: bool, value: int) -> str:
    """A goal as a person reads it: rupees with Indian grouping, or a count."""
    if not is_money:
        return f"{int(value):,}"
    rupees = value / 100
    whole = f"{int(round(rupees)):,}"
    # Indian grouping (1,00,000) — Python's comma format is western (100,000).
    if len(whole.replace(",", "")) > 3:
        digits = whole.replace(",", "")
        head, tail = digits[:-3], digits[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts + [tail])
    return f"₹{whole}"


def goal_lines(metrics: dict[str, int], actuals: Optional[dict] = None
               ) -> list[dict]:
    """The goals an EMPLOYEE may see, as {"label", "value"} display rows."""
    rows = svc.metric_rows(metrics or {}, actuals or {}, allow_profit=False)
    return [{"label": r["label"],
             "value": _fmt_value(r["is_money"], r["target_value"])}
            for r in rows]


def visible_attainment(metrics: dict[str, int],
                       actuals: dict[str, int]) -> tuple[float, list[dict]]:
    """(percentage, rows) an employee sees — house profit excluded."""
    rows = svc.metric_rows(metrics or {}, actuals or {}, allow_profit=False)
    return svc.overall_attainment(rows), rows


# Who can carry a target and be told about it: staff, and channel partners now
# that they have a portal to read it in. Owners set the numbers rather than
# carrying one, so they are not here.
_MESSAGEABLE = (AccountType.EMPLOYEE, AccountType.CHANNEL_PARTNER)


async def _assignee(user_id: str) -> Optional[User]:
    """The assignee, but only when they are someone we may message."""
    try:
        user = await User.get(user_id)
    except Exception:  # noqa: BLE001 — a malformed id is not worth an alert
        return None
    if user is None or getattr(user, "is_deleted", False):
        return None
    if user.account_type not in _MESSAGEABLE:
        return None          # the owner sets targets, they don't carry one
    return user


def _assignee_type(user: User) -> str:
    """The `assignee_type` a Target carries, derived from the account.

    Milestones are checked by user id alone (the policy routers know who was
    credited, not which kind of account they hold), so the type has to be looked
    up here — passing "employee" for a partner would score them against the
    wrong half of the book and quietly report 0%.
    """
    return ("channel_partner"
            if user.account_type == AccountType.CHANNEL_PARTNER else "employee")


# --- Welcome -----------------------------------------------------------------


async def notify_welcome(user: User) -> None:
    """First-login welcome + quick-start, shown in the bell.

    The tour a CHANNEL PARTNER gets describes the portal, not the staff app —
    see PARTNER_WELCOME_BODY.
    """
    try:
        partner = user.account_type == AccountType.CHANNEL_PARTNER
        await create_notification(
            str(user.id),
            WELCOME_TITLE.format(name=user.full_name.split(" ")[0]),
            body=PARTNER_WELCOME_BODY if partner else WELCOME_BODY,
            category="welcome",
            # A partner has no Help section in their sidebar; their home screen
            # is where every one of these six things is reachable from.
            link="/dashboard" if partner else HELP_LINK)
    except Exception:  # noqa: BLE001
        log.exception("Welcome notification failed for %s", user.id)


# --- Target assigned ---------------------------------------------------------


async def notify_target_assigned(target: Target) -> None:
    """Tell the assignee their target was set or changed (bell + email)."""
    try:
        user = await _assignee(target.assignee_id)
        if user is None:
            return
        goals = goal_lines(target.metrics)
        if not goals:
            return           # profit-only target: nothing they may be told
        label = svc.period_label(target.period, target.period_start)
        listed = ", ".join(f"{g['label']} {g['value']}" for g in goals)
        await create_notification(
            str(user.id), f"Your {label} target is set — let's make it count!",
            body=f"Your goals for {label}: {listed}. Track your progress on "
                 "the dashboard.",
            category="target", link=DASHBOARD_LINK)
        if user.email:
            await email_svc.send_target_assigned_email(
                user.email, user.full_name, label, goals)
    except Exception:  # noqa: BLE001
        log.exception("Target-assigned alert failed for %s", target.assignee_id)


async def notify_targets_assigned(targets: Iterable[Target]) -> None:
    for t in targets:
        await notify_target_assigned(t)


# --- Milestones --------------------------------------------------------------


async def check_milestones(assignee_id: str) -> None:
    """Announce a newly crossed milestone on this person's CURRENT target.

    Called after anything that can move the numbers (a policy booked, edited,
    cancelled, or its reward outcome changed). Cheap enough to run inline in a
    background task: one target lookup plus the same book read the dashboard
    already does.

    `assignee_id` is a plain user id — a policy credits an employee, a partner
    and that partner's manager, and the caller has no reason to know which is
    which. The account type is resolved here.
    """
    try:
        user = await _assignee(assignee_id)
        if user is None:
            return
        now = utcnow()
        lo, hi = svc.normalise_period(TargetPeriod.MONTH, now)
        target = await svc.find_existing(assignee_id, TargetPeriod.MONTH, lo)
        if target is None or not target.metrics:
            return

        actuals = await svc.compute_actuals(_assignee_type(user), assignee_id,
                                            lo, hi)
        pct, _rows = visible_attainment(target.metrics, actuals)
        milestone = svc.due_milestone(pct, target.notified_pcts)
        if milestone is None:
            return

        # Record EVERY crossed mark, not just the one announced, so the ones
        # jumped over never fire later.
        target.notified_pcts = sorted(
            set(target.notified_pcts) | set(svc.crossed_milestones(pct)))
        target.updated_at = utcnow()
        await target.save()

        copy = MILESTONE_COPY[milestone]
        label = svc.period_label(target.period, target.period_start)
        shown = int(round(pct))
        await create_notification(
            str(user.id), copy["title"].format(period=label),
            body=f"You are at {shown}% of your {label} target. "
                 + copy["message"],
            category="target", link=DASHBOARD_LINK)
        if user.email:
            await email_svc.send_target_milestone_email(
                user.email, user.full_name, label, shown,
                copy["headline"], copy["message"],
                goal_lines(target.metrics, actuals),
                copy["subject"].format(period=label))
    except Exception:  # noqa: BLE001
        log.exception("Milestone check failed for %s", assignee_id)
