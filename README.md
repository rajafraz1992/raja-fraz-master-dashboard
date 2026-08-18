# Raja Fraz Master Solar Dashboard - V33 DEVICE PHOTO FLOW

V33 keeps the complete V32 ULTRA PRO MAX dashboard and rebuilds the **Energy Flow** tab around the real physical topology. Every live hardware/load node now has a local PNG visual, clearer source-to-destination routing, colored arrowheads and the existing direction-aware animation.

## V33 highlights
- Real product visuals for **Fronus Meta 10KW PV14000**, **Fronus Meta 6KW PV9000**, **Fronus Matrix 6KW UPS** and the **Tuya bidirectional physical meter**.
- PNG visuals for the WAPDA utility grid, master AC distribution bus, main estate load, PV9000 smart motor load, essential UPS load and battery bank.
- Enlarged premium device cards with readable live power, status and sub-metrics.
- Explicit colored arrowheads for solar, grid import/export, site demand, smart load, internal PV9000 → Matrix feed, UPS output and bidirectional battery power.
- Correct topology preserved: Matrix AC input remains an internal PV9000 transfer and is not counted as utility-grid import.
- Responsive mobile Flow layout keeps every device photo and live reading visible without the desktop routing canvas.
- Image-source ledger included in `IMAGE-SOURCES.md`.

No new required environment variables are needed for V33.

---

# Raja Fraz Master Solar Dashboard - V32 ULTRA PRO MAX

V32 keeps the complete V31 AI + notification center and adds a premium **ULTRA Mission Control** layer without changing any inverter, Tuya breaker, Smart Life protection or electrical control setting.

## V32 highlights
- New **ULTRA** top-navigation tab with a dark NOC / control-room presentation.
- Dashboard-wide **Mission Control ribbon** with estate score, solar coverage, grid independence and data-confidence KPIs.
- **Estate Health Index (0-100)** based on source freshness, active grid guard, battery reserve and temperature.
- **Live Power Matrix** for solar, demand, physical grid and UPS battery.
- **Energy Autopilot rings** for instantaneous solar coverage, grid independence and source confidence.
- **Power Pulse chart** using existing PostgreSQL/live history, with live solar/load/grid trend deltas.
- **Power Quality panel** using Tuya voltage/current/PF plus inverter AC frequency reference.
- **Digital Asset Wall** for PV14000, PV9000, Matrix UPS and Tuya meter.
- **Flight Recorder** that logs live state changes such as source online/offline, grid direction, battery mode and guard-zone transitions.
- **Operator Intelligence** that turns current telemetry into prioritized actions without using AI credits.
- **Daily Mission KPIs** for solar, import/export, kWh/kWp yield, PV utilization, UPS load and synchronization age.
- Full-screen Mission Control button for inverter-room / NOC displays.
- Existing V31 Gemini AI, browser/Telegram/Twilio notification framework, V28 energy-flow animation, V27 display mode and all historical/financial/intelligence features are preserved.

No new required environment variables are needed for V32.

---

# Raja Fraz Master Dashboard V31 - AI CONTROL-ROOM UI + SMART PUSH ALERTS

V31 keeps every V30/V28 feature and adds two major upgrades: **rich AI briefing cards** instead of raw/boring Markdown, plus a **multi-channel notification center** for browser/Web Push, Telegram, WhatsApp and SMS. All alerts remain monitoring-only; no notification path can switch Tuya or write inverter settings.

## 1) AI responses now look like a control-room briefing
- Markdown is safely rendered into headings, bold readings, compact bullets and action blocks instead of showing raw `###` / `**` text.
- The Solar Copilot prompt now starts with a punchy status/verdict and uses emoji-led sections such as Live Verdict, Key Numbers, Why, What To Do and Urgency.
- Existing Gemini free-tier configuration, live telemetry attachment, PIN protection and read-only safety remain unchanged.

## 2) New Alerts tab
The top navigation now includes **Alerts** with live channel status, browser subscription controls, test buttons, alert policy and PostgreSQL-backed delivery history.

Automatic rules include:
- Night grid import warning at 90% and critical above `NIGHT_IMPORT_LIMIT_W` (default 5000 W).
- Day grid export warning at 90% and critical above `DAY_EXPORT_LIMIT_W` (default 6000 W).
- PV14000 / PV9000 / Matrix / Tuya connectivity and stale-data alerts.
- UPS battery low-SOC alert.
- High-temperature alert.
- Tuya physical meter versus inverter grid reconciliation alert.
- Anti-spam cooldown plus recovery messages when a condition clears.

### Browser notifications - zero external provider
Click **Alerts → Enable browser alerts**.
- Without VAPID keys: local system notifications work while the dashboard is open.
- With VAPID keys: the browser can register for standards-based Web Push and receive server-pushed notifications in the background when supported.

For full Web Push, generate one VAPID pair once:

```bash
npm install
npm run vapid
```

Then copy the generated values to Render Environment:

```text
VAPID_PUBLIC_KEY=<generated public key>
VAPID_PRIVATE_KEY=<generated private key>
VAPID_SUBJECT=https://raja-fraz-master-dashboard.onrender.com
```

Keep `VAPID_PRIVATE_KEY` secret. After redeploying, open the dashboard on each phone/PC that should receive push alerts and click **Enable browser alerts** once.

### Telegram - recommended free remote channel
Create a Telegram bot with **@BotFather**, send `/start` to the bot, obtain your numeric chat ID, then add:

```text
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<your chat id>
```

Redeploy, then use **Alerts → Send Telegram test**.

### WhatsApp - optional Twilio channel
Add:

```text
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<secret>
TWILIO_WHATSAPP_FROM=whatsapp:+<sender>
TWILIO_WHATSAPP_TO=whatsapp:+<recipient>
```

Optional approved-template support:

```text
TWILIO_WHATSAPP_CONTENT_SID=<content template sid>
```

Twilio/WhatsApp account rules and messaging charges can apply. Production business-initiated WhatsApp alerts may require an approved template.

### SMS - optional Twilio channel
Add:

```text
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<secret>
TWILIO_SMS_FROM=+<Twilio sender number>
TWILIO_SMS_TO=+<your phone number>
```

SMS charges/regulatory requirements depend on sender/recipient country.

### Alert security and tuning
`NOTIFY_ACCESS_PIN` is optional. If blank, V31 automatically reuses `AI_ACCESS_PIN`.

```text
NOTIFY_ACCESS_PIN=<optional private PIN>
ALERT_COOLDOWN_MINUTES=30
ALERT_STALE_SECONDS=180
BATTERY_LOW_PCT=20
NOTIFY_DASHBOARD_URL=https://raja-fraz-master-dashboard.onrender.com
```

The wall display/browser continuously polling the Master keeps the Render service active while it is in use. Remote server-side alerts run from the existing background telemetry collector while the Master service is awake.

## Deployment
Replace the complete contents of the existing Master Dashboard GitHub repository with this V31 ZIP and redeploy on Render. Existing V30 variables remain valid; new notification variables are optional. The dashboard works normally even if no remote notification provider is configured.

---

# Raja Fraz Master Dashboard V30 - GEMINI FREE AI COPILOT

V30 keeps every V29/V28/V26 feature and changes the AI layer so **Google Gemini is the primary provider**, designed to work with Gemini API free-tier access where available. OpenAI remains an optional fallback only; no OpenAI credits are required when Gemini is configured and working.

## V30 AI setup (no OpenAI credit required)
Create a Gemini API key in **Google AI Studio**, then add this Render Environment variable:

```text
GEMINI_API_KEY=<your Gemini API key>
```

Recommended/default model:

```text
GEMINI_MODEL=gemini-3.1-flash-lite
```

Optional dashboard protection:

```text
AI_ACCESS_PIN=<your private PIN>
```

Optional OpenAI fallback (leave blank if you have no OpenAI API credit):

```text
OPENAI_API_KEY=<optional>
OPENAI_MODEL=gpt-5.6
```

The AI key is used only by the Node server and is never sent to browser JavaScript. The existing `/api/master/ai/chat` endpoint remains **read-only** and attaches the live Master telemetry snapshot server-side. It has no breaker, inverter, Smart Life, or Tuya write tools.

### Provider behavior
- If `GEMINI_API_KEY` exists, Gemini is used first.
- Default model is the stable `gemini-3.1-flash-lite`.
- If Gemini fails and an `OPENAI_API_KEY` is also configured, V30 can fall back to OpenAI.
- If only Gemini is configured, a Gemini quota/region/API error is shown clearly instead of attempting any control action.
- Existing per-IP AI rate limiting and optional `AI_ACCESS_PIN` protection remain enabled.

### Free-tier note
Gemini API free-tier access and quotas depend on the Google project, model and supported region. Google's current documentation lists `gemini-3.1-flash-lite` as having Gemini API free-tier access. Free-tier submitted content can be used by Google to improve its products; use paid-tier terms if that data handling is not acceptable.

## Deployment
Replace the complete contents of the existing Master Dashboard GitHub repository with this V30 ZIP and redeploy on Render. Existing inverter/Tuya/PostgreSQL variables remain unchanged. Then add `GEMINI_API_KEY` in Render Environment and restart/redeploy.

---

# Raja Fraz Master Dashboard V29 - AI COPILOT

V29 keeps all V28 animated wall-display fixes and V26/V27 intelligence features, and adds a server-side **Solar AI Copilot** powered through the OpenAI Responses API.

## New AI Copilot
- New **AI Copilot** tab in the Master Dashboard.
- Automatically attaches a fresh read-only telemetry snapshot: PV14000, PV9000, Matrix UPS, Tuya physical meter, guardrails, analytics and today energy.
- One-click diagnostics for whole-site analysis, maintenance briefing, grid-limit risk, inverter comparison, UPS/battery health and meter reconciliation.
- Multi-turn chat with a short browser session history.
- AI is intentionally **read-only**: no breaker switching, no inverter writes, no Smart Life protection changes, and no RAW Tuya DP control tools.
- API key stays server-side in Render; it is never embedded in HTML/JavaScript.
- Requests are on-demand only and rate-limited.
- OpenAI Responses calls set `store: false`.

## Required Render settings for AI
Add these under the Master Dashboard service → Environment:

```text
OPENAI_API_KEY=<your OpenAI API project key>
AI_ACCESS_PIN=<a private PIN you choose>
```

Recommended/default settings included in `render.yaml`:

```text
OPENAI_MODEL=gpt-5.6
AI_MAX_OUTPUT_TOKENS=900
AI_RATE_LIMIT_REQUESTS=12
```

`AI_ACCESS_PIN` is strongly recommended because the Master Dashboard URL may be reachable from the public internet. The PIN is entered in the AI tab and stored only in that browser's local storage.

The dashboard continues to work normally if `OPENAI_API_KEY` is not configured; only the AI tab remains disabled.

---

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
