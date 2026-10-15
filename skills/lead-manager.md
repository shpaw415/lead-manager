# lead-manager (integration skill)

Shared lead store for open-bot (CRM-style pipeline for small businesses):
leads with name, company, phone, email, status, source, tags, notes, plus a
timestamped communication history (call / email / meeting / sms / note) on
each lead. The user sees and edits everything in the **Leads** tab of the
dashboard. Other plugins, cron jobs and agents manage the same data through
the CLI.

**Language rule: always answer the user in their own language. Data values
(statuses, note types) are English API constants; translate them in your
reply. Never hardcode a language.**

## CLI: `ob-plugin-lead-manager-lead`

Output is always one JSON line: `{"ok":true|false, ...}`. Exit codes:
0 ok · 2 usage/validation · 3 store busy · 4 not found.

```sh
# create
ob-plugin-lead-manager-lead add --name "Jane Doe" --company "Acme" \
  --phone "+1 819 555 0123" --email "jane@acme.com" --status new \
  --source price-scout --tags "hot,web" --notes "Met at the trade show"

# consult
ob-plugin-lead-manager-lead list [--status new] [--source price-scout] [--q "acme"] [--limit 200]
ob-plugin-lead-manager-lead show lead_xxxx
ob-plugin-lead-manager-lead history lead_xxxx
ob-plugin-lead-manager-lead statuses      # pipeline statuses + note types

# modify (any subset of fields)
ob-plugin-lead-manager-lead update lead_xxxx --phone "+1 819 555 9999" --status contacted

# communication history
ob-plugin-lead-manager-lead note lead_xxxx --type call --text "Left a voicemail" --author plugin:my-plugin

# attachments (files & images, 10 MB max each, 50 per lead)
ob-plugin-lead-manager-lead attach lead_xxxx --file /path/devis.pdf [--name "Devis 2026"] [--author plugin:my-plugin]
ob-plugin-lead-manager-lead attachments lead_xxxx
ob-plugin-lead-manager-lead detach lead_xxxx att_xxxx

# remove
ob-plugin-lead-manager-lead delete lead_xxxx
```

- `--status` accepts: new, contacted, qualified, proposal, won, lost.
- `--source` is the origin of the lead (plugin id, form name, or manual).
- When a non-manual source creates a lead, the user gets a dashboard
  notification automatically.

## REST API (for external systems)

Same operations over HTTP when the public endpoint is enabled on the
dashboard (Plugins tab → Settings → Public endpoint; set the secret there
and callers pass `X-Open-Bot-Webhook-Secret` or `?secret=`):

```
GET    /api/leads?status=&q=&limit=
POST   /api/leads            {name, company?, phone?, email?, status?, source?, tags?, notes?}
GET    /api/leads/<id>
PATCH  /api/leads/<id>       {any subset of the fields above}
DELETE /api/leads/<id>
POST   /api/leads/<id>/notes {type: call|email|meeting|sms|note, text, author?}
GET    /api/leads/<id>/history
POST   /api/leads/<id>/attachments        multipart/form-data field "file" (or raw body + ?name=&mime=), 10 MB max
GET    /api/leads/<id>/attachments        list metadata
GET    /api/attachments/<attId>           download/serve the stored file
DELETE /api/leads/<id>/attachments/<attId>
GET    /api/stats
```

Responses are JSON with the same `{ok:true|false}` shape.

## Rules

- Avoid duplicates: run `list --q` on the name/email/company before `add`.
- Cite the returned `lead_xxxx` id so the user can follow up on it.
- Log every real contact as a `note` — the timeline is the shared memory
  between plugins and the user.
- The dashboard Leads tab is the visual source of truth; do not describe
  leads from memory, re-run `list`/`show`.
- No secrets in leads; this store is business contact data.
