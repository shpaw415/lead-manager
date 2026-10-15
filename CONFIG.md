# Configuring lead-manager with the user

One optional setting, everything else is zero-config:

## Settings

`api-token` (secret) — shared token for the public REST endpoint
(`/hooks/lead-manager/...`). Leave empty if only the dashboard tab and the
local CLI are used (they never need it). Set it when external systems
(website contact form, automations) must write leads over HTTP:

1. Generate one: `openssl rand -hex 24` (never reuse a real password).
2. Fill it on the dashboard: Plugins tab → lead-manager → Settings →
   "Public API token" (hidden field), or
   `ob-plugin settings lead-manager api-token=<value>` (never echo it).
3. Give the external caller the token and have it send the header
   `x-lead-manager-token: <value>` (or `?token=<value>`).

## Verify

- Dashboard tab **Leads**: add a lead — works without any token.
- Public endpoint without token → HTTP 401:
  `curl -i -X POST https://<public-endpoint>/api/leads -d '{"name":"x"}'`
- With the token → HTTP 201:
  `curl -i -X POST -H 'x-lead-manager-token: <value>' ...`
