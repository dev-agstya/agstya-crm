"""Sign convention for manually recorded payments (+receivable / -payable)."""

from app.core.enums import LedgerTxnType, PartyType
from app.routers.finance import _signed_amount
from app.schemas.finance import PaymentCreate


def _pay(txn_type: LedgerTxnType, increases: bool = False) -> PaymentCreate:
    return PaymentCreate(
        txn_type=txn_type, party_type=PartyType.CUSTOMER, party_id="x",
        amount_paise=100, increases_receivable=increases)


def test_agency_outflows_increase_receivable():
    # Agency fronted premium / refunded the party -> they owe us more.
    assert _signed_amount(_pay(LedgerTxnType.PREMIUM_TO_INSURER)) == 100
    assert _signed_amount(_pay(LedgerTxnType.REFUND)) == 100


def test_inflows_reduce_receivable():
    for t in (LedgerTxnType.PREMIUM_COLLECTED, LedgerTxnType.PARTNER_PAYOUT,
              LedgerTxnType.REWARD_RECEIVED, LedgerTxnType.DISCOUNT):
        assert _signed_amount(_pay(t)) == -100


def test_adjustment_takes_caller_direction():
    assert _signed_amount(_pay(LedgerTxnType.ADJUSTMENT, True)) == 100
    assert _signed_amount(_pay(LedgerTxnType.ADJUSTMENT, False)) == -100
