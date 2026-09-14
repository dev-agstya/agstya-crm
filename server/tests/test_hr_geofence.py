"""Location-based attendance: office vs work-from-home (owner 2026-08-21).

    "HMWQ+FQ Udaipur, Rajasthan is the location of this office, so if the user
    clicks on login from this location it should be marked as present, if user
    is not in this location and marks the attendance it should be marked as work
    from home attendance… allowed radius from this should be 150m."

WHAT IS BEING PINNED, AND WHY EACH PART MATTERS
------------------------------------------------
1. THE SERVER DECIDES. The browser reports a position; it never reports a
   verdict. A client that posts its own attendance status is a suggestion box.

2. UNKNOWN IS NOT REMOTE. A reading vaguer than the fence cannot place anybody
   inside it. Treating "we cannot tell" as "not at the office" marks somebody
   sitting at their desk on a wifi-located laptop as working from home, and
   leaves them nothing to argue with. This is the rule most likely to be
   "simplified" away by someone who has not seen a 900m accuracy reading.

3. WHERE AND HOW-LONG ARE DIFFERENT QUESTIONS. A full remote day is WFH; a
   two-hour remote day is still a HALF DAY. Letting `remote` promote a short day
   to WFH would quietly pay a full day for two hours' work.

4. THE FEATURE IS INERT UNTIL CONFIGURED. Off, or on with no coordinates, must
   leave every day exactly what it was before this existed — an enabled fence
   with no centre would classify the whole planet as remote and mark every
   employee work-from-home the next morning.

The office coordinate is the owner's Plus Code decoded: HMWQ+FQ Udaipur →
7JPMHMWQ+FQ → 24.596187 N, 73.689437 E.
"""

from __future__ import annotations

import pytest

from app.core.enums import AttendanceStatus, WorkLocation
from app.models.settings import HrSettings
from app.services import hr_geo as geo


OFFICE_LAT = 24.596187
OFFICE_LNG = 73.689437


def _hr(**over) -> HrSettings:
    base = dict(geofence_enabled=True, office_lat=OFFICE_LAT,
                office_lng=OFFICE_LNG, office_radius_m=150,
                max_accuracy_m=150)
    base.update(over)
    return HrSettings(**base)


def _offset(metres: float, *, north: bool = True) -> tuple[float, float]:
    """A point `metres` from the office, due north (or south).

    Latitude is the safe axis for this: one degree of latitude is ~111.32 km
    everywhere, so the fixture does not depend on a longitude correction that
    would itself be re-deriving the thing under test.
    """
    delta = metres / 111_320.0
    return (OFFICE_LAT + delta if north else OFFICE_LAT - delta), OFFICE_LNG


# --- The distance rule ------------------------------------------------------------


def test_the_office_itself_is_the_office():
    where, distance = geo.classify(_hr(), OFFICE_LAT, OFFICE_LNG, 10)
    assert where == WorkLocation.OFFICE.value
    assert distance == 0


def test_just_inside_the_radius_is_the_office():
    lat, lng = _offset(140)
    where, distance = geo.classify(_hr(), lat, lng, 10)
    assert where == WorkLocation.OFFICE.value
    assert 135 <= distance <= 145


def test_just_outside_the_radius_is_remote():
    lat, lng = _offset(160)
    where, distance = geo.classify(_hr(), lat, lng, 10)
    assert where == WorkLocation.REMOTE.value
    assert 155 <= distance <= 165


def test_the_boundary_is_inclusive():
    """Exactly on the line counts as in. Somebody standing at the gate is at
    work, and a rule that says otherwise is one nobody can stand on."""
    lat, lng = _offset(150)
    where, _ = geo.classify(_hr(), lat, lng, 1)
    assert where == WorkLocation.OFFICE.value


def test_home_across_town_is_remote():
    where, distance = geo.classify(_hr(), 24.5854, 73.7125, 20)
    assert where == WorkLocation.REMOTE.value
    assert distance > 2000


def test_the_radius_is_a_setting_not_a_constant():
    lat, lng = _offset(400)
    assert geo.classify(_hr(), lat, lng, 10)[0] == WorkLocation.REMOTE.value
    assert geo.classify(_hr(office_radius_m=500), lat, lng,
                        10)[0] == WorkLocation.OFFICE.value


def test_distance_is_symmetric_in_both_directions():
    north = geo.classify(_hr(), *_offset(300, north=True), 10)[1]
    south = geo.classify(_hr(), *_offset(300, north=False), 10)[1]
    assert north == south


# --- Accuracy: rule 2 -------------------------------------------------------------


def test_a_reading_vaguer_than_the_fence_is_unknown_not_remote():
    """THE ONE most likely to be deleted by someone tidying up.

    A laptop positioned by wifi lookup routinely reports several hundred metres
    of uncertainty. Recording that as "not at the office" is a false accusation
    the employee cannot answer.
    """
    where, distance = geo.classify(_hr(), OFFICE_LAT, OFFICE_LNG, 900)
    assert where == WorkLocation.UNKNOWN.value
    # The distance is still reported: it is evidence, and a manager reviewing
    # the day wants the reading even when the verdict is "cannot say".
    assert distance == 0


def test_a_vague_reading_is_unknown_even_when_it_looks_remote():
    """The verdict must not depend on which way the doubt happens to fall."""
    lat, lng = _offset(800)
    assert geo.classify(_hr(), lat, lng, 900)[0] == WorkLocation.UNKNOWN.value


def test_a_precise_reading_inside_the_fence_is_accepted():
    assert geo.classify(_hr(), *_offset(50), 30)[0] == WorkLocation.OFFICE.value


def test_no_reported_accuracy_is_taken_at_face_value():
    """Some platforms omit it. Absence is not vagueness — the alternative is
    refusing every reading from a browser that does not volunteer a number."""
    assert geo.classify(_hr(), OFFICE_LAT, OFFICE_LNG,
                        None)[0] == WorkLocation.OFFICE.value


def test_the_accuracy_cap_can_be_switched_off():
    assert geo.classify(_hr(max_accuracy_m=0), OFFICE_LAT, OFFICE_LNG,
                        5000)[0] == WorkLocation.OFFICE.value


# --- Rule 4: inert until configured ------------------------------------------------


def test_a_disabled_geofence_classifies_nothing():
    where, distance = geo.classify(_hr(geofence_enabled=False),
                                   OFFICE_LAT, OFFICE_LNG, 10)
    assert where == WorkLocation.UNKNOWN.value
    assert distance is None


def test_an_enabled_fence_with_no_centre_is_not_remote():
    """The catastrophic case. Every employee marked work-from-home overnight."""
    hr = _hr()
    hr.office_lat = None
    assert geo.is_configured(hr) is False
    assert geo.classify(hr, OFFICE_LAT, OFFICE_LNG, 10)[0] \
        == WorkLocation.UNKNOWN.value


def test_no_coordinates_at_all_is_unknown():
    assert geo.classify(_hr(), None, None, None)[0] == WorkLocation.UNKNOWN.value


def test_null_island_is_rejected_rather_than_measured():
    """(0, 0) is what a broken client sends when it means "nothing". Measured
    literally it is 5,000 km from Udaipur and would read as a real remote day."""
    assert geo.valid_coords(0.0, 0.0) is False
    assert geo.classify(_hr(), 0.0, 0.0, 10)[0] == WorkLocation.UNKNOWN.value


def test_impossible_coordinates_are_rejected():
    for lat, lng in ((91.0, 73.0), (-91.0, 73.0), (24.0, 181.0), (24.0, -181.0)):
        assert geo.valid_coords(lat, lng) is False


# --- What an unknown counts as ----------------------------------------------------


def test_unknown_defaults_to_remote_for_the_days_status():
    assert geo.status_location(WorkLocation.UNKNOWN.value,
                               _hr()) == WorkLocation.REMOTE.value


def test_the_owner_can_make_unknown_count_as_present():
    assert geo.status_location(
        WorkLocation.UNKNOWN.value,
        _hr(unknown_counts_as_office=True)) == WorkLocation.OFFICE.value


def test_a_known_answer_is_never_overridden_by_that_setting():
    hr = _hr(unknown_counts_as_office=True)
    assert geo.status_location(WorkLocation.REMOTE.value,
                               hr) == WorkLocation.REMOTE.value


# --- The distance function itself --------------------------------------------------


def test_haversine_matches_a_known_separation():
    """One degree of latitude is ~111.32 km. Anything wildly off means the
    formula, the radius or the argument order has been broken."""
    d = geo.haversine_m(24.0, 73.0, 25.0, 73.0)
    assert 110_500 <= d <= 111_800


def test_distance_to_itself_is_zero():
    assert geo.haversine_m(24.5, 73.5, 24.5, 73.5) == pytest.approx(0, abs=1e-6)


def test_distance_is_the_same_both_ways_round():
    a = geo.haversine_m(24.596, 73.689, 24.585, 73.712)
    b = geo.haversine_m(24.585, 73.712, 24.596, 73.689)
    assert a == pytest.approx(b, abs=1e-6)


# --- Rule 3: where and how-long are different questions ---------------------------


class _Policy:
    """Minimal stand-in for hr_attendance.DayPolicy."""

    shift_start = "10:00"
    shift_end = "19:00"
    late_grace = 15
    early_grace = 15
    full_day_minutes = 480
    half_day_minutes = 240
    week_off_days = {6}


class _Day:
    """The fields `recompute` reads and writes, without standing up Beanie.

    A real `AttendanceDay` is a Beanie Document and cannot be constructed
    without `init_beanie`. The behaviour under test is pure arithmetic over
    these attributes, so a stand-in tests the rule rather than the ODM — the
    same approach test_policy_lifecycle takes for the same reason.
    """

    def __init__(self, day, clock_in, clock_out, work_location):
        self.day = day
        self.clock_in = clock_in
        self.clock_out = clock_out
        self.work_location = work_location
        self.breaks = []
        self.worked_minutes = 0
        self.break_minutes = 0
        self.status = AttendanceStatus.NOT_MARKED.value
        self.is_late = False
        self.late_minutes = 0
        self.is_early_out = False
        self.early_out_minutes = 0
        self.updated_at = None


def _worked(minutes: int, location):
    """A finished day of `minutes`, worked from `location`, run through the one
    definition of a day's status."""
    from datetime import timedelta

    from app.services import hr_attendance as svc
    from app.services import hr_calendar as cal

    day_str = "2026-08-20"
    start = cal.shift_bounds(cal.parse_day(day_str), "10:00", "19:00")[0]
    row = _Day(day_str, start, start + timedelta(minutes=minutes), location)
    svc.recompute(row, _Policy(), now=start + timedelta(hours=12))
    return row.status


def test_a_full_day_at_the_office_is_present():
    assert _worked(480, WorkLocation.OFFICE.value) \
        == AttendanceStatus.PRESENT.value


def test_a_full_day_worked_remotely_is_work_from_home():
    """The owner's requirement, stated directly."""
    assert _worked(480, WorkLocation.REMOTE.value) == AttendanceStatus.WFH.value


def test_a_short_remote_day_is_still_a_half_day():
    """RULE 3. Promoting this to WFH would pay a full day for two hours."""
    assert _worked(250, WorkLocation.REMOTE.value) \
        == AttendanceStatus.HALF_DAY.value


def test_a_day_with_no_location_at_all_is_present_as_before():
    """Days recorded before this feature existed carry no `work_location`, and
    must keep reading exactly as they did."""
    assert _worked(480, None) == AttendanceStatus.PRESENT.value


def test_a_remote_day_too_short_to_count_is_still_absent():
    assert _worked(60, WorkLocation.REMOTE.value) \
        == AttendanceStatus.ABSENT.value
