# Web UI

A browser-based view is served at `/app` (visiting `/` redirects there). It
lets you register, edit (tap a list row), and remove feedings, diapers,
routines, notes, weights, and heights without an MCP client.

Authentication is the Cloudflare Access login in front of the host — the app
itself has no login screen. **All times are Europe/Madrid** (the household
timezone, matching the MCP stats and the Alexa skill), never the device
timezone.

## Today tab

- Last-event cards, and a "Today's targets" card with a progress bar per
  active indication, grouped by kind (feeding, diapers, routines).
- A merged chronological diary of the day.
- One-tap quick-record buttons (with an Undo toast). The feeding quick-add
  amounts adapt to recent entries, Vitamin D flips to a "done today" state once
  given, and an active `feeding_gap_max_min` indication tints the Last feeding
  card when the gap is exceeded.
- Data comes from a single aggregated `/api/dashboard` request (which also
  evaluates indications server-side over Madrid-day windows), refetched
  whenever the app returns to the foreground.

## Feeding & Diaper tabs

Weekly charts with day-comparison overlays, day-separator list grouping, and
−10 / +10 amount steppers.

## Weight & Height tabs

Growth trend charts with WHO Child Growth Standards percentile bands (P3–P97,
when the profile has sex + birth date) plus the current percentile estimate.
Dashboard cards show deltas vs the previous measurement.

## Settings tab

Opened with the gear button in the header:

- **Language** — English / Spanish (persisted in `localStorage`, guessed from
  the browser on first visit).
- **Babies** — the household's babies with the default marked, plus an
  add-baby form (name, optional sex and birth date). The first baby added to
  an empty household becomes the default.
- **Partners** — the household's caregivers, an invite-by-email form, and a
  two-tap Remove per caregiver (you can't remove yourself). Backed by
  `/api/household`, `/api/caregivers`, and `/api/babies`; same semantics as
  the `add_caregiver` / `remove_caregiver` / `add_baby` MCP tools. Inviting
  only registers the email in the household — it must also be allowed by the
  Cloudflare Access policy to log in at all.

## Multi-baby & platform

- Households with more than one baby get a switcher above the tabs; the
  selection persists and scopes every view and quick-record.
- The UI follows the system light/dark theme.
- Installable as a PWA: web manifest with home-screen shortcuts, raster icons
  for iOS/Android, and a minimal pass-through service worker.
