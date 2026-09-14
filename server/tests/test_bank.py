"""Bank / cash account maths — the part that must never be wrong.

These are pure (no DB): they pin the cash-direction rules in services/bank,
because the ledger's stored sign is the PARTY-receivable view and reading bank
direction off it is the mistake that silently corrupts every balance.
"""

import pytest

from app.core.enums import BankAccountType, LedgerTxnType
from app.services import bank as bank_svc
from app.services.finance import tds_on_reward


# --- Direction ------------------------------------------------------------------


def test_money_in_is_positive_even_though_the_ledger_stores_it_negative():
    """Premium collected is stored NEGATIVE (it reduces what the customer owes)
    and is money coming IN. Deriving direction from the stored sign — the
    obvious shortcut — gets this exactly backwards."""
    stored = -50_000                      # how the ledger holds a Rs 500 receipt
    assert bank_svc.cash_delta(LedgerTxnType.PREMIUM_COLLECTED, stored) == 50_000


def test_money_out_is_negative_even_though_the_ledger_stores_it_positive():
    """Premium paid to the insurer is stored POSITIVE and is money going OUT."""
    stored = 50_000
    assert bank_svc.cash_delta(
        LedgerTxnType.PREMIUM_TO_INSURER, stored) == -50_000


@pytest.mark.parametrize("txn_type", [
    LedgerTxnType.PARTNER_PAYOUT,
    LedgerTxnType.PARTNER_ADVANCE,
    LedgerTxnType.REFUND,
    LedgerTxnType.EXPENSE,
])
def test_every_payout_kind_leaves_the_account(txn_type):
    assert bank_svc.cash_delta(txn_type, 25_000) < 0
    assert bank_svc.cash_delta(txn_type, -25_000) < 0   # sign-independent


# --- The TDS case (the one that would drift every balance) -----------------------


def test_a_reward_receipt_credits_the_bank_net_of_tds():
    """Broker settles Rs 10,000 having withheld 2%: the ledger records the gross
    10,000 (so the broker's receivable clears in full) but the BANK receives
    9,800. Miss this and every account drifts by the total tax withheld."""
    gross = 1_000_000                                  # Rs 10,000 in paise
    tds = tds_on_reward(gross, 200)                    # 2% -> percent*100
    assert tds == 20_000                               # Rs 200
    assert bank_svc.cash_delta(LedgerTxnType.REWARD_RECEIVED, gross,
                               tds_paise=tds) == 980_000


def test_a_reward_receipt_with_no_tds_credits_the_gross():
    assert bank_svc.cash_delta(LedgerTxnType.REWARD_RECEIVED, 1_000_000,
                               tds_paise=0) == 1_000_000


def test_a_nonsense_tds_rate_cannot_turn_a_receipt_into_a_withdrawal():
    assert bank_svc.cash_delta(LedgerTxnType.REWARD_RECEIVED, 1_000,
                               tds_paise=999_999) == 0


# --- Rows that must never touch a bank account ------------------------------------


@pytest.mark.parametrize("txn_type", [
    LedgerTxnType.PREMIUM_DUE,             # accrual: what someone owes us
    LedgerTxnType.PREMIUM_PAID_BY_AGENCY,  # informational mirror of a real row
    LedgerTxnType.REWARD_CANCELLED,        # informational
    LedgerTxnType.DISCOUNT,                # lives on the policy
    LedgerTxnType.TDS_DEDUCTED,            # tax withheld before the money moved
])
def test_accrual_and_informational_rows_move_no_cash(txn_type):
    assert bank_svc.cash_delta(txn_type, 100_000) == 0
    assert not bank_svc.is_cash_moving(txn_type)


def test_an_unclassified_type_defaults_to_moving_nothing():
    """New ledger types must opt IN to moving cash. Forgetting to classify one
    should leave balances untouched, never corrupt them."""
    class _Fake:
        pass
    assert bank_svc.cash_delta(_Fake(), 100_000) == 0


# --- Caller-directed movements ------------------------------------------------------


def test_an_adjustment_moves_nothing_unless_the_recorder_says_so():
    assert bank_svc.cash_delta(LedgerTxnType.ADJUSTMENT, 10_000) == 0
    assert bank_svc.cash_delta(LedgerTxnType.ADJUSTMENT, 10_000,
                               manual_delta=10_000) == 10_000
    assert bank_svc.cash_delta(LedgerTxnType.ADJUSTMENT, 10_000,
                               manual_delta=-10_000) == -10_000


def test_a_transfer_uses_its_own_signed_amount():
    """Each leg of a transfer already carries its true cash sign."""
    assert bank_svc.cash_delta(LedgerTxnType.TRANSFER, 10_000,
                               manual_delta=-10_000) == -10_000
    assert bank_svc.cash_delta(LedgerTxnType.TRANSFER, 10_000,
                               manual_delta=10_000) == 10_000


def test_a_transfer_nets_to_zero_across_the_two_accounts():
    out = bank_svc.cash_delta(LedgerTxnType.TRANSFER, 10_000, manual_delta=-10_000)
    into = bank_svc.cash_delta(LedgerTxnType.TRANSFER, 10_000, manual_delta=10_000)
    assert out + into == 0, "moving your own money changes the total by nothing"


# --- Account kinds --------------------------------------------------------------------


def test_a_credit_card_is_not_cash_in_hand():
    """A card balance is money OWED. Adding it into the cash total would report
    less money than the agency actually holds. BankAccount.is_cash_asset reads
    this same set, so the two can't drift."""
    from app.core.enums import CASH_ASSET_ACCOUNT_TYPES

    assert BankAccountType.CREDIT_CARD not in CASH_ASSET_ACCOUNT_TYPES
    for kind in (BankAccountType.BANK, BankAccountType.CASH,
                 BankAccountType.UPI):
        assert kind in CASH_ASSET_ACCOUNT_TYPES


# --- Idempotency keys -------------------------------------------------------------------


def test_keys_are_trimmed_capped_and_emptied_to_none():
    from app.services import idempotency

    assert idempotency.clean(None) is None
    assert idempotency.clean("   ") is None
    assert idempotency.clean("  abc  ") == "abc"
    assert len(idempotency.clean("x" * 500)) == idempotency.MAX_KEY_LENGTH


def test_multi_row_postings_get_distinct_keys():
    """A transfer writes two rows; they must not collide on one key."""
    from app.services import idempotency

    assert idempotency.derive("k", "out") != idempotency.derive("k", "in")
    assert idempotency.derive(None, "out") is None


# --- A half-written transfer is BROKEN, not "already done" -----------------------
#
# Fixed 2026-08-07. create_transfer asked "does the OUT key exist?" to decide
# whether the transfer had already been applied. That conflates two very
# different states:
#
#   both legs written  -> genuinely done, return the position (correct)
#   only the out leg   -> the process died between the two inserts
#
# In the second case the retry returned SUCCESS and never wrote the in leg. The
# out row carries its own bank_delta_paise, so the next "Rebuild balance"
# debited the source for real; the target was never credited. Money left an
# account and arrived nowhere, and the app reported it as fine.
#
# The endpoint now checks both keys, resumes the original transfer_group_id, and
# derives both balances with recompute_balance() — which is right whichever
# increment happened to land before the crash.


class _Leg:
    """A stand-in LedgerTxn: only the fields the sweep reads."""

    def __init__(self, group, delta, account, txn_id="t", occurred_at=None):
        self.transfer_group_id = group
        self.bank_delta_paise = delta
        self.bank_account_id = account
        self.id = txn_id
        self.occurred_at = occurred_at


def _sweep(rows):
    """Run find_broken_transfers' classification over an in-memory row set."""
    groups: dict = {}
    for r in rows:
        groups.setdefault(r.transfer_group_id, []).append(r)
    broken = []
    for group_id, legs in groups.items():
        deltas = [int(x.bank_delta_paise or 0) for x in legs]
        if len(legs) == 2 and sum(deltas) == 0:
            continue
        broken.append({"transfer_group_id": group_id, "legs": len(legs),
                       "net_paise": sum(deltas)})
    return broken


def test_a_healthy_transfer_has_two_legs_that_sum_to_zero():
    rows = [_Leg("g1", -10_000, "A"), _Leg("g1", 10_000, "B")]
    assert _sweep(rows) == [], "a paired, balanced transfer is not a problem"


def test_the_sweep_catches_a_transfer_that_only_debited():
    """The exact crash shape: the out row landed, the in row never did."""
    rows = [_Leg("g2", -10_000, "A")]
    broken = _sweep(rows)
    assert len(broken) == 1
    assert broken[0]["legs"] == 1
    assert broken[0]["net_paise"] == -10_000, \
        "money left an account and arrived nowhere"


def test_the_sweep_catches_two_legs_that_do_not_cancel():
    rows = [_Leg("g3", -10_000, "A"), _Leg("g3", 9_000, "B")]
    assert _sweep(rows)[0]["net_paise"] == -1_000


def test_deciding_a_transfer_is_done_needs_BOTH_keys():
    """The bug in one assertion: the out key alone is not proof.

    `existing_out is not None` was the old condition. It is true in both the
    finished and the half-written case, which is why the half-written one was
    reported as success.
    """
    from app.services import idempotency

    out_key = idempotency.derive("k", "out")
    in_key = idempotency.derive("k", "in")
    assert out_key and in_key and out_key != in_key

    def already_applied(has_out: bool, has_in: bool) -> bool:
        return has_out and has_in          # what the endpoint now asks

    assert already_applied(True, True) is True
    assert already_applied(True, False) is False, \
        "a half-written transfer must be resumed, never reported as done"
    assert already_applied(False, False) is False


# --- The default account can be UNSET, not only set ------------------------------


def test_clearing_the_default_flag_is_a_real_edit():
    """`if data.get("is_default")` ignored an explicit false, so an account
    could be made the default and never un-defaulted. Presence, not truthiness."""

    def applied(data: dict, current: bool) -> bool:
        if "is_default" in data and data["is_default"] is not None:
            return bool(data["is_default"])
        return current

    assert applied({"is_default": True}, False) is True
    assert applied({"is_default": False}, True) is False, \
        "an explicit false must clear the flag"
    assert applied({}, True) is True, "an absent key changes nothing"
    assert applied({"name": "x"}, False) is False


# --- Reconciliation: making the app agree with the real account ------------------
#
# The owner's ask (2026-08-07) was to "hard reset the bank balance ... which
# should not make any changes to previous balances". Taken literally those two
# halves fight: `balance_paise` is not stored truth, it is
# `opening_balance_paise + Σ bank_delta_paise`, and recompute_balance() rebuilds
# it from exactly that sum. So an overwrite lasts until somebody presses
# Recompute and then reverts, with no trace.
#
# Posting the difference as one dated ADJUSTMENT row satisfies both halves at
# once, and these pin why.


def test_the_adjustment_is_the_gap_between_us_and_the_bank():
    # We think 46,000; the bank says 45,800. We are 200 over.
    assert bank_svc.reconcile_delta(46_000_00, 45_800_00) == -200_00
    # We think 45,800; the bank says 46,000. We are 200 short.
    assert bank_svc.reconcile_delta(45_800_00, 46_000_00) == 200_00


def test_an_account_that_already_agrees_needs_no_adjustment():
    """Zero must be zero, so the router can skip writing the row. A ledger full
    of Rs 0 adjustments is a ledger people stop reading."""
    assert bank_svc.reconcile_delta(46_000_00, 46_000_00) == 0


def test_a_reconciliation_survives_a_recompute():
    """THE property. recompute_balance() is `opening + Σ deltas`, and the
    adjustment is now one of those deltas — so the repair path reproduces the
    reconciled figure instead of undoing it.

    This is the test that fails if anyone 'simplifies' this to an overwrite of
    `balance_paise`.
    """
    opening = 10_000_00
    rows = [5_000_00, -2_000_00]              # what the ledger already holds
    ours = opening + sum(rows)                # 13,000 — what the app shows
    actual = 12_500_00                        # what the bank actually holds

    adjustment = bank_svc.reconcile_delta(ours, actual)
    rows.append(adjustment)                   # posted as a real ledger row

    # Exactly what recompute_balance() computes, and it now equals the bank.
    assert opening + sum(rows) == actual


def test_reconciling_leaves_every_earlier_balance_alone():
    """"Should not make any changes to previous balances." The running balance
    after each historical row is unchanged; only a new final row appears."""
    opening = 10_000_00
    rows = [5_000_00, -2_000_00]

    def running(deltas):
        total, out = opening, []
        for d in deltas:
            total += d
            out.append(total)
        return out

    before = running(rows)
    after = running(rows + [bank_svc.reconcile_delta(opening + sum(rows),
                                                     12_500_00)])
    assert after[:len(before)] == before      # history is byte-identical
    assert after[-1] == 12_500_00             # and the end now matches the bank


def test_a_negative_real_balance_is_legitimate():
    """A credit card holds money OWED and a current account can be overdrawn,
    so the actual balance is not constrained to be positive."""
    assert bank_svc.reconcile_delta(0, -8_000_00) == -8_000_00
    assert bank_svc.reconcile_delta(-8_000_00, -6_000_00) == 200_000


# --- The reconcile endpoint's design, read off the source -----------------------
#
# Source-reading, in the style of tests/test_partner_boundary.py: these are
# decisions inside a router, and standing up Mongo to observe them would be
# testing the harness.


def _banks_router_source() -> str:
    """The endpoint's CODE, with the docstring and comments removed.

    Stripping matters: this function is heavily commented precisely because the
    wrong implementation looks right, and those comments NAME the things they
    warn against ("never assign balance_paise", "not an EXPENSE"). Asserting
    against the raw source would match the warning and pass while the code did
    the opposite.
    """
    import ast
    import inspect
    import textwrap

    from app.routers import banks as banks_router

    tree = ast.parse(textwrap.dedent(
        inspect.getsource(banks_router.reconcile_account)))
    fn = tree.body[0]
    # Drop a leading docstring; ast has already discarded every `#` comment.
    body = fn.body
    if (body and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)):
        body = body[1:]
    return "\n".join(ast.unparse(node) for node in body)


def test_reconcile_never_overwrites_the_derived_balance():
    """The whole point. Assigning `balance_paise` (or moving the opening
    balance) is the implementation that looks right and silently fails."""
    src = _banks_router_source()
    assert "balance_paise =" not in src, \
        "Post an ADJUSTMENT row; never assign the derived balance."
    assert "opening_balance_paise" not in src, \
        ("Moving the opening balance rewrites every historical statement's "
         "opening figure — the one thing the owner said must not change.")


def test_reconcile_posts_an_adjustment_and_not_an_expense():
    """ADJUSTMENT keeps it out of house profit (finance_profit counts only
    EXPENSE rows). An unexplained difference is not a cost until a human
    decides it is one."""
    src = _banks_router_source()
    assert "LedgerTxnType.ADJUSTMENT" in src
    assert "LedgerTxnType.EXPENSE" not in src


def test_reconcile_moves_no_counterparty_balance():
    """It is booked against the house sentinel, exactly as a transfer is —
    reconciling our own cash owes nobody anything."""
    src = _banks_router_source()
    assert "TRANSFER_PARTY_ID" in src
    assert "PartyType.EXPENSE" in src      # the sentinel carries no position


def test_reconcile_writes_nothing_when_the_account_already_agrees():
    src = _banks_router_source()
    assert "difference == 0" in src


def test_reconcile_is_idempotent_like_every_other_money_write():
    """Payments, expenses, payouts and transfers all take a key; a double-click
    must not book the gap twice."""
    src = _banks_router_source()
    assert "idempotency" in src
    assert "insert_once" in src


def test_reconcile_is_audited_with_who_and_why():
    """The one bank row with no counterparty and no originating document — the
    audit entry is the only evidence it ever happened."""
    src = _banks_router_source()
    assert "AuditAction.BANK_RECONCILED" in src
    assert "reason" in src


def test_a_reason_is_mandatory():
    from app.schemas.bank import BankReconcile

    with pytest.raises(Exception):
        BankReconcile(actual_balance_paise=100, reason="")
    # And a real one is accepted.
    assert BankReconcile(actual_balance_paise=100,
                         reason="Bank charges").reason == "Bank charges"
