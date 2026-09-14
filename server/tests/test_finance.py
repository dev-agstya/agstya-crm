"""Finance-engine scenario tests (pure maths, no DB) — the S1–S6 cases from the
plan. All money in paise.

Base figures reused across scenarios:
  gross premium ₹10,000        = 1_000_000 paise
  agency reward ₹3,300 (33%)   =   330_000 paise
  partner share ₹2,500 (25%)   =   250_000 paise
"""

from app.core.enums import PayerType, RewardBasis, SettlementStatus
from app.services.finance_balance import has_live_position
from app.services.finance import (
    compute_finance,
    discount_amount,
    party_balance,
    policy_premium_due,
    premium_receivable,
    settlement_status,
)


def test_premium_receivable_nets_discount_when_agency_pays():
    # Agency fronted 1000 with a 100 discount -> collect 900 from the buyer.
    assert premium_receivable(PayerType.AGENCY, 1000, 100) == 900
    assert premium_receivable(PayerType.AGENCY, 1000, 0) == 1000
    # Buyer paid the insurer directly -> nothing to collect.
    assert premium_receivable(PayerType.CUSTOMER, 1000, 100) == 0
    assert premium_receivable(PayerType.CHANNEL_PARTNER, 1000, 0) == 0


def test_policy_premium_due_signs():
    # Agency fronted -> buyer owes premium minus discount.
    assert policy_premium_due(PayerType.AGENCY, 1000, 100) == 900
    assert policy_premium_due(PayerType.AGENCY, 1000, 0) == 1000
    # Buyer paid the insurer but is owed the discount back -> negative (payable).
    assert policy_premium_due(PayerType.CUSTOMER, 1000, 100) == -100
    # Buyer paid, no discount -> nothing to settle.
    assert policy_premium_due(PayerType.CUSTOMER, 1000, 0) == 0
    assert policy_premium_due(PayerType.CHANNEL_PARTNER, 1000, 0) == 0

GROSS = 1_000_000
COMMISSIONABLE = 847_458
AGENCY = 330_000
PARTNER = 250_000


def _finance(*, partner=0, discount_basis=RewardBasis.PERCENT, discount_value=0):
    return compute_finance(
        gross_premium=GROSS, commissionable=COMMISSIONABLE,
        agency_reward=AGENCY, partner_share=partner,
        discount_basis=discount_basis, discount_value=discount_value)


def test_s1_direct_agency_paid_no_discount():
    # House keeps the whole agency reward; agency fronted premium -> receivable.
    f = _finance()
    assert f.house_profit == AGENCY
    assert f.discount == 0
    receivable = premium_receivable(PayerType.AGENCY, GROSS)
    assert receivable == GROSS
    assert settlement_status(receivable, 0) == SettlementStatus.PENDING


def test_s2_direct_customer_paid_no_receivable():
    f = _finance()
    assert f.house_profit == AGENCY
    receivable = premium_receivable(PayerType.CUSTOMER, GROSS)
    assert receivable == 0
    # Nothing to collect -> already settled.
    assert settlement_status(receivable, 0) == SettlementStatus.SETTLED


def test_s3_direct_flat_discount():
    f = _finance(discount_basis=RewardBasis.FLAT, discount_value=50_000)  # ₹500
    assert f.discount == 50_000
    assert f.house_profit == AGENCY - 50_000


def test_s3_direct_percent_discount():
    f = _finance(discount_basis=RewardBasis.PERCENT, discount_value=500)  # 5%
    assert f.discount == 50_000       # 5% of ₹10,000
    assert f.house_profit == AGENCY - 50_000


def test_s4_channel_partner_shares_reward():
    f = _finance(partner=PARTNER)
    assert f.partner_share == PARTNER
    assert f.house_profit == AGENCY - PARTNER          # 80,000


def test_s5_partner_short_pays_opens_receivable():
    # Agency paid the insurer ₹50,000; partner remitted only ₹45,000.
    postings = [+5_000_000, -4_500_000]
    assert party_balance(postings) == 500_000          # ₹5,000 receivable
    # House P&L is unaffected by the cash shortfall.
    f = _finance(partner=PARTNER)
    assert f.house_profit == AGENCY - PARTNER


def test_s6_part_payments_track_running_balance():
    # Fronted ₹50,000, then two ₹20,000 remittances over time.
    ledger = [+5_000_000, -2_000_000, -2_000_000]
    assert party_balance(ledger) == 1_000_000          # ₹10,000 still due
    assert settlement_status(5_000_000, 4_000_000) == SettlementStatus.PARTIAL
    assert settlement_status(5_000_000, 5_000_000) == SettlementStatus.SETTLED


def test_discount_amount_guards():
    assert discount_amount(0, RewardBasis.PERCENT, 500) == 0
    assert discount_amount(GROSS, RewardBasis.PERCENT, 0) == 0
    assert discount_amount(GROSS, RewardBasis.FLAT, 50_000) == 50_000


# --- Broker net balance (owner bug 2026-07-15: receipt read as a payable) ----
def test_broker_net_balance_receipt_clears_receivable():
    from app.services.finance_balance import broker_net_balance

    # Policy booked: ₹1,500 reward expected, nothing received, no other rows.
    assert broker_net_balance(150_000, 0, 0) == 150_000
    # The ₹1,500 receipt posts −150000 to the broker ledger: net must be 0,
    # NOT a ₹1,500 payable.
    assert broker_net_balance(150_000, 150_000, -150_000) == 0
    # Partial receipt leaves the remainder to collect.
    assert broker_net_balance(150_000, 50_000, -50_000) == 100_000


def test_broker_net_balance_over_receipt_floors_at_zero():
    from app.services.finance_balance import broker_net_balance

    # Over-receive (test 3.5): reward side floors at 0, never negative.
    assert broker_net_balance(150_000, 5_000_000, -5_000_000) == 0


def test_broker_net_balance_keeps_real_ledger_positions():
    from app.services.finance_balance import broker_net_balance

    # A manual "premium → broker" row (+20000) is a real position and must
    # survive alongside the receipt-cleared reward.
    assert broker_net_balance(150_000, 150_000, -150_000 + 20_000) == 20_000


# --- Balance-sheet row inclusion (2026-07-30 regression) ---------------------
# Volume is windowed, position is not. A party with an open balance but no
# policies inside the date filter must still be listed — brokers already did
# this via their all-time `expected` union, but partners and customers were
# keyed off the windowed aggregate alone and silently dropped off the tab.

def test_live_position_keeps_a_party_on_the_balance_sheet():
    # Partner owing premium with an unpaid reward wallet -> listed.
    assert has_live_position(1_180_000, 50_000, 0)
    # Wallet alone is enough (premium settled, reward still owed).
    assert has_live_position(0, 50_000, 0)
    # A payable (negative balance) is a position too.
    assert has_live_position(-100_000, 0, 0)
    # Customer with an outstanding premium balance -> listed.
    assert has_live_position(250_000)


def test_flat_party_is_not_listed_without_windowed_activity():
    # Everything settled and nothing in the window -> no row, not a zero row.
    assert not has_live_position(0, 0, 0)
    assert not has_live_position(0)
    # Absent account / wallet documents read as no position.
    assert not has_live_position(None, None)
