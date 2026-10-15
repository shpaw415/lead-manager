#!/usr/bin/env bun
/**
 * ob-plugin-lead-manager-lead — CLI of the lead-manager plugin.
 *
 * Inter-plugin contract: any plugin, cron job or agent can add, list, show,
 * update and delete leads, and append communication-history entries.
 * Output is always single-line JSON: {"ok":true|false,...}
 * Data lives in ~/.open-bot/pages-data/lead-manager/leads.json, shared with
 * the dashboard page server, guarded by an O_EXCL lock file.
 *
 * Exit codes: 0 ok · 2 usage/validation · 3 busy (lock) · 4 not found
 */
import { openSync, closeSync, unlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const PLUGIN_ID = "lead-manager";
const DATA_DIR = join(homedir(), ".open-bot", "pages-data", PLUGIN_ID);
const DATA_FILE = join(DATA_DIR, "leads.json");
const LOCK_FILE = join(DATA_DIR, "leads.lock");
const FILES_DIR = join(DATA_DIR, "files");
const LOCK_STALE_S = 10;
const LOCK_WAIT_S = 5;

const STATUSES = ["new", "contacted", "qualified", "proposal", "won", "lost"];
const NOTE_TYPES = ["call", "email", "meeting", "sms", "note"];
const MAX_FILE = 10 * 1024 * 1024; // 10 MB per attachment

/**
 * Exit signal: out() throws instead of calling process.exit() so that any
 * `finally { lock.exit() }` on the stack still runs — process.exit() would
 * skip it and leak the lock file.
 */
class ExitSignal extends Error {}
function out(obj: any, code = 0): never {
  console.log(JSON.stringify(obj));
  process.exitCode = code;
  throw new ExitSignal();
}
function fail(erreur: string, code = 2): never {
  out({ ok: false, erreur }, code);
}

// ---------- lock ----------
class Lock {
  fd: number | null = null;
  enter() {
    mkdirSync(DATA_DIR, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_S * 1000;
    for (;;) {
      try {
        this.fd = openSync(LOCK_FILE, "wx");
        return;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        try {
          if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_S * 1000) {
            unlinkSync(LOCK_FILE); // stale lock from a crashed process
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) fail(`lead store busy (lock > ${LOCK_WAIT_S}s)`, 3);
        Bun.sleepSync(50);
      }
    }
  }
  exit() {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
}

// ---------- store ----------
type Note = { id: string; at: string; type: string; text: string; author: string };
type Att = { id: string; name: string; safe: string; mime: string; size: number; at: string; author: string };
type Lead = {
  id: string; name: string; company: string; phone: string; email: string;
  status: string; source: string; tags: string[]; notes: string;
  createdAt: string; updatedAt: string; history: Note[]; attachments?: Att[];
};
type Store = { leads: Lead[] };

function load(): Store {
  try {
    const d = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    if (d && Array.isArray(d.leads)) return d as Store;
  } catch {}
  return { leads: [] };
}
function save(d: Store) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(d, null, 1));
  renameSync(tmp, DATA_FILE);
}
function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
function nowIso() {
  return new Date().toISOString();
}

// ---------- validation ----------
function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function checkLead(l: Lead) {
  if (!l.name) fail("name is required");
  if (l.name.length > 200) fail("name too long (200 max)");
  if (l.company.length > 200) fail("company too long (200 max)");
  if (l.phone.length > 60) fail("phone too long (60 max)");
  if (l.email) {
    if (l.email.length > 200) fail("email too long (200 max)");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(l.email)) fail(`invalid email: ${l.email}`);
  }
  if (l.source.length > 40) fail("source too long (40 max)");
  if (l.notes.length > 5000) fail("notes too long (5000 max)");
  if (!/^[a-z0-9_-]{1,24}$/.test(l.status)) fail(`invalid status: ${l.status}`);
  if (l.tags.length > 10) fail("too many tags (10 max)");
  for (const t of l.tags) {
    if (!t || t.length > 40) fail("each tag must be 1-40 chars");
  }
}
function checkNote(n: Note) {
  if (!NOTE_TYPES.includes(n.type)) fail(`invalid note type: ${n.type} (expected ${NOTE_TYPES.join("|")})`);
  if (!n.text) fail("note text is required");
  if (n.text.length > 5000) fail("note text too long (5000 max)");
  if (n.author.length > 60) fail("author too long (60 max)");
}
function parseTags(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(",").map((t) => t.trim()).filter(Boolean);
}

// ---------- attachments ----------
function sanitizeName(v: unknown): string {
  let s = String(v == null ? "" : v).split(/[\\/]/).pop() || "";
  s = s.replace(/[\x00-\x1f\x7f"'`;]/g, "").trim();
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 ? s.slice(dot).slice(0, 12) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || "fichier";
}
function guessMime(path: string): string {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip", json: "application/json",
  };
  return m[ext] || "application/octet-stream";
}
const attPath = (leadId: string, a: Att) => join(FILES_DIR, leadId, `${a.id}__${a.safe}`);

function cmdAttach(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const src = s(a.file);
  if (!src) fail("--file /path/to/file required");
  if (!existsSync(src)) fail("file not found: " + src, 2);
  const st = statSync(src);
  if (!st.isFile()) fail("not a file: " + src);
  if (st.size > MAX_FILE) fail("file too large (10 MB max)");
  const data = readFileSync(src);
  const att: Att = {
    id: newId("att"),
    name: sanitizeName(a.name || basename(src)),
    safe: sanitizeName(a.name || basename(src)).replace(/[^\w.\- ]+/g, "_") || "fichier",
    mime: s(a.mime) || guessMime(src),
    size: st.size,
    at: nowIso(),
    author: s(a.author) || "manual",
  };
  if (att.author.length > 60) fail("author too long (60 max)");
  const dir = join(FILES_DIR, id);
  mkdirSync(dir, { recursive: true });
  const p = attPath(id, att);
  writeFileSync(p, data);
  try {
    const lock = new Lock();
    lock.enter();
    try {
      const d = load();
      const lead = findOrDie(d, id);
      if (!lead.attachments) lead.attachments = [];
      if (lead.attachments.length >= 50) fail("too many attachments (50 max)");
      lead.attachments.push(att);
      lead.updatedAt = nowIso();
      save(d);
    } finally {
      lock.exit();
    }
  } catch (e) {
    try { unlinkSync(p); } catch {}
    throw e;
  }
  out({ ok: true, attachment: att });
}

function cmdAttachments(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const lock = new Lock();
  lock.enter();
  let d: Store;
  try {
    d = load();
  } finally {
    lock.exit();
  }
  const lead = findOrDie(d, id);
  const attachments = lead.attachments || [];
  out({ ok: true, count: attachments.length, attachments });
}

function cmdDetach(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  const attId = pos[1] ?? s(a.attachment);
  if (!id || !attId) fail("lead id and attachment id required");
  const lock = new Lock();
  lock.enter();
  try {
    const d = load();
    const lead = findOrDie(d, id);
    const att = (lead.attachments || []).find((x) => x.id === attId);
    if (!att) fail("attachment not found: " + attId, 4);
    lead.attachments = lead.attachments!.filter((x) => x.id !== attId);
    lead.updatedAt = nowIso();
    save(d);
    try { unlinkSync(attPath(id, att)); } catch {}
    out({ ok: true, deleted: att });
  } finally {
    lock.exit();
  }
}

// ---------- CLI parsing ----------
type Args = Record<string, string | boolean>;
function parseArgs(argv: string[]): { cmd: string; pos: string[]; a: Args } {
  const cmd = argv[0] ?? "help";
  const pos: string[] = [];
  const a: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith("--")) {
        a[key] = true;
      } else {
        a[key] = nxt;
        i++;
      }
    } else pos.push(t);
  }
  return { cmd, pos, a };
}

function notify(title: string, body: string) {
  try {
    Bun.spawnSync(["ob-plugin", "notify", PLUGIN_ID, title, body], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

// ---------- commands ----------
function cmdAdd(a: Args) {
  const lead: Lead = {
    id: newId("lead"),
    name: s(a.name),
    company: s(a.company),
    phone: s(a.phone),
    email: s(a.email),
    status: s(a.status) || "new",
    source: s(a.source) || "manual",
    tags: parseTags(a.tags as string | undefined),
    notes: s(a.notes),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [],
  };
  checkLead(lead);
  const lock = new Lock();
  lock.enter();
  try {
    const d = load();
    d.leads.push(lead);
    save(d);
  } finally {
    lock.exit();
  }
  if (lead.source !== "manual") {
    notify("New lead", `${lead.name} (source: ${lead.source})`);
  }
  out({ ok: true, lead });
}

function applyFilter(leads: Lead[], a: Args): Lead[] {
  let r = leads;
  if (a.status) r = r.filter((l) => l.status === s(a.status));
  if (a.source) r = r.filter((l) => l.source === s(a.source));
  if (a.q) {
    const q = s(a.q).toLowerCase();
    r = r.filter((l) =>
      [l.name, l.company, l.phone, l.email, l.notes, l.tags.join(" ")].join(" ").toLowerCase().includes(q)
    );
  }
  return r;
}

function cmdList(a: Args) {
  const lock = new Lock();
  lock.enter();
  let d: Store;
  try {
    d = load();
  } finally {
    lock.exit();
  }
  const leads = applyFilter(d.leads, a).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
  const limit = Math.max(1, Math.min(1000, parseInt(s(a.limit) || "200", 10) || 200));
  out({ ok: true, count: leads.length, leads: leads.slice(0, limit) });
}

function findOrDie(d: Store, id: string): Lead {
  const l = d.leads.find((x) => x.id === id);
  if (!l) fail("lead not found: " + id, 4);
  return l;
}

function cmdShow(_cmd: string, a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const lock = new Lock();
  lock.enter();
  let d: Store;
  try {
    d = load();
  } finally {
    lock.exit();
  }
  out({ ok: true, lead: findOrDie(d, id) });
}

const FIELDS = ["name", "company", "phone", "email", "status", "source", "notes"] as const;

function cmdUpdate(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const lock = new Lock();
  lock.enter();
  try {
    const d = load();
    const lead = findOrDie(d, id);
    let touched = false;
    for (const f of FIELDS) {
      if (a[f] !== undefined) {
        (lead as any)[f] = s(a[f] as string);
        touched = true;
      }
    }
    if (a.tags !== undefined) {
      lead.tags = parseTags(a.tags as string);
      touched = true;
    }
    if (!touched) fail("nothing to update (use --name, --company, --phone, --email, --status, --source, --tags, --notes)");
    checkLead(lead);
    lead.updatedAt = nowIso();
    save(d);
    out({ ok: true, lead });
  } finally {
    lock.exit();
  }
}

function cmdDelete(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const lock = new Lock();
  lock.enter();
  try {
    const d = load();
    const lead = findOrDie(d, id);
    d.leads.splice(d.leads.indexOf(lead), 1);
    save(d);
    try { rmSync(join(FILES_DIR, id), { recursive: true, force: true }); } catch {}
    out({ ok: true, deleted: lead });
  } finally {
    lock.exit();
  }
}

function cmdNote(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const note: Note = {
    id: newId("note"),
    at: nowIso(),
    type: s(a.type) || "note",
    text: s(a.text),
    author: s(a.author) || "manual",
  };
  checkNote(note);
  const lock = new Lock();
  lock.enter();
  try {
    const d = load();
    const lead = findOrDie(d, id);
    lead.history.push(note);
    lead.updatedAt = nowIso();
    save(d);
    out({ ok: true, note, lead });
  } finally {
    lock.exit();
  }
}

function cmdHistory(a: Args, pos: string[]) {
  const id = pos[0] ?? s(a.id);
  if (!id) fail("lead id required");
  const lock = new Lock();
  lock.enter();
  let d: Store;
  try {
    d = load();
  } finally {
    lock.exit();
  }
  const lead = findOrDie(d, id);
  const history = [...lead.history].sort((x, y) => (x.at > y.at ? 1 : -1));
  out({ ok: true, count: history.length, history });
}

function cmdStatuses() {
  out({ ok: true, statuses: STATUSES, noteTypes: NOTE_TYPES });
}

// ---------- main ----------
const HELP = `ob-plugin-lead-manager-lead — lead store for open-bot plugins (JSON output)

  add    --name "Jane Doe" [--company] [--phone] [--email] [--status new] [--source manual] [--tags a,b] [--notes]
  list   [--status] [--source] [--q text] [--limit 200]
  show   <lead_id>
  update <lead_id> [--name] [--company] [--phone] [--email] [--status] [--source] [--tags] [--notes]
  delete <lead_id>
  note   <lead_id> --text "..." [--type call|email|meeting|sms|note] [--author manual]
  history <lead_id>
  attach  <lead_id> --file /path [--name custom] [--author manual]
  attachments <lead_id>
  detach  <lead_id> <att_id>
  statuses        — list pipeline statuses and note types`;

const { cmd, pos, a } = parseArgs(process.argv.slice(2));
try {
  switch (cmd) {
    case "add": cmdAdd(a); break;
    case "list": cmdList(a); break;
    case "show":
    case "get": cmdShow(cmd, a, pos); break;
    case "update": cmdUpdate(a, pos); break;
    case "delete":
    case "rm": cmdDelete(a, pos); break;
    case "note": cmdNote(a, pos); break;
    case "history": cmdHistory(a, pos); break;
    case "attach": cmdAttach(a, pos); break;
    case "attachments":
    case "files": cmdAttachments(a, pos); break;
    case "detach": cmdDetach(a, pos); break;
    case "statuses": cmdStatuses(); break;
    default: out({ ok: false, erreur: "unknown command", help: HELP }, 2);
  }
} catch (e) {
  if (!(e instanceof ExitSignal)) throw e;
}
