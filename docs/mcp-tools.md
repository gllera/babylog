# MCP tools

The Model Context Protocol server is exposed at `/mcp`. See
[Architecture](./architecture.md) for how authentication and per-household
scoping work.

All record / list / stats / indication tools accept an optional `baby`
(name or numeric id; default: the household's default baby).

| Tool                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `set_profile`       | Update a baby's `name`, `sex`, `date_of_birth` (any combination); optional `baby` selector |
| `get_profile`       | List the household's babies with computed ages and the default marker   |
| `add_baby`          | Add a baby to the household (`name`, optional `sex` / `date_of_birth`)  |
| `set_default_baby`  | Change which baby tools target when `baby` is omitted                   |
| `add_caregiver`     | Register another email into the caller's household                      |
| `remove_caregiver`  | Remove a caregiver's email from the caller's household (not yourself)   |
| `create_household`  | Create a new isolated household with its first caregiver + default baby |
| `record_feeding`    | Log a feeding: `amount_ml` (required), `when` (ISO ts). Returns the gap since the previous feeding |
| `list_feedings`     | List feedings, newest first. Optional `since` / `until` / `limit`       |
| `delete_feeding`    | Remove a feeding by `id`                                                |
| `record_diaper`     | Log a diaper: `kind` ('pee' / 'poop' / 'both'), `when`. Returns the gap since the previous diaper |
| `list_diapers`      | List diapers, newest first. Optional `since` / `until` / `kind` / `limit` |
| `delete_diaper`     | Remove a diaper event by `id`                                           |
| `record_routine`    | Log a routine event, medication, or supplement: `name` (e.g. 'Vitamin D', 'Bath'), `when`. Returns the gap since the previous entry with the same `name` |
| `list_routines`     | List entries, newest first. Optional `since` / `until` / `name` / `limit` |
| `delete_routine`    | Remove an entry by `id`                                                 |
| `record_note`       | Log a free-form note (e.g. 'pimples on face'): `text`, `when`           |
| `list_notes`        | List notes. Optional `since` / `until` / `search` / `limit`             |
| `delete_note`       | Remove a note by `id`                                                   |
| `record_weight`     | Log a weight in whole grams: `weight_g`, `when` (reports delta vs prev) |
| `list_weights`      | List weight measurements. Optional `since` / `until` / `limit`          |
| `delete_weight`     | Remove a weight measurement by `id`                                     |
| `record_height`     | Log a length/height in cm: `height_cm`, `when` (reports delta)          |
| `list_heights`      | List height measurements. Optional `since` / `until` / `limit`          |
| `delete_height`     | Remove a height measurement by `id`                                     |
| `add_indication`    | Define a target over an N-day window (e.g. '1 poop a day', 'bath every 2 days', 'max 4h between feedings'): `label`, `metric`, `target`, `comparison`, `period_days`, `filter`. `metric` ∈ `feeding_total_ml` / `feeding_count` / `feeding_gap_max_min` / `diaper_count` / `routine_count` / `note_count` |
| `list_indications`  | List defined indications (active by default)                            |
| `delete_indication` | Remove an indication by `id`                                            |
| `check_indications` | Evaluate all active indications against a day's actuals (today by default) |
| `get_stats`         | Feedings + diapers + routines + notes summary + latest weight & height. Pass `window` (`24h` / `today` / `7d` / `30d`) or custom `since`/`until` (default 24 h) |
| `record_many`       | Batch-record up to 20 events of mixed types (`feeding`, `diaper`, `routine`, `note`) in one call, with an optional shared `when`. All-or-nothing: if any event is invalid, nothing is recorded |

## Timestamps

Timestamps are stored as ISO 8601 UTC strings (e.g. `2026-05-14T07:30:00Z`).
Inputs may also carry a timezone offset (e.g. `2026-05-14T09:30:00+02:00`); the
server normalizes them to UTC on write. "Days" (for `check_indications` and
`get_stats window='today'`) are **Europe/Madrid** calendar days — the household
timezone — consistent with the Alexa skill's daily summary.

## Connect from Claude

**claude.ai** → Connectors → add a custom connector with the `/mcp` URL — the
browser runs the Access login on first connect (dynamic client registration, no
client id/secret).

**Claude Code:**

```bash
claude mcp add --transport http baby https://<your-host>/mcp
```

Then try:

> Record that the baby drank 120 ml at 7:30 this morning.
> Log a poopy diaper just now.
> She just peed and pooped, log it.
> How was the last 24 hours?
