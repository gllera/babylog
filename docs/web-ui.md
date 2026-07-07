# Web UI

A browser-based view is served at `/app` (visiting `/` redirects there). It
lets you register, edit (tap a list row), and remove feedings, diapers,
routines, notes, weights, and heights without an MCP client.

Authentication is the Cloudflare Access login in front of the host — the app
itself has no login screen. **All times are Europe/Madrid** (the household
timezone, matching the MCP stats and the Alexa skill), never the device
timezone.

## Today tab

- Last-event cards, and a "Today's targets" card with live progress on every
  active indication.
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

## Multi-baby & platform

- Households with more than one baby get a switcher above the tabs; the
  selection persists and scopes every view and quick-record.
- The UI follows the system light/dark theme.
- Installable as a PWA: web manifest with home-screen shortcuts, raster icons
  for iOS/Android, and a minimal pass-through service worker.
