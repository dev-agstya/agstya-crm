"""Tests for the rebuilt party statements (2026-07-23).

Two things matter here and neither needs a database:

* the pure helpers that decide what a statement SAYS — the reporting date, the
  ledger entry sign, the reward outcome word, the download filename;
* that the renderer actually produces a PDF for all three kinds, including the
  zero-activity case, and that an EXTERNAL statement never leaks house profit.
"""

from datetime import datetime, timezone

import pytest

from app.core.enums import LedgerTxnType, RewardStatus
from app.services import statement_pdf
from app.services.finance_balance import (
    _reward_state,
    ledger_entry,
    policy_date,
    statement_filename,
)

UTC = timezone.utc


class _Stub:
    def __init__(self, **kw):
        self.__dict__.update(kw)


# --- The reporting date (owner C3: always the cover's start date) -------------
def test_policy_date_prefers_start_date():
    pol = _Stub(start_date=datetime(2026, 4, 1, tzinfo=UTC),
                issue_date=datetime(2026, 4, 5, tzinfo=UTC))
    pf = _Stub(created_at=datetime(2026, 4, 9, tzinfo=UTC))
    assert policy_date(pol, pf) == datetime(2026, 4, 1, tzinfo=UTC)


def test_policy_date_falls_back_to_issue_then_entry():
    pf = _Stub(created_at=datetime(2026, 4, 9, tzinfo=UTC))
    issued = _Stub(start_date=None, issue_date=datetime(2026, 4, 5, tzinfo=UTC))
    assert policy_date(issued, pf) == datetime(2026, 4, 5, tzinfo=UTC)
    bare = _Stub(start_date=None, issue_date=None)
    assert policy_date(bare, pf) == datetime(2026, 4, 9, tzinfo=UTC)


def test_policy_date_makes_naive_dates_aware():
    pol = _Stub(start_date=datetime(2026, 4, 1), issue_date=None)
    pf = _Stub(created_at=datetime(2026, 4, 9, tzinfo=UTC))
    assert policy_date(pol, pf).tzinfo is not None


# --- Account ledger entries ---------------------------------------------------
_LABELS = {
    LedgerTxnType.PREMIUM_DUE: ("out", "Policy premium charged", 1),
    LedgerTxnType.PREMIUM_COLLECTED: ("in", "Payment received", -1),
    LedgerTxnType.ADJUSTMENT: ("in", "Adjustment", -1),
}


def test_ledger_entry_keeps_the_ledger_sign():
    # The running balance must be the ledger's own arithmetic: a charge adds,
    # a receipt subtracts, exactly as stored.
    assert ledger_entry(LedgerTxnType.PREMIUM_DUE, 50000, None, _LABELS) == \
        ("Policy premium charged", 50000)
    assert ledger_entry(
        LedgerTxnType.PREMIUM_COLLECTED, -50000, None, _LABELS) == \
        ("Payment received", -50000)


def test_ledger_entry_tags_a_same_type_reversal():
    label, delta = ledger_entry(
        LedgerTxnType.PREMIUM_COLLECTED, 50000, None, _LABELS)
    assert "(reversed)" in label
    assert delta == 50000        # sign still straight off the ledger


def test_ledger_entry_flips_a_swing_type_silently():
    # PREMIUM_DUE goes negative when the buyer is owed a discount back — that is
    # a normal entry, not a reversal, so it must not be tagged.
    label, delta = ledger_entry(
        LedgerTxnType.PREMIUM_DUE, -1200, None, _LABELS)
    assert "(reversed)" not in label
    assert delta == -1200


def test_ledger_entry_skips_zero_and_unknown_rows():
    assert ledger_entry(LedgerTxnType.PREMIUM_DUE, 0, None, _LABELS) is None
    assert ledger_entry(LedgerTxnType.EXPENSE, 100, None, _LABELS) is None


# --- Reward outcome wording ---------------------------------------------------
@pytest.mark.parametrize("status,expected", [
    (RewardStatus.PENDING, "Pending"),
    (RewardStatus.RECEIVED, "Payable"),
    (RewardStatus.CANCELLED, "Not eligible"),
    (RewardStatus.REJECTED, "Not eligible"),
    (RewardStatus.NOT_ELIGIBLE, "Not eligible"),
    (RewardStatus.ZERO_PCT, "Not eligible"),
    (RewardStatus.REFUNDED, "Not eligible"),
])
def test_reward_state_words(status, expected):
    reward = _Stub(status=status, paid_out_at=None, wallet_available=False)
    assert _reward_state(reward) == expected


def test_reward_state_paid_wins_over_status():
    reward = _Stub(status=RewardStatus.RECEIVED,
                   paid_out_at=datetime(2026, 5, 1, tzinfo=UTC),
                   wallet_available=True)
    assert _reward_state(reward) == "Paid"


def test_reward_state_missing_reward_is_pending():
    assert _reward_state(None) == "Pending"


# --- Download filenames (owner B5.1: CP_statement_name_id) --------------------
def test_statement_filename_per_section():
    assert statement_filename(
        "partner", "Mahendra Pratap Singh", "CP-AA00012", "x") \
        == "CP_statement_Mahendra_Pratap_Singh_CP-AA00012.pdf"
    assert statement_filename("broker", "Alliance Brokers", "ALB", "x") \
        == "BRK_statement_Alliance_Brokers_ALB.pdf"
    assert statement_filename("customer", "Priya Sharma",
                              "AG-CX-26-000042", "x") \
        == "CUS_statement_Priya_Sharma_AG-CX-26-000042.pdf"


def test_statement_filename_strips_unsafe_characters():
    name = statement_filename("customer", 'M/s "Vardhman" Textiles Pvt. Ltd',
                              None, "656f1a")
    # Unsafe characters become separators, so "M/s" reads as "M_s".
    assert name == "CUS_statement_M_s_Vardhman_Textiles_Pvt_Ltd_656f1a.pdf"
    for ch in '/\\"<>:|?*':
        assert ch not in name


# --- Money formatting ---------------------------------------------------------
@pytest.mark.parametrize("paise,expected", [
    (0, "0.00"),
    (99, "0.99"),
    (100000, "1,000.00"),
    (10000000, "1,00,000.00"),          # Indian grouping, not 100,000.00
    (123456789, "12,34,567.89"),
    (100000000000, "1,00,00,00,000.00"),
])
def test_indian_digit_grouping(paise, expected):
    assert statement_pdf._Money().plain(paise) == expected


def test_signed_keeps_a_credit_balance_negative():
    # A running-balance column that drops the sign prints a credit as a debit.
    money = statement_pdf._Money()
    assert money.signed(-166826) == "-1,668.26"
    assert money.signed(166826) == "1,668.26"


def test_whole_rupees_round_and_drop_paise():
    assert statement_pdf._Money().whole(227773960) == "22,77,740"


# --- Rendering ----------------------------------------------------------------
def _policy_row(**over):
    row = {
        "date": datetime(2026, 4, 3, tzinfo=UTC),
        "month_key": "2026-04", "month_label": "Apr 2026",
        "policy_number": "AG-POL-100000", "customer": "Priya Sharma",
        "insurer": "HDFC ERGO", "partner": "Direct", "category": "Motor",
        "premium": 5000000, "reward_base": 4237288, "reward_base_note": None,
        "reward_pct": 12.5, "reward": 529661, "tds": 26483, "profit": 317797,
        "premium_by": "Agency", "reward_state": "Payable",
        "sum_insured": 200000000,
        "valid_till": datetime(2027, 4, 2, tzinfo=UTC),
        "discount": 50000, "net_payable": 4950000, "paid": 2000000,
        "balance": 2950000, "status": "Active",
    }
    row.update(over)
    return row


def _account(rows=1):
    return {
        "rows": [{
            "date": datetime(2026, 4, 20, tzinfo=UTC),
            "label": "Payment received", "reference": "UTR900001",
            "policy": None, "debit": 0, "credit": 2000000,
            "balance": -2000000,
        }][:rows],
        "total_debit": 0, "total_credit": 2000000 * rows,
        "closing": -2000000 * rows,
    }


def _base(kind, **over):
    data = {
        "kind": kind, "label": "Test Party", "code": "TP-1",
        "date_from": datetime(2026, 4, 1, tzinfo=UTC),
        "date_to": datetime(2027, 3, 31, tzinfo=UTC),
        "period_label": "FY 2026-27", "statement_no": None,
        "opening_balance": 0, "policies": [_policy_row()],
        "by_category": [{"label": "Motor", "policies": 1,
                         "premium": 5000000, "reward": 529661}],
        "account": _account(), "net_balance": 250000,
    }
    data.update(over)
    return data


BROKER = _base("broker", audience="internal", tds_percent=500,
               total_premium=5000000, total_reward_base=4237288,
               total_reward=529661, total_tds=26483, total_profit=317797,
               reward_received=100000, reward_expected_all_time=529661,
               reward_received_all_time=100000, reward_pending=429661)
PARTNER = _base("partner", audience="external", mobile="+919829011223",
                total_premium=5000000, total_reward=211864,
                premium_by_us=5000000,
                combined_account={
                    "rows": [{
                        "date": datetime(2026, 4, 20, tzinfo=UTC),
                        "label": "Reward earned", "reference": None,
                        "policy": "AG-POL-100000",
                        "credit": 211864, "debit": 0, "balance": 211864,
                    }],
                    "opening": 0, "total_credit": 211864, "total_debit": 0,
                    "closing": 211864},
                premium_balance=0, reward_owed=211864,
                reward_available=211864)
CUSTOMER = _base("customer", audience="external", mobile="+919414055667",
                 address="14, Hiran Magri, Udaipur",
                 total_premium=5000000, total_discount=50000,
                 total_net_payable=4950000, total_paid=2000000)


@pytest.mark.parametrize("data", [BROKER, PARTNER, CUSTOMER],
                         ids=["broker", "partner", "customer"])
def test_renders_a_pdf(data):
    out = statement_pdf.render_statement_pdf(data)
    assert out.startswith(b"%PDF")
    assert len(out) > 2000


@pytest.mark.parametrize("kind,extra", [
    ("broker", {"tds_percent": 500, "total_premium": 0,
                "total_reward_base": 0, "total_reward": 0, "total_tds": 0,
                "total_profit": 0, "reward_received": 0,
                "reward_expected_all_time": 0, "reward_received_all_time": 0,
                "reward_pending": 0}),
    ("partner", {"total_premium": 0, "total_reward": 0, "premium_by_us": 0,
                 "reward_account": {"rows": [], "opening": 0,
                                    "total_earned": 0, "total_paid": 0},
                 "premium_balance": 0, "reward_owed": 0,
                 "reward_available": 0}),
    ("customer", {"total_premium": 0, "total_discount": 0,
                  "total_net_payable": 0, "total_paid": 0}),
])
def test_zero_activity_statement_still_renders(kind, extra):
    # Owner C9: a quiet account is a legitimate statement to send — it shows the
    # standing balance rather than refusing to generate.
    data = _base(kind, audience="internal" if kind == "broker" else "external",
                 policies=[], by_category=[],
                 account={"rows": [], "total_debit": 0, "total_credit": 0,
                          "closing": 250000},
                 opening_balance=250000, **extra)
    assert statement_pdf.render_statement_pdf(data).startswith(b"%PDF")


def test_long_statement_paginates_and_keeps_a_page_count():
    data = dict(BROKER, policies=[_policy_row() for _ in range(60)])
    pdf = statement_pdf._Statement(data)
    pdf.add_page()
    statement_pdf._render_broker(pdf, data)
    assert pdf.page_no() > 1, "60 policies should spill past one page"


def test_external_statements_never_carry_house_profit():
    """A partner/customer statement is handed out. Whatever else changes, the
    agency's own margin must not appear on it (owner 2026-07-23)."""
    for data in (PARTNER, CUSTOMER):
        rendered = _rendered_text(data)
        assert "Net Profit" not in rendered
        assert "profit" not in rendered.lower()


def _rendered_text(data: dict) -> str:
    """All literal text the renderer emits, captured off the pdf's cell calls.

    Cheaper and more robust than parsing the PDF back out, and enough to assert
    that a label never reaches an external document."""
    seen: list[str] = []
    pdf = statement_pdf._Statement(data)
    for name in ("cell", "multi_cell"):
        original = getattr(pdf, name)

        def wrapper(*args, _orig=original, **kwargs):
            for arg in args:
                if isinstance(arg, str):
                    seen.append(arg)
            txt = kwargs.get("text") or kwargs.get("txt")
            if isinstance(txt, str):
                seen.append(txt)
            return _orig(*args, **kwargs)

        setattr(pdf, name, wrapper)

    pdf.add_page()
    renderer = {"broker": statement_pdf._render_broker,
                "partner": statement_pdf._render_partner,
                "customer": statement_pdf._render_customer}[data["kind"]]
    renderer(pdf, data)
    return "\n".join(seen)


def test_the_capture_helper_would_catch_a_leak():
    # Guards the guard: the broker statement DOES carry profit, so if this
    # assertion ever fails the leak test above has stopped looking at anything.
    assert "Net Profit" in _rendered_text(BROKER)


# --- Redesign 2026-07-24: flat tables, "Transactions", no summary-by-type -----
def test_statement_no_is_dropped_from_every_kind():
    for data in (BROKER, PARTNER, CUSTOMER):
        assert "Statement No." not in _rendered_text(data)


def test_no_kind_shows_summary_by_policy_type():
    for data in (BROKER, PARTNER, CUSTOMER):
        assert "Summary by policy type" not in _rendered_text(data)


def test_no_kind_advertises_grouping():
    for data in (BROKER, PARTNER, CUSTOMER):
        text = _rendered_text(data)
        assert "Grouped by" not in text


def test_ledger_section_is_titled_transactions():
    for data in (BROKER, PARTNER, CUSTOMER):
        assert "Transactions" in _rendered_text(data)


def test_broker_policy_table_has_a_type_column():
    text = _rendered_text(BROKER)
    assert "Type" in text          # the un-grouped table names the type per row


def test_partner_shows_per_policy_reward_percent():
    text = _rendered_text(PARTNER)
    assert "Reward %" in text


def test_partner_uses_one_combined_ledger_not_two_accounts():
    text = _rendered_text(PARTNER)
    # The old two-account layout is gone; a single netted ledger remains.
    assert "Your reward account" not in text
    assert "Your premium account" not in text
    assert "What this comes to" not in text
    assert "Credit (+)" in text and "Debit (-)" in text
