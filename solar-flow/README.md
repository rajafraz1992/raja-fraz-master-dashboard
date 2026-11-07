# Raja Solar System — Sunsynk Power Flow

A standalone, read-only solar dashboard for Raja Fraz. The main diagram uses the original `slipx06/sunsynk-power-flow-card` v7.5.8, not a simulated screenshot. A small adapter supplies its Home Assistant-shaped sensor state from the existing Raja Energy Studio API. No Home Assistant server or PC at home is needed.

## Run

Node.js 24. No package installation is needed.

```sh
npm test
npm start
```

The server binds `0.0.0.0` and uses `PORT` (default 3000). Health endpoint: `/healthz`.

## Render

Deploy this directory as a Node web service. In the containing GitHub repository use:

- Branch: `raja-solar-flow`
- Build command: `cd solar-flow && npm test`
- Start command: `node solar-flow/server.mjs`
- Plan: Free (may sleep when unused and take time to wake)

No new database, cloud account, inverter credentials or paid API is required. This service reads only `https://raja-energy-studio.onrender.com/api/overview` and `/api/history`. It cannot change inverter or ATS settings. Public accessibility matches the existing source API; do not add secrets to frontend files.

## Readings and history

- Foreground polling every 5 seconds, with 10/30-second options. Source-device timestamps are shown; frequent polling is not a promise of new measurements every 5 seconds.
- PV14000 and PV9000 can be shown individually or combined. Both feeds must be fresh and all three core powers present before the combined diagram renders.
- Solar/load/grid totals exclude Matrix. Matrix battery is a separate monitor because its electrical relationship to the other feeds is not verified by the API.
- Positive grid power means import; negative means export. These are inverter-reported readings, not guaranteed utility-meter measurements.
- Missing/stale values show dashes and pause the diagram, never fabricated zeros. A measured zero at night stays zero.
- Solar records expire after 3 minutes, Matrix after 15 minutes, and service receipts after 90 seconds. Future timestamps over 30 seconds are rejected.
- Energy counters must be for the current Asia/Karachi day. The browser's receipt of a response does not reset the device age.
- History is read from the existing service and augmented with genuine device records saved in the current browser (up to 7 days). Missing periods stay gaps. It is not a new 24/7 history recorder.
- Unknown inverter status codes, AC inverter power, battery topology and DC transformer temperature are not inferred. Autarky/ratio estimates are disabled.
- CSV export contains source readings and UTC timestamps, not invented interpolations.

## Third-party attribution

The original Sunsynk Power Flow Card is Copyright (c) 2024 slipx06, MIT licensed. The full MIT notice is retained in `public/vendor/LICENSE.txt` and the UI links to the original project. Original source: https://github.com/slipx06/sunsynk-power-flow-card

Vendored upstream Git blob: `c6001f578d50c62080d865c538d4f38d709a22fe` (v7.5.8). The bundle is unchanged. Fronus is the owner's device brand; this dashboard does not claim affiliation with Sunsynk, Fronus or slipx06.

The owner's existing solar data model is reused. The public dashboard uses a solar icon, without a personal photo. No third-party assets are loaded at runtime.
