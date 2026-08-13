# Raja Fraz Master Solar Command Center - Three Inverter Edition

Professional master monitoring for the new three-inverter topology.

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
