"""Correcting money that was recorded wrongly, and unwinding it cleanly.

Four separate bugs, one theme: the app was good at RECORDING money and had gaps
everywhere in taking it back.

  F1  Deleting a policy removed its ledger rows without backing the money off
      the BANK ACCOUNT. Collect ₹50,000 into HDFC, delete the policy, and Bank &
      Cash reported the ₹50,000 for ever with nothing behind it. Silent.
  F2  A transaction posted to the wrong bank account could never be moved.
      Expenses could; nothing else could.
  F3  A transaction posted against the wrong PARTY could never be moved either,
      so a receipt keyed against the wrong customer left two balances wrong.
  F19 Re-uploading an attachment orphaned the previous file in S3 for ever.

These are source-level assertions rather than round trips. What went wrong in
every case was a MISSING CALL — nothing threw, nothing logged, the numbers were
just quietly wrong — so "is the call there, in the right order" is exactly the
right thing to pin.
"""

from __future__ import annotations

import inspect

from app.routers import finance as finance_router
from app.routers import policies as policies_router
from app.schemas.finance import LedgerTxnUpdate


# --- F1: deleting a policy must not leave money in a bank account ---------------


def test_deleting_a_policy_unposts_its_bank_deltas():
    """The ledger row's effect is TWO things: the counterparty's balance, which
    is rebuilt from the rows that remain, and the bank account's cached running
    total, which is NOT rebuilt by anything here. Deleting without unposting
    leaves an account holding money whose evidence has just been deleted."""
    source = inspect.getsource(policies_router.delete_policy)
    assert "bank_svc.unpost(t)" in source


def test_the_unpost_happens_BEFORE_the_row_is_deleted():
    """`unpost` reads `bank_delta_paise` and `bank_account_id` OFF the row. Do
    it after `t.delete()` and there is nothing left to read, so it silently
    becomes a no-op — the exact bug, one line further down."""
    source = inspect.getsource(policies_router.delete_policy)
    assert source.index("bank_svc.unpost(t)") < source.index("await t.delete()")


def test_the_single_row_delete_path_already_did_this():
    """Proof the rule was known and one call site missed it — which is the whole
    argument for pinning it rather than fixing it and moving on."""
    source = inspect.getsource(finance_router.delete_ledger_txn)
    assert "bank_svc.unpost(txn)" in source


# --- F2 / F3: re-filing a transaction --------------------------------------------


def test_a_transaction_can_be_moved_to_a_different_bank_account():
    assert "bank_account_id" in LedgerTxnUpdate.model_fields


def test_a_transaction_can_be_moved_to_a_different_party():
    for field in ("party_type", "party_id"):
        assert field in LedgerTxnUpdate.model_fields


def test_moving_a_party_requires_BOTH_halves():
    """A party_id is only meaningful next to its type. Accepting one alone would
    let a customer id be filed under PartyType.BROKER, which is a balance on a
    record that does not exist."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "(payload.party_type is None) != (payload.party_id is None)" in source


def test_moving_a_party_recomputes_BOTH_balances():
    """The one it lands on AND the one it leaves. Recomputing only the new party
    leaves the money still counted against someone it no longer concerns — which
    is a worse state than the mistake being corrected."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "old_party" in source
    assert "recompute_party_account(*old_party)" in source


def test_a_party_that_does_not_exist_is_refused():
    """An id that resolves to nothing would move the money onto a balance nobody
    can ever open."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "_party_exists" in source


def test_a_transaction_cannot_be_re_filed_onto_the_house():
    """PartyType.EXPENSE carries no counterparty position; the expense editor
    owns the category and the payee. Allowing it here would produce an expense
    with no category, invisible to every per-category total."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "PartyType.EXPENSE" in source


def test_moving_an_account_backs_the_money_off_the_OLD_one():
    """`repost` unposts using the id currently on the row. Save the new id first
    and it credits the wrong account — taking money off the account the payment
    is being moved TO, and leaving the one it came from untouched."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "txn.bank_account_id = txn.bank_account_id, old_account" in source \
        or "new_account, txn.bank_account_id = txn.bank_account_id, old_account" \
        in source


def test_an_empty_account_id_clears_rather_than_being_ignored():
    """None means "leave it alone" and "" means "detach". Without the
    distinction a legacy row could never be given an account OR have one
    removed, because both read as "unset"."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "payload.bank_account_id is not None" in source
    assert ".strip() or None" in source


# --- F19: replacing an attachment --------------------------------------------------


def test_replacing_an_attachment_removes_the_previous_file():
    """A row holds exactly one `attachment_doc_id`, so a second upload orphaned
    the first — its record and its S3 object stayed for ever, unreferenced and
    unreachable."""
    source = inspect.getsource(finance_router.upload_txn_attachment)
    assert "previous_id" in source
    assert "s3.delete_object" in source


def test_the_new_file_is_pointed_at_BEFORE_the_old_one_is_removed():
    """If it crashes in between, the row keeps a file that exists. The reverse
    order leaves a transaction pointing at nothing, which is the direction that
    loses evidence rather than leaking a byte of storage."""
    source = inspect.getsource(finance_router.upload_txn_attachment)
    assert source.index("await txn.save()") < source.index("s3.delete_object")


# --- F7: an expense is a first-class transaction ------------------------------------


def test_the_expense_editor_owns_the_category_and_the_payee():
    """`LedgerTxnUpdate` has no field for either, and the Transactions page sent
    every edit through it — so an expense could be corrected on its amount and
    its date and on nothing that made it an expense."""
    from app.schemas.finance import ExpenseUpdate

    assert "category" in ExpenseUpdate.model_fields
    assert "paid_to_employee_id" in ExpenseUpdate.model_fields
    assert "category" not in LedgerTxnUpdate.model_fields


def test_the_generic_editor_refuses_to_re_file_a_row_as_an_expense():
    """The two endpoints are not interchangeable, and this is the guard that
    says so: an expense re-filed through the generic path would end up with no
    category, invisible to every per-category total."""
    source = inspect.getsource(finance_router.edit_ledger_txn)
    assert "Edit it as an" in source


# --- The shared posting paths ------------------------------------------------------


def test_the_bulk_importer_posts_through_the_SAME_functions():
    """The bank-statement import books rows through `_post_payment` /
    `_post_expense` / `post_agency_payout` rather than through copies.

    That is where the TDS split on a reward receipt happens, where the bank delta
    is derived from the transaction TYPE rather than the stored sign, and where
    the idempotency key is honoured. A bulk importer with its own version of any
    one of those would drift within a release, and two screens would then
    disagree about the same money.
    """
    from app.routers import statement_import as importer

    source = inspect.getsource(importer._commit_row)
    assert "_post_payment" in source
    assert "_post_expense" in source
    assert "post_agency_payout" in source
    # And no posting of its own.
    for forbidden in ("LedgerTxn(", "apply_delta", "record_ledger_txn"):
        assert forbidden not in source


def test_paying_a_partner_goes_through_the_wallet_not_a_plain_ledger_row():
    """A payout draws on the partner's reward balance first and books anything
    above it as an advance they owe back. Deriving it as an ordinary outbound
    row would skip the wallet entirely and leave the reward still showing as
    owed."""
    from app.routers import statement_import as importer

    from app.core.enums import PartyType

    assert ("out", PartyType.CHANNEL_PARTNER) not in importer._TYPE_BY_PARTY
    assert "post_agency_payout" in inspect.getsource(importer._commit_row)


def test_one_bad_row_does_not_unwind_the_rows_that_worked():
    """Partial success is the design. Forty rows keyed by hand, refused at row
    38 because one party was deactivated in the meantime, is how an importer
    stops being used — and the rows that DID post are real money movements a
    rollback would have to un-post."""
    from app.routers import statement_import as importer

    source = inspect.getsource(importer.commit_statement)
    assert "failures.append" in source
    assert "except Exception" in source
