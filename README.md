# Raja Fraz Master Dashboard V28 - Wall Display Flow Animation Fix

V28 keeps all V27/V26 features and fixes the inverter-room `/display` energy-flow animation.

## V28 fix
- Fixes SVG class updates in Chrome/Android/TV browsers by using `setAttribute('class', ...)` instead of assigning `SVGElement.className`.
- Active power paths now use bright moving energy pulses with stronger glow.
- Direction reverses for grid export and battery discharge.
- Inactive/offline paths remain dim, so maintenance staff can immediately see what is actually flowing.
- No breaker, inverter, or Tuya protection setting is written or changed.

---

# Raja Fraz Master Solar Command Center - V27

V27 keeps all V26 intelligence features and adds a dedicated **Inverter Room Display Mode** for an always-on monitor, Android TV box/stick, mini PC or kiosk browser.

## Inverter Room Display
Open the Master Dashboard service at:

`/display`

Example: `https://YOUR-MASTER-DASHBOARD.onrender.com/display`

Display Mode is designed for a 19–22 inch wall monitor and includes:
- large live Solar, Site Demand, Physical Grid and UPS Battery cards;
- animated whole-site energy-flow map;
- live PV14000, PV9000, Matrix UPS and Tuya meter status;
- 5 kW night-import and 6 kW day-export guard meters;
- Today Solar / Import / Export and PV yield;
- large maintenance alert ticker;
- Pakistan time, Gujrat weather, source freshness and automatic 10-second refresh;
- fullscreen button plus browser Screen Wake Lock where supported;
- automatic recovery reload after repeated live-data failures.

**Safety:** Display Mode is read-only. It does not send inverter commands, Tuya breaker commands, or change any protection setting.

No new Render environment variables are required. Keep the existing V26 environment configuration unchanged.

---

# Raja Fraz Master Solar Command Center - V26 NEXT LEVEL INTELLIGENCE

V26 keeps the complete V25 dashboard, straight-ended gauges, V24 animated Energy Flow map, V22 professional icons, V21 Render auto-wake, V20 Tuya direction fix and the existing three-inverter topology. It adds a full read-only intelligence layer.

## New in V26
- **Energy Intelligence** tab with whole-site power balance.
- **5 kW Night Import Guard** using the Tuya physical meter.
- **6 kW Day Export Guard** using the Tuya physical meter.
- **MDI / DG peak center** with live %, headroom, today peak and month peak.
- **Tuya vs inverter reconciliation** for physical grid vs inverter-calculated grid.
- **Smart Alerts** for limits, stale data, temperature, low battery and reconciliation differences.
- **Battery Intelligence** with optional backup-runtime estimate.
- **Financial Snapshot** with solar value, import cost, optional export credit, grid dependency and self-consumption.
- **PV Performance Analytics** including kWh/kWp, live utilization and history-based peak/best/worst information.
- **Daily Energy Timeline** in Pakistan time with solar/demand/grid history and milestones.
- **Smart Insight Cards** for live decision support.
- **Mobile-first Command** tab for a fast phone view.
- **Energy Flow 2.0** balance ribbon above the animated topology map.
- PostgreSQL history now also stores Tuya physical-meter live samples for true MDI/DG peak tracking from V26 onward.

## Safety
V26 is **monitoring/read-only**. It does not send Tuya breaker commands, change Smart Life protection settings, or write inverter settings.

## Guardrail defaults
```text
Night import target: 5000 W
Day export target:   6000 W
Day watch window:    07:30 - 17:00 Asia/Karachi
```

## Optional Render settings
The ZIP works with safe defaults. These values can be changed later in Render Environment:

```text
NIGHT_IMPORT_LIMIT_W=5000
DAY_EXPORT_LIMIT_W=6000
DAY_MODE_START=07:30
DAY_MODE_END=17:00
EXPORT_RATE_PKR=0
BATTERY_CAPACITY_KWH=0
TARGET_DAILY_YIELD_KWH_PER_KWP=0
RECONCILIATION_ALERT_W=500
ALERT_TEMP_C=65
```

`BATTERY_CAPACITY_KWH=0` means runtime estimation stays disabled until the real usable battery capacity is entered. `EXPORT_RATE_PKR=0` means no export credit is assumed. `TARGET_DAILY_YIELD_KWH_PER_KWP=0` means expected-vs-actual target comparison stays disabled.

## Deployment
Replace the complete contents of the existing Master Dashboard GitHub repository with this ZIP and redeploy on Render. Existing secrets and API URLs remain compatible. PostgreSQL is migrated automatically with `ADD COLUMN IF NOT EXISTS`; old history remains intact.

---


## V25 — Straight Gauge Ends

- Gauge track and live gauge arcs now use flat/straight SVG ends (`stroke-linecap: butt`).
- V24 Energy Flow tab and all earlier fixes are preserved.
- CSS/JS asset versions bumped to avoid browser cache showing the old rounded gauges.


## V21 - Render cold-start auto wake

V21 automatically wakes the configured PV14000, PV9000, Matrix and Tuya Render services whenever the Master Dashboard itself starts. The UI shows `WAKING SOURCES` while the free Render services spin up, then loads live data automatically. You no longer need to open each upstream dashboard manually.

The wake logic is **on-demand only**. It does not add an external always-on keepalive service. It also rejects temporary non-JSON Render loading pages so they cannot be mistaken for real zero-value telemetry.
# Raja Fraz Master Dashboard - V20

V20 keeps the V19 Tuya monthly-history fixes and corrects live Tuya grid direction. Smart Life/Tuya **Consumption = Import** and **Generate = Export** whenever that status is present in the raw Tuya meter response.

Deploy with the existing Tuya V11 service, then deploy this Master V20 package.

# Raja Fraz Master Dashboard V17 — Tuya Live MDI Percentages

# Raja Fraz Master Solar Command Center - Three Inverter + Tuya Meter Edition

Professional master monitoring for the three-inverter topology plus the independent Tuya physical utility meter.

## Physical system

### System 01 - FRONUS META 10KW - PV14000
- AC output capacity: **10,000 W**
- Installed PV: **6,780 W**
- Role: primary solar inverter

### System 02 - FRONUS META 6KW - PV9000
- AC output capacity: **6,000 W**
- Installed PV: **4,360 W**
- Role: solar inverter + distribution source
- Feeds the **Matrix UPS AC input**
- Feeds **Smart Load directly**

### System 03 - FRONUS MATRIX 6KW
- AC output capacity: **6,000 W**
- Installed PV: **0 W**
- Role: **UPS / backup inverter**
- AC input is supplied from PV9000

## Master calculation rules

The dashboard is topology-aware to prevent double-counting.

- **Total solar = PV14000 solar + PV9000 solar**
- **Total installed PV = 6,780 + 4,360 = 11,140 W**
- **Utility grid = PV14000 utility grid + PV9000 utility grid**
- Matrix AC input is an internal PV9000 -> Matrix transfer and is **not** utility-grid power.
- Smart Load belongs to PV9000.
- By default, Matrix UPS load is downstream of PV9000 and is **not added again** to Master site demand.

## Render environment variables

Existing settings continue to work for the first inverter.

```text
PV14000_API_BASE=https://inverterzone-dashboard.onrender.com
META_DASHBOARD_USER=admin
META_DASHBOARD_PASSWORD=<existing dashboard password>
MATRIX_API_BASE=https://fronus-matrix-dashboard.onrender.com
```

New required variable for System 02:

```text
PV9000_API_BASE=<URL of the online FRONUS META 6KW - PV9000 dashboard/API>
```

If PV9000 uses the same Basic Auth password as PV14000, no additional password variable is needed. If it uses a different password, add:

```text
PV9000_DASHBOARD_PASSWORD=<PV9000 dashboard password>
```

Optional topology controls:

```text
PV9000_LOAD_INCLUDES_UPS=true
PV9000_LOAD_INCLUDES_SMART=false
```

Keep the defaults for the topology described above.

## Tuya physical grid meter

The Dashboard now includes a separate **TUYA REAL-TIME GRID IMPORT / EXPORT** panel. It reads the existing Tuya meter dashboard API and does **not** replace or modify the inverter-calculated grid values.

- Import gauge: **red**
- Export gauge: **green**
- Live gauge power comes from the Tuya meter active-power reading.
- Live direction now prioritizes the Tuya/Smart Life status when exposed in the raw meter response: **Consumption = Import** and **Generate = Export**. It then falls back to cumulative-counter changes and safe timestamp/recent-direction hints. Unsigned live watts are no longer blindly assumed to be Import.
- Grid voltage, current, power factor and meter temperature are also shown.

Default service:

```text
TUYA_API_BASE=https://tuya-meter-dashboard.onrender.com
```

The default is already included in `render.yaml`, so normally no manual Render variable is required.

## Online history

This edition stores new-topology samples in PostgreSQL table `master_samples_v3`. The old two-inverter history table remains untouched.

History includes PV14000, PV9000, Matrix UPS and topology-corrected combined samples.

## Dashboard layout

- **Dashboard:** PV14000 left, large Master totals center, PV9000 right, Matrix UPS strip below
- **PV14000:** individual 10 kW inverter telemetry
- **PV9000:** individual 6 kW solar + Smart Load telemetry
- **UPS Matrix:** PV-less UPS view with AC input, output load and battery
- **Combined:** topology-corrected master values
- **Charts:** 1H / 6H / 24H / 7D / 30D online history
- **Totals:** Today / Yesterday / This month / Last month
- **Health:** 3-source API status and active topology rules


## V11 UI adjustment
- Master center column slightly narrower; PV14000 and PV9000 side panels slightly wider.
- Master Battery gauge shows battery voltage instead of SOC in the lower-right reading.
- Battery gauge remains green while charging and red while discharging.


## V14 UI / integration update
- Adds Tuya physical grid meter to the main Master Dashboard.
- Separate real-time Import and Export gauges.
- Inverter utility-grid calculations remain unchanged for comparison.
- Existing V13 compact center layout and V12 battery power/mode/voltage gauge behavior are preserved.


## V15 Tuya true energy history

The Master Tuya panel now shows real physical meter energy for Today and This Month, plus a Day/Month selector. The Master proxies these requests to the Tuya dashboard so Tuya credentials remain only in the Tuya Render service.

This requires the companion **Tuya Grid Dashboard V9 History API** to be deployed first. The existing `TUYA_API_BASE` remains unchanged.

## V16 Tuya MDI gauge ranges
- Tuya Grid Import gauge maximum: **5 kW** (approved WAPDA load / MDI).
- Tuya Grid Export gauge maximum: **6 kW** (approved DG capacity / MDI).
- Live readings, daily/monthly history, and all other V15 functions are unchanged.


## V17 Tuya gauge percentages

The physical Tuya grid gauges now display live utilization against the approved limits: Import percentage uses 5 kW MDI and Export percentage uses 6 kW DG capacity. The arc remains capped visually at 100%, while the numeric percentage can exceed 100% so an MDI/DG limit exceedance is visible.


## V18 Tuya summary sync fix

- Live Tuya import percentage is calculated against the 5 kW approved import MDI.
- Live Tuya export percentage is calculated against the 6 kW approved DG/export capacity.
- The browser assets are cache-busted and the server disables static caching so new dashboard JavaScript loads immediately after deploy.
- Today's Tuya import/export cards now use `/api/energy-stats`, the same endpoint used by the standalone Tuya dashboard.
- Month totals are loaded independently from `/api/energy-range`, so a month-history problem no longer blanks the Today cards.
- Day/month selected-period results remain available and synchronize the matching quick-total cards.

## V20 Tuya live direction fix

- Smart Life/Tuya direction wording is now authoritative when it is present in `/api/meter` raw shadow properties: **Consumption = Grid Import** and **Generate = Grid Export**.
- The Master Dashboard scans raw Tuya property *values* for that status and never mistakes always-present DP names such as `reverse_energy_total` for live export.
- Fallback order is: explicit Tuya status → cumulative counter delta → counter update timestamp → recently confirmed direction.
- The old unsafe first-sample fallback that assumed all unsigned live power was IMPORTING has been removed. If direction cannot yet be proven, the live status shows `UNKNOWN` instead of putting the watts on the wrong gauge.
- Daily/monthly energy mapping is unchanged: forward energy remains Import and reverse energy remains Export.


## V22 - Professional energy icons
- Added embedded SVG icons across navigation, inverter panels, gauges, Tuya physical meter, UPS, charts, totals, health and dynamic detail cards.
- Solar, grid, battery, load, Smart Load, import/export, temperature and UPS use semantic icon accents.
- Icons are embedded in the dashboard itself; no external icon CDN or extra Render setting is required.
- V21 Render auto-wake and V20 Tuya direction fixes are preserved.

## V24 update - Energy Flow tab

This version keeps the V22 icon layout and adds a new **Energy Flow** tab.

The Energy Flow tab includes:

- Animated topology map for PV14000, PV9000, Matrix UPS, Tuya physical grid meter, battery, smart load and backup load.
- Direction-aware utility grid flow: import is red, export is green.
- Matrix UPS AC input is displayed as an internal PV9000 transfer and is still excluded from utility-grid totals.
- Battery flow changes direction for charging vs discharging.
- Mobile-friendly fallback layout.

No new Render environment variables are required.
