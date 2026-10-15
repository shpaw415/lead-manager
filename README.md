# lead-manager

Shared lead store (mini-CRM) for open-bot, built for SMEs: track leads with
name, company, phone, email, pipeline status, source, tags and notes, plus a
timestamped communication history per lead and file/image attachments
(10 MB max per file, upload via dashboard, CLI or REST).

- **Leads tab** (dashboard app): card grid with status pills, search, per-lead
  detail drawer with the communication timeline, add/edit/delete, quick
  status change. UI auto-detects the browser language (FR/EN).
- **CLI** `ob-plugin-lead-manager-lead`: JSON in/out, any plugin, cron job or
  agent can add, list, show, update, delete leads and append history notes.
- **REST API**: the same operations over HTTP — same-origin under the app
  tab, and publicly under `/hooks/lead-manager/` when the public endpoint is
  enabled (set the endpoint secret on the dashboard Plugins tab).
- Data lives in `~/.open-bot/pages-data/lead-manager/leads.json` (survives
  updates), guarded by a lock file shared by the CLI and the page server.
- No settings, no vault keys.

## Develop

```sh
ob-plugin validate ~/plugins-create/lead-manager
ob-plugin install --path ~/plugins-create/lead-manager
```

Edits are picked up by re-running `ob-plugin install --path` (or Re-install
on the Plugins page).

## Publish

```sh
git init -b main && git add -A && git commit -m "v1.0.0"
gh repo create shpaw415/lead-manager --public --source . --push
gh release create v1.0.0 -R shpaw415/lead-manager --notes "First release"
ob-plugin publish ~/plugins-create/lead-manager
ob-plugin install lead-manager
```

While staging, set `version` to a dev tag (e.g. `beta-1`) and use
`ob-plugin publish ~/plugins-create/lead-manager --dev`.
