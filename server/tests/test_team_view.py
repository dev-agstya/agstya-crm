"""An employee's TEAM: finding it, and what is in it.

The owner's report was that there is nowhere to "see the team of that employee…
how is that team performing", which was startling, because the panel existed and
had since 2026-08-05. That IS the finding: a tab nobody can find is a feature
nobody has.

So there are two separate things pinned here.

  FINDING IT   the employee directory carries the roster size on the row, and
               it is the link into the Team tab. Nothing about the old table
               said a team was behind any particular row, so opening one to
               check was a gamble — and you do not take that gamble twenty
               times.

  WHAT IS IN IT  the manager's own goal, the ALLOCATION gap against it (F16),
               the partners as cards, and the actual policies behind the totals.
               Plus F15: the quiet flag can finally be acted on.
"""

from __future__ import annotations

import inspect
from pathlib import Path

from app.models.reminder import REMINDER_ENTITIES
from app.routers import managers as managers_router
from app.routers import users as users_router
from app.schemas.manager import ManagerRoster, TeamPolicies
from app.schemas.target import TargetMetricRow

WEB = Path(__file__).resolve().parents[2] / "web" / "src"


def _metric(metric, label, value, is_money=False):
    return TargetMetricRow(metric=metric, label=label, is_money=is_money,
                           target_value=value)


class _Row:
    """Enough of a PartnerRosterRow for `_allocation`, which reads attributes."""

    def __init__(self, active=True, metrics=()):
        self.active_account = active
        self.target_metrics = list(metrics)


# --- Finding it -------------------------------------------------------------------


def test_the_employee_directory_carries_the_roster_size():
    from app.schemas.user import UserOut

    assert "partners_under" in UserOut.model_fields


def test_roster_sizes_are_ONE_query_for_the_whole_page():
    """15 rows must not become 15 round trips. A count per row is the shape that
    makes a list page slow enough that somebody removes the useful column."""
    source = inspect.getsource(users_router._roster_sizes)
    assert "$group" in source
    assert "aggregate" in source


def test_the_count_links_into_the_team_tab():
    page = (WEB / "pages" / "EmployeesPage.tsx").read_text(encoding="utf-8")
    assert "?tab=team" in page
    table = (WEB / "components" / "PeopleTable.tsx").read_text(encoding="utf-8")
    assert "partners_under" in table


def test_the_link_is_hidden_from_anyone_who_could_not_open_the_tab():
    """Reading somebody ELSE's roster needs view_partners — the same rule
    PersonDetailBody applies to whether the tab is drawn at all. Offering a
    button that lands on a record with no Team tab looks broken rather than
    closed."""
    page = (WEB / "pages" / "EmployeesPage.tsx").read_text(encoding="utf-8")
    assert 'has("view_partners")' in page
    assert "canSeeTeams" in page


# --- F16: the allocation gap --------------------------------------------------------


def test_allocation_sums_what_the_partners_were_given():
    """The whole point of a team target is dividing your number across your
    roster. Both figures were on the screen and the GAP between them was not, so
    the one piece of arithmetic that matters had to be done by eye."""
    rows = [
        _Row(metrics=[_metric("policies", "Policies", 10)]),
        _Row(metrics=[_metric("policies", "Policies", 15)]),
    ]
    out = managers_router._allocation(
        [_metric("policies", "Policies", 100)], rows)
    assert len(out) == 1
    assert out[0].target_value == 100
    assert out[0].allocated == 25
    assert out[0].partners_with_goal == 2


def test_a_deactivated_partner_is_not_counted_as_allocated():
    """Matching `partners_with_target` (owner J3): they cannot write the
    business a goal asks for, and counting them makes a manager look allocated
    when they are not."""
    rows = [
        _Row(active=True, metrics=[_metric("policies", "Policies", 10)]),
        _Row(active=False, metrics=[_metric("policies", "Policies", 40)]),
    ]
    out = managers_router._allocation(
        [_metric("policies", "Policies", 100)], rows)
    assert out[0].allocated == 10


def test_only_metrics_the_MANAGER_carries_appear():
    """A partner goal on something their manager was never given is a different
    conversation. Including it would make the gap — the one number the row
    exists to show — meaningless."""
    rows = [_Row(metrics=[_metric("premium", "Premium", 500, is_money=True)])]
    out = managers_router._allocation(
        [_metric("policies", "Policies", 100)], rows)
    assert [r.metric for r in out] == ["policies"]
    assert out[0].allocated == 0


def test_over_allocation_is_reported_not_refused():
    """A manager who wants headroom hands out more than they were given
    deliberately. That is a strategy, not a mistake."""
    rows = [_Row(metrics=[_metric("policies", "Policies", 200)])]
    out = managers_router._allocation(
        [_metric("policies", "Policies", 100)], rows)
    assert out[0].allocated == 200        # recorded, no exception, no clamp


def test_an_empty_roster_still_reports_the_gap():
    """"100 policies, none handed out" is the most actionable version of this
    line, so it must not vanish with the roster."""
    out = managers_router._allocation(
        [_metric("policies", "Policies", 100)], [])
    assert out[0].allocated == 0
    assert out[0].target_value == 100
    assert "allocation" in ManagerRoster.model_fields


# --- The team's actual policies ------------------------------------------------------


def test_the_team_has_a_policies_endpoint():
    assert hasattr(managers_router, "my_team_policies")
    assert hasattr(managers_router, "manager_team_policies")


def test_me_policies_is_registered_before_the_dynamic_route():
    """Or `/{manager_id}/policies` swallows "me" and tries to load a user with
    that id — the same scar `/me/partners` already carries."""
    source = inspect.getsource(managers_router)
    assert source.index('"/me/policies"') < source.index('"/{manager_id}/policies"')


def test_reading_someone_elses_team_uses_the_SAME_gate_as_their_roster():
    """A new way to read somebody's numbers must not appear without the rule
    that governs the old one."""
    source = inspect.getsource(managers_router.manager_team_policies)
    assert "_assert_may_read(actor, manager_id)" in source


def test_the_team_policy_list_carries_no_agency_margin():
    """`their_reward` is what the PARTNER earns — operational, and already on
    the roster. The agency's own reward and house profit have their own
    permission and their own screens; a team view must not quietly become a
    finance report."""
    fields = set(TeamPolicies.model_fields)
    from app.schemas.manager import TeamPolicyRow

    row_fields = set(TeamPolicyRow.model_fields)
    for banned in ("agency_reward", "house_profit", "profit", "reward_earned"):
        assert banned not in fields
        assert banned not in row_fields


def test_the_team_policy_list_is_capped_and_says_so():
    """A footer summing 500 rows under a count of 900 is a spreadsheet that lies
    quietly."""
    assert managers_router.MAX_TEAM_POLICIES == 500
    assert "truncated" in TeamPolicies.model_fields
    source = inspect.getsource(managers_router._team_policies)
    assert "truncated=total > len(rows)" in source


def test_the_team_policy_list_is_scoped_to_the_roster():
    """`$in`-scoped, not a find_all(). CLAUDE.md asks new reads not to widen
    that pattern, and this is a new read."""
    source = inspect.getsource(managers_router._team_policies)
    assert '"partner_id": {"$in": ids}' in source


# --- F15: the quiet flag can be acted on ----------------------------------------------


def test_a_reminder_can_hang_off_a_channel_partner():
    """"Quiet for 61 days" was drawn in amber and led NOWHERE — no way to record
    that you had rung them, so the same partner was flagged again tomorrow with
    no memory of yesterday. That is how a flag stops being read."""
    assert "channel_partner" in REMINDER_ENTITIES


def test_the_reminder_describes_the_partner_it_is_about():
    """The label is denormalised onto the reminder so the 08:00 digest can name
    what needs chasing without loading every record."""
    from app.routers import reminders as reminders_router

    source = inspect.getsource(reminders_router._describe)
    assert 'entity_type == "channel_partner"' in source
    assert "partner.full_name" in source


def test_a_non_partner_account_cannot_be_filed_as_one():
    from app.routers import reminders as reminders_router

    source = inspect.getsource(reminders_router._describe)
    assert "AccountType.CHANNEL_PARTNER" in source


def test_the_roster_offers_the_follow_up():
    panel = (WEB / "components" / "ManagerRosterPanel.tsx").read_text(
        encoding="utf-8")
    card = (WEB / "components" / "team" / "PartnerCard.tsx").read_text(
        encoding="utf-8")
    assert "remindersApi.create" in panel
    assert 'entity_type: "channel_partner"' in panel
    assert "Log a follow-up" in card


# --- F13: reminders are not orphaned by a deactivation ---------------------------------


def test_deactivating_someone_hands_over_their_open_reminders():
    """A reminder is SHARED, and nothing removed a switched-off account from
    `assignee_ids`. Where they were the ONLY assignee the task stopped appearing
    in every bell and every digest — not dropped, INVISIBLY dropped."""
    from app.services import reminder_svc

    assert hasattr(reminder_svc, "hand_over_on_deactivation")
    source = inspect.getsource(users_router.update_status)
    assert "hand_over_on_deactivation" in source


def test_a_reminder_with_other_names_on_it_just_loses_the_leaver():
    """It is still somebody's job. Adding a name nobody asked for is noise."""
    from app.services import reminder_svc

    source = inspect.getsource(reminder_svc.hand_over_on_deactivation)
    assert "if keep:" in source


def test_handing_over_never_blocks_the_deactivation():
    """An account that cannot be switched off because a reminder would not move
    is a worse outcome than a reminder somebody has to find by hand."""
    from app.services import reminder_svc

    assert "Never raises" in inspect.getdoc(
        reminder_svc.hand_over_on_deactivation)
    assert "except Exception" in inspect.getsource(users_router.update_status)


def test_the_names_list_is_padded_before_zipping():
    """`assignee_ids` and `assignee_names` are two lists written together, and a
    row from an older version can be short. Zipping them raw DROPS the trailing
    assignees — which on this path means silently removing people from a
    reminder while claiming to have tidied it."""
    from app.services import reminder_svc

    assert "_padded_names" in inspect.getsource(
        reminder_svc.hand_over_on_deactivation)


# --- F6: a partner owed money is not switched off by accident --------------------------


def test_deactivating_a_partner_who_is_owed_money_is_refused_once():
    """Not blocked — deactivating someone you are in DISPUTE with is a normal
    thing to want. Refused once, with the figure in the message."""
    source = inspect.getsource(users_router.update_status)
    assert "acknowledge_balance" in source
    assert "HTTP_409_CONFLICT" in source


def test_the_amount_owed_comes_from_the_ONE_definition():
    """`finance_balance.partner_net_balance` — the same function behind the
    Balance Sheet, the partner's statement, the roster and the portal wallet.
    Recomputing it here would give a different answer from the screen the
    partner is looking at."""
    source = inspect.getsource(users_router._partner_owed)
    assert "partner_net_balance" in source
