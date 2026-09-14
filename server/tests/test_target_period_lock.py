"""A relationship manager sets FUTURE numbers, not past ones (owner C4).

Context. Since owner F1 (July) an employee may set targets for the channel
partners on their own roster WITHOUT `manage_targets` — splitting your own goal
across your own roster is the relationship manager's job, not a privilege over
the agency. On 2026-08-21 the Targets page was opened to every employee so that
right could actually be found and used, which made one more question real: how
far BACK does it reach?

The rule:

  * READING is unrestricted. Deciding this month's number for a partner means
    reading last month's first, so the month picker goes back as far as anyone
    likes and `_may_read` is untouched.
  * WRITING a finished month is refused. Moving a goal somebody has already been
    measured against is not setting a target — it is editing history, and it
    silently rewrites an attainment figure that has already been reported.
  * `manage_targets` IS EXEMPT. Correcting a number keyed in wrong two months ago
    is a real administrative job, and the owner already carries every other
    irreversible action in the app.

The boundary is the IST month, like every other reporting boundary here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core.enums import AccountType, TargetPeriod
from app.core.permissions import MANAGE_TARGETS, PERMISSIONS_VERSION, VIEW_TARGETS
from app.routers import targets as router
from app.services import targets as svc
from app.services.finance_reports import IST


@dataclass
class _FakeUser:
    account_type: object
    permissions: list = field(default_factory=list)
    permissions_version: int = PERMISSIONS_VERSION
    id: str = "employee-1"
    full_name: str = "Rahul"


def _manager(*flags: str) -> _FakeUser:
    """An employee with no targets permission — the relationship-manager case."""
    return _FakeUser(AccountType.EMPLOYEE, list(flags))


def _owner() -> _FakeUser:
    return _FakeUser(AccountType.OWNER, [], id="owner-1")


def _month_start(when: datetime) -> datetime:
    """The normalised period start for the month `when` falls in."""
    return svc.normalise_period(TargetPeriod.MONTH, when)[0]


NOW = datetime.now(timezone.utc)
THIS_MONTH = _month_start(NOW)
LAST_MONTH = _month_start(THIS_MONTH - timedelta(days=1))
NEXT_MONTH = svc.normalise_period(TargetPeriod.MONTH, THIS_MONTH)[1]


# --- What counts as past ----------------------------------------------------------


def test_this_month_is_not_past():
    assert router._period_is_past(THIS_MONTH) is False


def test_last_month_is_past():
    assert router._period_is_past(LAST_MONTH) is True


def test_next_month_is_not_past():
    assert router._period_is_past(NEXT_MONTH) is False


def test_the_boundary_is_the_ist_month_not_a_raw_instant():
    """00:30 IST on the 1st is a NEW month, not the tail of the old one.

    IST is UTC+5:30, so the first five and a half hours of every 1st are still
    the previous day in UTC. Comparing instants would leave a manager unable to
    set the new month's targets until 05:30, and still able to edit the old
    month's — exactly backwards.
    """
    first_ist = (THIS_MONTH.astimezone(IST)
                 .replace(hour=0, minute=30, second=0, microsecond=0))
    assert _month_start(first_ist.astimezone(timezone.utc)) == THIS_MONTH
    assert router._period_is_past(THIS_MONTH) is False


# --- Who the rule applies to ------------------------------------------------------


@pytest.mark.asyncio
async def test_a_manager_may_set_this_months_target():
    await router._assert_period_open(_manager(), THIS_MONTH)


@pytest.mark.asyncio
async def test_a_manager_may_set_a_future_target():
    await router._assert_period_open(_manager(), NEXT_MONTH)


@pytest.mark.asyncio
async def test_a_manager_may_not_change_a_finished_month():
    with pytest.raises(HTTPException) as err:
        await router._assert_period_open(_manager(), LAST_MONTH)
    assert err.value.status_code == 403


@pytest.mark.asyncio
async def test_the_refusal_names_the_month_and_says_what_to_do():
    """A 403 is a sentence, not a stack trace — and a dead end is not a sentence.

    Somebody who has just stepped the picker back one month needs to be told
    which month is the problem and where to go instead.
    """
    with pytest.raises(HTTPException) as err:
        await router._assert_period_open(_manager(), LAST_MONTH)
    detail = err.value.detail
    assert svc.period_label(TargetPeriod.MONTH, LAST_MONTH) in detail
    assert "this month" in detail.lower()
    assert detail.endswith(".")


@pytest.mark.asyncio
async def test_manage_targets_may_still_correct_a_finished_month():
    """The exemption. An admin fixing a mis-keyed number is a real job."""
    await router._assert_period_open(_manager(MANAGE_TARGETS), LAST_MONTH)


@pytest.mark.asyncio
async def test_the_owner_may_still_correct_a_finished_month():
    await router._assert_period_open(_owner(), LAST_MONTH)


@pytest.mark.asyncio
async def test_view_targets_alone_does_not_unlock_a_finished_month():
    """`view_targets` is a reading right and must not become a writing one."""
    with pytest.raises(HTTPException):
        await router._assert_period_open(_manager(VIEW_TARGETS), LAST_MONTH)


# --- Reading stays open -----------------------------------------------------------


def test_reading_a_past_month_is_not_gated_by_this_rule():
    """The rule is applied on the WRITE paths only.

    Guards against somebody "tidying up" by moving the call into a shared
    helper: a manager who cannot see last month cannot decide this month, which
    would break the feature this rule was added alongside.
    """
    import inspect
    for fn in (router.list_targets, router.progress, router.performance,
               router.analytics, router._may_read):
        assert "_assert_period_open" not in inspect.getsource(fn), fn.__name__


def test_every_write_path_a_manager_can_reach_is_guarded():
    """create / update / delete. `bulk` is `manage_targets` at route level."""
    import inspect
    for fn in (router.create_target, router.update_target,
               router.delete_target):
        assert "_assert_period_open" in inspect.getsource(fn), fn.__name__


def test_an_edit_checks_the_period_it_is_in_as_well_as_the_one_it_moves_to():
    """Both ends, or a finished month could be emptied by moving its target out.

    `update_target` accepts `period_start`, so checking only the destination
    would let a manager relocate last month's goal into this month — which
    removes last month's number without ever writing to a past period.
    """
    import inspect
    src = inspect.getsource(router.update_target)
    assert src.count("_assert_period_open") == 2
