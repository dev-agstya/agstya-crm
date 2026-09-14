"""Parking a statement line instead of throwing it away.

WHAT CHANGED (owner 2026-08-24)
--------------------------------
The bank-statement importer opened every row on SKIP, counted the skips in the
result, and threw them away with the browser tab. That is right for a line which
genuinely is not ours and quietly wrong for the far more common case:

    "instead of skip, I want you to add one thing called pending... it will
    record eight transactions, but it will push those two pending transactions
    into a pending transaction list, so that the owner can come back later and
    fix those transactions."

And the cross, with its confirmation:

    "instead of a skip button, add at the top right corner a cross button so
    that we can remove that transaction from there. However, removing any
    transaction from this import list should also send one pop-up and ask for
    confirmation because we don't want to delete any of the transactions
    actually."

THE TWO RULES THESE TESTS EXIST TO HOLD
----------------------------------------
  1. THE QUEUE HAS NO POSTING LOGIC. A pending row is booked by
     `statement_import._commit_row` — the same function the importer's own rows
     go through. Two copies would mean the same statement line books differently
     depending on which day somebody got round to it.
  2. NOTHING IS DELETED. Discarding is a status with a name, a date and a
     reason, and it is reversible. A dismissed statement line is precisely the
     line somebody asks about six months later.
"""

from __future__ import annotations

import ast
import inspect

from app.models.pending_txn import PendingTransaction, PendingTxnStatus
from app.routers import pending_txns as queue
from app.routers import statement_import as si


def row(**kw) -> PendingTransaction:
    fields = dict(
        bank_account_id="acc1", bank_account_name="HDFC",
        import_batch_id="b1", source_file="aug.csv",
        occurred_on="2026-08-14", description="NEFT-RAMESH KUMAR",
        reference="N123", amount_paise=1_240_000, direction="in",
        source_line=7, duplicate_of=None, duplicate_note=None,
        suggested_terms=["RAMESH"], note=None,
        status=PendingTxnStatus.PENDING)
    fields.update(kw)
    return PendingTransaction.model_construct(**fields)


# =============================================================================
# "Pending" replaced "skip" as the DEFAULT
# =============================================================================


def test_a_row_defaults_to_pending_not_skipped():
    """The default is the whole change. A client that sends a row with no
    `action` — an older tab, a retried request — must now PARK it rather than
    discard it, because the safe failure for an undecided statement line is
    "somebody looks at this" and not "it never existed"."""
    assert si.CommitRow.model_fields["action"].default == "pending"


def test_skip_still_exists_and_is_still_honoured():
    """The importer defaults a row it believes is already recorded to "leave it
    alone", and that IS a decision rather than an unanswered question. Parking
    a known duplicate would put noise into a queue of real work."""
    src = inspect.getsource(si.commit_statement)
    assert 'row.action == "skip"' in src
    assert 'row.action == "pending"' in src


def test_the_commit_result_counts_pending_apart_from_skipped():
    """They mean opposite things — one is work outstanding, the other is work
    deliberately not done — so a single "not imported" number would hide the
    only one that needs following up."""
    fields = si.CommitResult.model_fields
    assert "pending" in fields and "skipped" in fields


def test_the_result_message_says_where_the_parked_rows_went():
    """A row parked into a queue nobody is told about is a row thrown away with
    extra steps."""
    src = inspect.getsource(si.commit_statement)
    assert "Pending list" in src


def test_parking_a_row_keeps_the_narration():
    """The file is gone the moment the tab closes. A pending row that says
    "Rs 12,400, 14 August" and nothing else is unanswerable, which makes it a
    row that sits in the queue for ever."""
    assert "description" in si.CommitRow.model_fields
    assert "description" in PendingTransaction.model_fields
    src = inspect.getsource(si._park_row)
    for carried in ("description", "duplicate_of", "suggested_terms",
                    "reference", "occurred_on"):
        assert carried in src, carried


def test_parking_carries_the_account_because_a_statement_does_not_name_one():
    """The account is what the FILE is, not a property of the row — and the file
    is long gone by the time anybody works the queue, so it is frozen on."""
    assert "bank_account_id" in PendingTransaction.model_fields
    assert "bank_account_name" in PendingTransaction.model_fields


def test_parking_writes_no_money():
    """A pending row is a to-do list that happens to be shaped like money.
    Nothing about it reaches the ledger, a party balance, or the bank account's
    cached running total."""
    src = inspect.getsource(si._park_row)
    for banned in ("LedgerTxn", "apply_delta", "bank_delta", "_post_payment",
                   "_post_expense", "recompute_party_account"):
        assert banned not in src, banned


# =============================================================================
# Deciding one goes through the importer's own path
# =============================================================================


def test_the_queue_books_through_commit_row_and_nothing_else():
    """THE rule of this module. `_commit_row` is itself only a shim over
    `finance._post_payment`, `finance._post_expense` and
    `wallet.post_agency_payout`, which own the TDS split, the bank delta and the
    idempotency key."""
    src = inspect.getsource(queue.resolve)
    assert "_commit_row" in src
    for banned in ("LedgerTxn(", "apply_delta", "PartyAccount",
                   "post_agency_payout", "_post_expense("):
        assert banned not in src, (
            f"routers/pending_txns reaches {banned} directly. Everything about "
            f"posting belongs to statement_import._commit_row.")


def test_the_queue_speaks_the_importers_vocabulary():
    """`action`, `party_type`, `party_id`, `expense_category` — the same names
    the importer uses, because the SAME screen component renders both and the
    same server function books both. Two vocabularies for one decision is how
    the two screens start behaving differently."""
    shared = {"action", "party_type", "party_id", "expense_category",
              "policy_id", "txn_type", "idempotency_key", "reference", "note"}
    assert shared <= set(queue.ResolveRow.model_fields)
    assert shared <= set(si.CommitRow.model_fields)


def test_a_row_is_marked_recorded_only_AFTER_its_ledger_row_exists():
    """If the post throws, the pending row is untouched and is still in the
    queue — which is the correct state, because the work is not done. Marking it
    first and posting second would lose the line on any failure."""
    fn = ast.parse(inspect.getsource(queue.resolve)).body[0]
    body = ast.unparse(fn)
    assert body.index("_commit_row") < body.index("PendingTxnStatus.RECORDED")


def test_partial_success_is_reported_by_row():
    """Same design as the importer: forty rows keyed by hand and refused at row
    38 because one party was deactivated is how a feature stops being used. And
    the rows that DID post are real money movements a rollback would have to
    un-post."""
    assert "failed" in queue.ResolveResult.model_fields
    assert set(queue.ResolveFailure.model_fields) == {"id", "reason"}


def test_a_row_already_dealt_with_cannot_be_booked_twice():
    src = inspect.getsource(queue.resolve)
    assert "row.is_open" in src
    assert row(status=PendingTxnStatus.RECORDED).is_open is False
    assert row(status=PendingTxnStatus.DISCARDED).is_open is False
    assert row().is_open is True


# =============================================================================
# Removing one is recorded, reversible, and never a delete
# =============================================================================


def test_discarding_needs_a_reason():
    """The owner asked for a confirmation dialog because "we don't want to
    delete any of the transactions actually". The dialog is the client's half;
    the reason is the server's — a row that vanished with no explanation is the
    thing the dialog was protecting against."""
    field = queue.DiscardIn.model_fields["reason"]
    assert field.is_required()
    # min_length 3 rather than 1, so a single keystroke does not satisfy it.
    limits = [m for m in field.metadata if getattr(m, "min_length", None)]
    assert limits and limits[0].min_length >= 3


def test_discarding_does_not_delete_the_document():
    """A DELETE verb on a route that does not delete looks wrong for a second
    and is right: it is the verb for "make this go away from my queue"."""
    body = ast.unparse(ast.parse(inspect.getsource(queue.discard)))
    assert "PendingTxnStatus.DISCARDED" in body
    assert ".delete()" not in body


def test_a_discarded_row_records_who_and_why():
    for field in ("discarded_at", "discarded_by", "discarded_by_name",
                  "discard_reason"):
        assert field in PendingTransaction.model_fields, field


def test_a_discarded_row_can_be_put_back():
    """The whole reason discarding is a status rather than a delete. The
    alternative to this button is re-importing the statement and re-deciding
    every other line in it."""
    src = inspect.getsource(queue.restore)
    assert "PendingTxnStatus.PENDING" in src
    assert "discard_reason = None" in src


def test_nothing_the_bank_said_is_editable():
    """Direction especially: if the statement says the money left, it left. The
    only editable field is the note somebody leaves themselves."""
    assert set(queue.UpdateNoteIn.model_fields) == {"note"}


# =============================================================================
# The queue itself
# =============================================================================


def test_the_queue_opens_on_OPEN_rows():
    """It is a to-do list, and a to-do list that opens on everything you have
    ever done is one nobody opens twice."""
    assert queue.list_pending.__defaults__ is not None
    sig = inspect.signature(queue.list_pending)
    assert sig.parameters["status_filter"].default.default \
        == PendingTxnStatus.PENDING


def test_the_badge_count_ignores_the_filter_in_force():
    """Otherwise the badge goes to zero the moment somebody looks at the
    discarded rows, which reads as the queue having been cleared."""
    src = inspect.getsource(queue.list_pending)
    assert 'open_count = await PendingTransaction.find(' in src
    assert '{"status": PendingTxnStatus.PENDING}' in src


def test_money_in_and_out_are_reported_separately_not_netted():
    """A queue holding a Rs 50,000 receipt and a Rs 50,000 payment nets to zero,
    which would read as "nothing outstanding" when two real transactions are
    missing from the books."""
    fields = queue.PendingList.model_fields
    assert "in_paise" in fields and "out_paise" in fields
    assert "net_paise" not in fields


def test_the_count_endpoint_is_registered_before_the_dynamic_one():
    """A static path declared after a dynamic one is shadowed by it — this
    codebase's oldest routing scar — and "count" would be looked up as an
    object id."""
    paths = [r.path for r in queue.router.routes]
    assert paths.index("/api/finance/pending-transactions/count") \
        < paths.index("/api/finance/pending-transactions/{pending_id}")


def test_rows_are_grouped_by_the_import_they_came_from():
    """A person works a FILE, not forty unrelated rows: "Tuesday's HDFC
    statement, six left" is a task with an end."""
    assert "batches" in queue.PendingList.model_fields
    rows = [row(import_batch_id="b1", occurred_on="2026-08-14"),
            row(import_batch_id="b1", occurred_on="2026-08-02", direction="out",
                amount_paise=500_000),
            row(import_batch_id="b2", occurred_on="2026-07-30")]
    batches = queue._batches(rows)
    by_id = {b.import_batch_id: b for b in batches}
    assert by_id["b1"].open_count == 2
    assert by_id["b1"].net_paise == 1_240_000 - 500_000
    assert by_id["b1"].first_date == "2026-08-02"
    assert by_id["b1"].last_date == "2026-08-14"
    # Newest batch first — the one somebody just imported is the one they are
    # about to work.
    assert batches[0].import_batch_id == "b1"


def test_a_closed_row_does_not_count_towards_a_batchs_outstanding_work():
    rows = [row(import_batch_id="b1"),
            row(import_batch_id="b1", status=PendingTxnStatus.RECORDED)]
    assert queue._batches(rows)[0].open_count == 1


# =============================================================================
# The boundary
# =============================================================================


def test_the_queue_is_staff_only_at_router_level():
    """Same rule every money router follows, so a new route added here is closed
    to channel partners by default."""
    from app.core.dependencies import get_inhouse_user

    deps = [getattr(d, "dependency", None) for d in queue.router.dependencies]
    assert get_inhouse_user in deps


def test_there_is_no_unique_index_on_a_pending_row():
    """Two genuine Rs 5,000 cash deposits on the same day into the same account
    are a real thing that happens — the importer's duplicate detection is a FLAG
    for the same reason, and a constraint here would make real data
    un-parkable."""
    for index in PendingTransaction.Settings.indexes:
        assert not getattr(index, "document", {}).get("unique"), index
