"""Pure-logic tests for the netted Finance Overview pending (owner's request that
each party show ONE figure — collect or pay — never a receivable AND a payable at
once) and for the auto-logged "Premium paid by Agency" transaction.

All money in paise.
"""

from app.core.enums import PayerType
from app.services.finance import agency_premium_ledger_amount
from app.services.finance_dashboard import net_pending, partner_pending_gross


# --- Netting (Part B) --------------------------------------------------------
def test_partner_owes_premium_minus_reward_collects_net():
    # Owner's example: partner owes ₹1180 premium, we owe ₹200 reward -> collect 980.
    us, them = partner_pending_gross(premium_balance=118000, reward_owed=20000)
    assert (us, them) == (118000, 20000)
    assert net_pending(us, them) == 98000            # +ve = collect ₹980


def test_partner_reward_exceeds_premium_flips_to_pay():
    # Reward ₹1500 > premium ₹1180 -> we pay the net ₹320.
    us, them = partner_pending_gross(premium_balance=118000, reward_owed=150000)
    assert net_pending(us, them) == -32000           # -ve = pay ₹320


def test_partner_negative_premium_folds_into_pay_side():
    # Premium balance negative means we owe the partner (e.g. discount refund);
    # it must add to what we owe, not subtract from a receivable.
    us, them = partner_pending_gross(premium_balance=-5000, reward_owed=20000)
    assert us == 0
    assert them == 25000
    assert net_pending(us, them) == -25000           # pay ₹250


def test_partner_no_reward_is_pure_collect():
    us, them = partner_pending_gross(premium_balance=118000, reward_owed=0)
    assert net_pending(us, them) == 118000


def test_customer_discount_refund_is_a_payable():
    # Customer paid the insurer but is owed a ₹50 discount back -> balance -5000.
    # Modelled as owed_to_us=0, owed_to_them=5000 -> we pay ₹50.
    assert net_pending(0, 5000) == -5000


def test_zero_position_nets_out():
    assert net_pending(20000, 20000) == 0


# --- Auto-logged agency premium (Part C) -------------------------------------
def test_agency_premium_logs_negative_outflow():
    # Agency fronts a ₹1180 premium through a broker -> a -118000 outflow row.
    assert agency_premium_ledger_amount(
        PayerType.AGENCY, "brk1", 118000) == -118000


def test_no_log_when_customer_or_partner_pays():
    assert agency_premium_ledger_amount(
        PayerType.CUSTOMER, "brk1", 118000) is None
    assert agency_premium_ledger_amount(
        PayerType.CHANNEL_PARTNER, "brk1", 118000) is None


def test_no_log_without_broker_or_premium():
    assert agency_premium_ledger_amount(PayerType.AGENCY, None, 118000) is None
    assert agency_premium_ledger_amount(PayerType.AGENCY, "brk1", 0) is None
