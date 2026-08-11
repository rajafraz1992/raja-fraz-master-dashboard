# Raja Fraz Master Solar Command Center V5

Professional combined monitoring for Fronus Meta PV9000 + Fronus Matrix 6K.

## V5 changes
- Fixed Meta energy totals parsing by recursively unwrapping the InverterZone `/api/energy` response.
- Today / Yesterday / This month / Last month now combine Meta + Matrix totals.
- Enlarged the center Master gauges and widened the Combined Site panel.
- Preserves PostgreSQL online history, live monitoring, Raja Fraz branding, and existing Render environment variables.

## Master totals rule
Combined = Meta + Matrix for solar, load, grid import, and grid export.

Deploy by replacing the existing repository contents and letting the Render Blueprint sync/redeploy.
