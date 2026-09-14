/*
  Asking the browser where it is, for the attendance punch (owner 2026-08-21).

  "HMWQ+FQ Udaipur, Rajasthan is the location of this office, so if the user
  clicks on login from this location it should be marked as present, if user is
  not in this location and marks the attendance it should be marked as work from
  home attendance."

  THIS FILE ONLY REPORTS A POSITION. It never decides what that position means —
  no comparison to the office, no radius, no verdict. The server owns that
  (services/hr_geo.py), because a client that decides its own attendance status
  and posts it is not a control, it is a suggestion box.

  IT NEVER THROWS, AND IT NEVER BLOCKS THE PUNCH. Every failure path — permission
  denied, no GPS hardware, a timeout, an insecure context, a browser with no
  geolocation at all — resolves to `null`, and the caller clocks in anyway. The
  day is recorded as unplaceable and flagged for a human. An attendance system
  that refuses to let somebody clock in because Chrome ate a permission prompt
  is worse than one that records the day and lets a manager fix it, and the
  owner has an explicit switch (`require_location`) for the stricter behaviour.

  A NOTE ON HTTPS: `navigator.geolocation` is only available in a secure
  context. Production is HTTPS on Vercel and `localhost` counts as secure, so
  the one place this silently returns null is a LAN IP in development.
*/

export type Fix = {
  lat: number;
  lng: number;
  /** The browser's own 95% confidence radius, in metres. */
  accuracy_m?: number;
};

/*
  Ten seconds, then give up and punch without it.

  A clock-in happens with somebody's coat still on and a queue behind them; a
  spinner that can run for the browser's default (indefinitely) turns "press the
  button" into "wait and wonder". Ten seconds is long enough for a cold GPS fix
  indoors on wifi and short enough that nobody walks away.
*/
const TIMEOUT_MS = 10_000;

/*
  A cached fix up to a minute old is fine. Nobody's office/home status changes
  in a minute, and reusing the last fix makes the second punch of the day
  instant instead of spinning up the radio again.
*/
const MAX_AGE_MS = 60_000;

export function isSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

/**
 * The current position, or `null` if it cannot be had for any reason.
 *
 * `enableHighAccuracy` is ON: the whole question is whether somebody is inside a
 * 150m circle, and the coarse network-positioning answer is routinely vaguer
 * than that. The cost is battery and a slower first fix, which is the right
 * trade for a control that runs twice a day.
 */
export function currentFix(): Promise<Fix | null> {
  if (!isSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (fix: Fix | null) => {
      if (settled) return;
      settled = true;
      resolve(fix);
    };
    // A belt against a browser that neither resolves nor errors — which is not
    // hypothetical: a denied permission on some Android WebViews simply never
    // calls back, and without this the punch button would spin for ever.
    const timer = setTimeout(() => done(null), TIMEOUT_MS + 2_000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          // `accuracy` is always present per the spec, but it arrives from the
          // platform and a missing one must not become 0 — that would claim a
          // perfect fix and let a vague reading place somebody at their desk.
          accuracy_m: Number.isFinite(pos.coords.accuracy)
            ? pos.coords.accuracy : undefined,
        });
      },
      () => {
        // Denied, unavailable or timed out. All three are the same answer here:
        // we do not know. The REASON is not surfaced as an error because none
        // of them stop the punch, and a red toast for a permission the employee
        // may have deliberately withheld is noise.
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: true, timeout: TIMEOUT_MS, maximumAge: MAX_AGE_MS },
    );
  });
}
