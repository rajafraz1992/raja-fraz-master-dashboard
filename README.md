# Raja Fraz Master Solar Command Center V3 PRO

Professional master dashboard combining:

- Fronus Meta PV9000 / InverterZone
- Fronus Matrix 6K / SOLARMAN Business
- Large combined master gauges and live total site intelligence
- Individual Meta and Matrix pages
- Combined charts, totals, health and diagnostics
- Raja Fraz portrait branding
- PostgreSQL-backed online history

## V3 improvements

- Larger center **MASTER TOTAL** panel
- Bigger Total Solar, Total Demand, Grid and Smart Load gauges
- Wider center command-center layout
- Online history status shown in the dashboard
- 1H / 6H / 24H / 7D / 30D history ranges
- PostgreSQL samples at 60-second intervals
- `/api/master/collect` endpoint for an external scheduler if you later want continuous collection while the Free web service would otherwise sleep
- `/api/master/history/status` for database diagnostics

## Render Blueprint

The included `render.yaml` creates:

1. `raja-fraz-master-dashboard` web service
2. `raja-fraz-master-history` PostgreSQL database
3. `DATABASE_URL` automatically linked from the database to the dashboard

The existing Meta password stays secret in Render:

- `META_DASHBOARD_PASSWORD`

Other configured values:

- `META_API_BASE=https://inverterzone-dashboard.onrender.com`
- `META_DASHBOARD_USER=admin`
- `MATRIX_API_BASE=https://fronus-matrix-dashboard.onrender.com`
- `ELECTRICITY_RATE_PKR=60`
- `HISTORY_SAMPLE_SECONDS=60`

## Important Render Free note

The project is configured with a Free Render Postgres database for easy setup. Free Render Postgres is suitable for testing/hobby use but expires after 30 days. Upgrade that database before expiry if you want the history retained long-term.

Also, a Free Render web service sleeps after inactivity. The server records history once per minute while it is awake, and every live dashboard request also keeps the service active. For unattended 24/7 collection, use an always-on web service or schedule requests to `/api/master/collect`.
