# Raja Energy Studio

Read-only dashboard for Raja Fraz's PV14000, PV9000 and Matrix battery. Run `npm start` in this directory. Node.js 22+; no third-party dependencies.

## Scope and accuracy

- Only PV14000 and PV9000 contribute to solar, inverter output load, grid and daily energy totals. These are inverter readings, not a utility meter or a whole-home consumption measurement.
- Matrix uses the battery-only bridge `/api/battery`. Expected current serial is checked server-side. Matrix solar, load and grid fields never leave the normalizer and never enter totals.
- Solar freshness is 3 minutes; Matrix freshness is 15 minutes for its slower cloud collection. Source timestamps, not HTTP receipt time, determine freshness. Partial totals and stale battery readings are hidden.
- Positive grid watts = import; negative = export. Positive Matrix battery watts = discharge; negative = charge, following the existing SOLARMAN mapping.
- 240 V is an observation marker only. This dashboard never changes protection settings or claims voltage caused a production drop.
- Measured history merges available upstream records with local browser samples. There is no fabricated data or interpolation over gaps longer than 10 minutes. History availability depends on upstream retention and this browser's saved samples.
- The free Render instance can sleep. This app does not guarantee continuous collection while closed. No new paid service or database is required.

## Deployment

Render Node web service from the `energy-studio-2026-10-26` branch. Build: `node --test energy-studio/test/*.test.mjs`. Start: `node energy-studio/server.mjs`. Health: `/healthz`.

Optional environment variables: `SOLAR_API_BASE`, `MATRIX_API_BASE`, `MATRIX_BATTERY_DEVICE_SN`, `PORT`. No API credentials are embedded. Fixed server-side source routes avoid arbitrary proxy requests. Only GET/HEAD are accepted, assets are allowlisted, and raw API metadata is not exposed.

Run `npm run check`. Tests cover timestamp parsing, offline/stale sources, no double counting, battery-only projection, serial mismatch, daily rollover and missing readings.
