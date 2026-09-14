"""Unit tests for the short entity-code format (no DB needed).

New format (owner 2026-07-24): ``{PREFIX}-{YY}{RAND}`` where RAND is a 4-char
base-36 (0-9, A-Z) RANDOM block — e.g. CUS-26K352, POL-26A451.
"""

import re

from app.services import codes


def test_format_code_shape_for_every_entity():
    for entity, prefix in codes.PREFIXES.items():
        c = codes.format_code(entity, yy="26")
        assert re.fullmatch(rf"{prefix}-26[0-9A-Z]{{4}}", c), c


def test_random_block_is_uppercase_base36():
    for length in (4, 5, 6):
        block = codes._random_block(length)
        assert len(block) == length
        assert re.fullmatch(r"[0-9A-Z]+", block)


def test_year_is_two_digits():
    assert re.fullmatch(r"\d{2}", codes._year_yy())


def test_blocks_are_randomised_not_serial():
    # Astronomically unlikely to be all-equal if truly random.
    blocks = {codes._random_block(4) for _ in range(50)}
    assert len(blocks) > 1


def test_customer_prefix_is_cus():
    assert codes.PREFIXES["customer"] == "CUS"
