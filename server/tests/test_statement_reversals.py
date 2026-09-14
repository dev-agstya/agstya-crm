"""Pure-logic tests for same-type ledger reversals on statements.

Cancelling a transaction now posts an equal-and-opposite row OF THE SAME TYPE
(so cash aggregates net out); a statement must show that row flipped
("in" <-> "out") and tagged as reversed, never as a second normal movement.
"""

from app.services.finance_balance import statement_txn_row

_PREMIUM_COLLECTED = ("in", "Premium received", -1)
_REFUND = ("out", "Refund paid", 1)
_ADJUSTMENT = ("in", "Adjustment", -1)


def test_normal_collection_is_in():
    assert statement_txn_row(_PREMIUM_COLLECTED, -50000, None) == \
        ("in", "Premium received", 50000)


def test_reversed_collection_flips_to_out_and_is_tagged():
    direction, label, amt = statement_txn_row(_PREMIUM_COLLECTED, 50000, None)
    assert direction == "out"
    assert "(reversed)" in label
    assert amt == 50000


def test_normal_refund_is_out():
    assert statement_txn_row(_REFUND, 20000, None) == \
        ("out", "Refund paid", 20000)


def test_reversed_refund_flips_to_in():
    direction, label, amt = statement_txn_row(_REFUND, -20000, None)
    assert (direction, amt) == ("in", 20000)
    assert "(reversed)" in label


def test_adjustment_flips_by_sign_without_reversed_tag():
    direction, label, _ = statement_txn_row(
        _ADJUSTMENT, 10000, None, is_adjustment=True)
    assert direction == "out"
    assert "(reversed)" not in label


def test_zero_rows_are_dropped():
    assert statement_txn_row(_PREMIUM_COLLECTED, 0, None) is None


def test_note_wins_for_normal_rows():
    assert statement_txn_row(_PREMIUM_COLLECTED, -100, "UPI collection")[1] \
        == "UPI collection"
