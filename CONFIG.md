# Configuring lead-manager with the user

Nothing to configure: lead-manager has no settings and no vault keys.
Data is stored locally on the desktop in
`~/.open-bot/pages-data/lead-manager/leads.json`.

Optional, for external systems only: on the dashboard Plugins tab →
Settings → Public endpoint, copy the URL and set a secret so outside
callers (website forms, automations) authenticate with
`X-Open-Bot-Webhook-Secret` or `?secret=`.

Verify: open the **Leads** tab in the dashboard drawer, add a lead, and run
`ob-plugin-lead-manager-lead list` — the lead appears on both sides.
