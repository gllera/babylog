# Web UI

A browser-based view is served at `/app` (visiting `/` redirects there). It
has two views — **Today** and **Settings** — toggled by the corner
button (⚙ opens Settings, ← returns), and lets you record and edit feedings,
diapers, routines, weights, and heights without an MCP client.

Authentication is the Cloudflare Access login in front of the host — the app
itself has no login screen. **All times are Europe/Madrid** (the household
timezone, matching the MCP stats and the Alexa skill), never the device
timezone.

## Today

- A chart-recorder **rhythm tape**: one faint lane per domain (feeds /
  diapers / routines) under a fixed center needle, scrubbable through the
  last days, with night hours shaded and the future fogged out. Tapping the
  dial readout opens a jump-to-a-date/time dialog that extends the tape into
  deeper history.
- A quick-add row records a feeding, diaper, or routine at the marker's
  moment; the recent-records log below reads the tape back, and its rows arm
  an inline editor (value controls + two-tap Delete). Tapping a record's mark
  on the tape itself arms the same editor — the needle parks on the record.
  A feeding added within 10 minutes of an existing one tops up that entry
  instead of creating another; the toast shows the new total and its Undo
  subtracts the amount rather than deleting the entry.
- A milk-intake gauge compares today against the recent days' band.
- Data comes from a single aggregated `/api/dashboard` request (which also
  evaluates indications server-side over Madrid-day windows), refetched
  whenever the app returns to the foreground.

## Settings

Settings is the diary's flyleaf: one narrow centered column (the charts'
width) on the app's centerline. The selected baby leads as a masthead —
name big, age muted beneath — and each section below opens with a
flanked-hairline micro-caps divider. **The content is the fold control**:
tapping the masthead, a measure's dial or the partner roster folds that
section's management machinery (forms, ledgers, deletes) open or shut —
there are no edit buttons. While a fold is out, its divider title takes
the accent hue — the sign that the panel belongs to it and that tapping
the content again closes it — and the rest of the flyleaf (baby switcher
included) dims and goes inert until the fold contracts, so one workbench
is out at a time. The page reads whose diary → the child's data → the
household's people → app preference.

- **Masthead (babies)** — whose diary this is; tapping the name/age
  block opens the babies ledger (sex as a micro-caps tag,
  exact birth dates as DD/MM/YYYY) and the add-baby form (name, optional
  sex and birth date). Tapping a baby's row loads it into that form for
  editing (`PUT /api/babies/<id>`, the `set_profile` MCP semantics) —
  the place to fix a name or fill in the sex/birth date that gate the
  age line and every WHO feature; clearing a field clears it. Each row's
  × removes the baby — not the ledgers' two-tap, but a confirm dialog
  that names the baby and spells out that the entire diary goes with it
  (`DELETE /api/babies/<id>`, the `remove_baby` MCP semantics; no undo;
  if the default baby goes, the oldest remaining inherits the flag). The
  first baby added to an empty household becomes the default. A
  household with no baby yet gets this fold opened automatically, under
  an "Add your baby" masthead line.
- **Weight / Height** — each measure is a dial: the projected current
  value ("≈ 4 310 g", thousands separated per locale) over its WHO
  percentile at today's age ("today · P62"), centered big over the
  growth trend chart — unlabeled readings over WHO Child Growth
  Standards ghost regions (P3–P97 with a deeper P15–P85 inside and a
  dashed P50 midline, when the profile has sex + birth date), plus a
  dashed projection from the last reading to a hollow point at today's
  estimate. Tapping the dial folds a panel with the one-line add row
  (value + date) and the full ledger. (Without an estimate the dial
  shows the newest reading over its day (DD/MM) and WHO percentile,
  trimming segments when the column runs short.) Records are
  day-grained — the date defaults to today ("now"), a past date lands at
  noon Madrid, and an edit that keeps the day keeps the original
  instant. Ledger rows print the reading's day as a full DD/MM/YYYY
  date (the birth dates' dialect) and carry the gain since the previous
  reading ("+450") in a muted fixed column — the checkup number. Tap a
  ledger line to edit it, or its × to delete (two-tap confirm). An
  empty dial teaches the gesture: "Tap to add the first weight".
- **Partners** — a ruleless centered roster of the household's
  caregivers; tapping it folds the management panel: a ruled ledger with
  a two-tap × per caregiver (you can't remove yourself) and the
  invite-by-email form; the at-rest roster mutes while the ledger below
  is the live copy. Backed by `/api/household`, `/api/caregivers`,
  and `/api/babies`; same semantics as the `add_caregiver` /
  `remove_caregiver` / `add_baby` MCP tools. Inviting only registers the
  email in the household — it must also be allowed by the Cloudflare
  Access policy to log in at all.
- **Language** — English / Spanish toggles centered under the last divider
  (persisted in `localStorage`, guessed from the browser on first visit);
  closes the flyleaf as the least-touched section.

## Multi-baby & platform

- Households with more than one baby get a switcher row above the view;
  the selection persists and scopes every view and quick-record. A
  non-default selection is mirrored onto the page URL as `?baby=<id>`, so
  the address can be bookmarked; opening a URL with `?baby=` selects that
  baby (the default baby keeps the URL clean).
- The UI follows the system light/dark theme.
- Installable as a PWA: web manifest with home-screen shortcuts, raster icons
  for iOS/Android, and a minimal pass-through service worker.
