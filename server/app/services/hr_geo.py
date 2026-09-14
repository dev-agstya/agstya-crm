"""Where a punch came from, and whether that counts as the office.

Added 2026-08-21 (owner): "HMWQ+FQ Udaipur, Rajasthan is the location of this
office, so if the user clicks on login from this location it should be marked as
present, if user is not in this location and marks the attendance it should be
marked as work from home attendance… allowed radius from this should be 150m."

THIS MODULE IS THE ONE DEFINITION of that rule. The classification happens on
the SERVER, from coordinates the browser reports — never on the client. A phone
deciding for itself that it is "at the office" and posting a status is not an
attendance control, it is a suggestion box.


WHAT THIS CAN AND CANNOT DO — read before trusting it
-----------------------------------------------------
Browser geolocation is REPORTED, not proven. It can be overridden from the
developer tools in any browser, by a location-spoofing extension, or by a rooted
phone, and no amount of server-side arithmetic changes that. So this is a
RECORD-KEEPING control, not a security boundary: it makes the honest case
automatic and the dishonest case something a person has to deliberately do and
leave evidence of.

What it does bank, and why each part is kept:
  * the raw coordinates and the reading's own accuracy, so a manager can see the
    reading rather than only the verdict;
  * the distance in metres, so "just outside" and "forty kilometres away" are
    distinguishable at a glance;
  * the IP address, which `AttendanceDay` has recorded since the module shipped
    against exactly this day (its comment reads "if office-only punching is ever
    switched on, the evidence of whether it would have worked is already here").

A manager can override any day, as they always could. That is the backstop, and
it is the right one — the software's job here is to be right by default, not to
be unarguable.


THE RULES
---------
1. DISTANCE decides. Inside `office_radius_m` of the configured point is OFFICE;
   outside it is REMOTE. One circle, one number, no gradients.

2. ACCURACY can make a reading USELESS, and a useless reading is UNKNOWN — not
   REMOTE. A laptop positioned by wifi lookup routinely reports a kilometre of
   uncertainty; treating "we cannot tell" as "not at the office" would mark
   somebody sitting at their desk as working from home, and they would have no
   way to argue with it. So a reading whose own accuracy is worse than
   `max_accuracy_m` is refused rather than guessed at.

3. UNKNOWN IS NOT A PUNISHMENT. It is recorded, flagged for a human, and — by
   default — treated as remote for the day's status while staying visibly
   distinct in the data. The owner can require a location (`require_location`)
   if they would rather the punch be refused than recorded with a gap.

4. THE CLOCK-IN DECIDES THE DAY. Clock-out coordinates are recorded because they
   are free and occasionally tell a story, but they never change the verdict.
   Otherwise stepping out to a customer at 6pm would rewrite the whole day.
"""

from __future__ import annotations

import math
from typing import Optional

from app.core.enums import WorkLocation
from app.models.settings import HrSettings

# Mean Earth radius (metres). Haversine on a sphere is accurate to ~0.5% — at
# the scale of a 150m office geofence that is under a metre, which is far inside
# the accuracy of any consumer GPS reading it will ever be compared against.
EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two WGS-84 points, in metres.

    Haversine rather than the flat-earth approximation people reach for: the
    simple `dx = dlng * cos(lat)` form is fine at Udaipur's latitude and quietly
    wrong elsewhere, and this module should not have a latitude it stops being
    correct at.
    """
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = (math.sin(dp / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2)
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def is_configured(hr: HrSettings) -> bool:
    """Is the geofence switched on AND actually pointed somewhere?

    Both halves matter. An enabled geofence with no office coordinate would
    classify the entire planet as remote and mark every employee work-from-home
    on the morning somebody ticked the box.
    """
    return bool(hr.geofence_enabled
                and hr.office_lat is not None and hr.office_lng is not None)


def valid_coords(lat: Optional[float], lng: Optional[float]) -> bool:
    """A pair that could name a place on Earth.

    (0, 0) is in the Gulf of Guinea and is what a broken client sends when it
    means "I have nothing"; it is rejected here so it cannot be recorded as a
    real reading 5,000km from Udaipur.
    """
    if lat is None or lng is None:
        return False
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lng <= 180.0):
        return False
    return not (lat == 0.0 and lng == 0.0)


def classify(hr: HrSettings, lat: Optional[float], lng: Optional[float],
             accuracy_m: Optional[float] = None
             ) -> tuple[str, Optional[int]]:
    """Decide where a punch came from. Returns (WorkLocation value, distance_m).

    `distance_m` is None whenever there was nothing to measure — it is evidence,
    not a default, and rounding "we do not know" down to 0 would put every
    unlocated punch at the exact centre of the office.
    """
    if not is_configured(hr):
        # Nothing to compare against. NOT "remote": with the feature switched
        # off every day must stay exactly what it was before it existed.
        return WorkLocation.UNKNOWN.value, None

    if not valid_coords(lat, lng):
        return WorkLocation.UNKNOWN.value, None

    distance = haversine_m(lat, lng, hr.office_lat, hr.office_lng)

    # A reading vaguer than the fence it is being compared to cannot answer the
    # question. Rule 2 above — this is the branch that stops somebody at their
    # desk on a wifi-located laptop being recorded as working from home.
    cap = hr.max_accuracy_m or 0
    if cap > 0 and accuracy_m is not None and accuracy_m > cap:
        return WorkLocation.UNKNOWN.value, int(round(distance))

    inside = distance <= hr.office_radius_m
    return ((WorkLocation.OFFICE.value if inside else WorkLocation.REMOTE.value),
            int(round(distance)))


def status_location(resolved: str, hr: HrSettings) -> str:
    """What an UNKNOWN reading counts as when the day's status is worked out.

    Split out from `classify` on purpose: the DATA keeps "we were not told"
    forever, and only this function collapses it to a working answer. Merging
    the two would throw the distinction away at the point of writing, and the
    manager looking at the day a week later is exactly who needs it.
    """
    if resolved != WorkLocation.UNKNOWN.value:
        return resolved
    return (WorkLocation.OFFICE.value if hr.unknown_counts_as_office
            else WorkLocation.REMOTE.value)
