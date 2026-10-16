/**
 * lead-manager — dashboard page server (Bun).
 *
 * Serves the Leads app UI (index.html) and a JSON REST API for the same
 * origins the control plane uses:
 *   - app tab (same-origin proxy): /api/pages/lead-manager/api/...
 *   - public endpoint (if enabled): /hooks/lead-manager/api/...
 *   - direct loopback:                             /api/...
 * Treats every request as untrusted input: all payloads are validated and
 * length-capped. Shares leads.json with the CLI via an O_EXCL lock file.
 */
import { openSync, closeSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "lead-manager";
const DATA_DIR = join(homedir(), ".open-bot", "pages-data", PLUGIN_ID);
const DATA_FILE = join(DATA_DIR, "leads.json");
const LOCK_FILE = join(DATA_DIR, "leads.lock");
const FILES_DIR = join(DATA_DIR, "files");
const LOCK_STALE_S = 10;
const LOCK_WAIT_S = 5;

const STATUSES = ["new", "contacted", "qualified", "proposal", "won", "lost"];
const NOTE_TYPES = ["call", "email", "meeting", "sms", "note"];
const MAX_BODY = 262144; // 256 KB
const MAX_FILE = 10 * 1024 * 1024; // 10 MB per attachment

type Note = { id: string; at: string; type: string; text: string; author: string };
type Att = { id: string; name: string; safe: string; mime: string; size: number; at: string; author: string };
type Lead = {
  id: string; name: string; company: string; phone: string; email: string;
  status: string; source: string; tags: string[]; notes: string;
  createdAt: string; updatedAt: string; history: Note[]; attachments?: Att[];
};

// ---------- lock / store ----------
function withLock<T>(fn: () => T): T {
  mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_S * 1000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(LOCK_FILE, "wx");
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_S * 1000) {
          unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("lead store busy");
      Bun.sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
}
function load(): { leads: Lead[] } {
  try {
    const d = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    if (d && Array.isArray(d.leads)) return d;
  } catch {}
  return { leads: [] };
}
function save(d: { leads: Lead[] }) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(d, null, 1));
  renameSync(tmp, DATA_FILE);
}
const nowIso = () => new Date().toISOString();
const newId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------- attachments ----------
function sanitizeName(v: unknown): string {
  let s = String(v == null ? "" : v).split(/[\\/]/).pop() || "";
  s = s.replace(/[\x00-\x1f\x7f"''"";]/g, "").trim();
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 ? s.slice(dot).slice(0, 12) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || "fichier";
}
function cleanMime(v: unknown): string {
  const m = String(v == null ? "" : v).trim().toLowerCase();
  const safe = /^[\w.+-]+\/[\w.+-]{1,60}$/.test(m) ? m : "application/octet-stream";
  // script-capable formats are stored inert: they must never execute in a browser
  if (/svg|html|xml|xhtml|javascript|ecmascript|script/i.test(safe)) return "application/octet-stream";
  return safe;
}
const INLINE_MIME = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf)$/;
const attPath = (leadId: string, a: Att) => join(FILES_DIR, leadId, `${a.id}__${a.safe}`);
const ID_RE = /^(lead|att|note)_[a-z0-9_]{1,64}$/;

function findAtt(leadId: string, attId: string): { lead: Lead; att: Att } | null {
  const lead = withLock(() => load()).leads.find((l) => l.id === leadId);
  const att = lead?.attachments?.find((a) => a.id === attId);
  return lead && att ? { lead, att } : null;
}

async function saveAttachment(leadId: string, data: Uint8Array, rawName: string, mime: string, author: string): Promise<Att> {
  if (data.byteLength > MAX_FILE) throw new Error("file too large (10 MB max)");
  if (data.byteLength === 0) throw new Error("empty file");
  const att: Att = {
    id: newId("att"),
    name: sanitizeName(rawName),
    safe: sanitizeName(rawName).replace(/[^\w.\- ]+/g, "_") || "fichier",
    mime: cleanMime(mime),
    size: data.byteLength,
    at: nowIso(),
    author: str(author, 60, "author") || "api",
  };
  const dir = join(FILES_DIR, leadId);
  mkdirSync(dir, { recursive: true });
  const p = attPath(leadId, att);
  writeFileSync(p, data);
  try {
    const added = withLock(() => {
      const d = load();
      const lead = d.leads.find((l) => l.id === leadId);
      if (!lead) return false;
      if (!lead.attachments) lead.attachments = [];
      if (lead.attachments.length >= 50) throw new Error("too many attachments (50 max)");
      lead.attachments.push(att);
      lead.updatedAt = nowIso();
      save(d);
      return true;
    });
    if (!added) {
      try { unlinkSync(p); } catch {}
      throw new Error("lead not found: " + leadId);
    }
  } catch (e) {
    try { unlinkSync(p); } catch {}
    throw e;
  }
  return att;
}

// ---------- validation ----------
function str(v: unknown, max: number, label: string, required = false): string {
  const x = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  if (required && !x) throw new Error(label + " is required");
  if (x.length > max) throw new Error(label + " too long (" + max + " max)");
  return x;
}
function cleanTags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const tags = arr.map((t) => String(t).trim()).filter(Boolean);
  if (tags.length > 10) throw new Error("too many tags (10 max)");
  for (const t of tags) if (t.length > 40) throw new Error("each tag must be 1-40 chars");
  return tags;
}
function checkLead(l: Lead) {
  str(l.name, 200, "name", true);
  str(l.company, 200, "company");
  str(l.phone, 60, "phone");
  const email = str(l.email, 200, "email");
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("invalid email");
  str(l.source, 40, "source");
  str(l.notes, 5000, "notes");
  if (!/^[a-z0-9_-]{1,24}$/.test(l.status)) throw new Error("invalid status: " + l.status);
}

// ---------- API ----------
function json(res: unknown, status = 200): Response {
  // Same-origin everywhere (dashboard proxy or loopback): no CORS headers —
  // a wildcard origin would let any website read the lead store from the
  // user's browser.
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function listLeads(url: URL) {
  let leads = withLock(() => load()).leads;
  const status = url.searchParams.get("status");
  const source = url.searchParams.get("source");
  const q = (url.searchParams.get("q") || "").toLowerCase();
  if (status) leads = leads.filter((l) => l.status === status);
  if (source) leads = leads.filter((l) => l.source === source);
  if (q)
    leads = leads.filter((l) =>
      [l.name, l.company, l.phone, l.email, l.notes, l.tags.join(" ")].join(" ").toLowerCase().includes(q)
    );
  leads = leads.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
  return json({ ok: true, count: leads.length, leads: leads.slice(0, limit) });
}

function stats() {
  const leads = withLock(() => load()).leads;
  const byStatus: Record<string, number> = {};
  for (const st of STATUSES) byStatus[st] = 0;
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  return json({ ok: true, total: leads.length, byStatus });
}

async function readBody(req: Request): Promise<any> {
  const body = await req.text();
  if (body.length > MAX_BODY) throw new Error("body too large (256 KB max)");
  if (!body) return {};
  return JSON.parse(body);
}

// ---------- public endpoint auth ----------
// The public /hooks/<id>/ path is internet-facing: EVERY API call on it requires
// the shared token configured in the plugin settings (writeToken). The
// same-origin app tab and local (loopback) access stay token-free.
function readWriteToken(): string {
  const env = process.env.LEAD_MANAGER_TOKEN;
  if (env) return env;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".config", "open-bot", `plugin-${PLUGIN_ID}.json`), "utf8"));
    const v = cfg?.settings?.["api-token"] ?? cfg?.["api-token"] ?? cfg?.configs?.["api-token"] ?? "";
    return String(v);
  } catch {
    return "";
  }
}
function checkPublicAuth(req: Request, url: URL): Response | null {
  const expected = readWriteToken();
  const given = req.headers.get("x-lead-manager-token") || url.searchParams.get("token") || "";
  if (!expected || given !== expected) {
    return json({ ok: false, erreur: "unauthorized: set the writeToken plugin setting and send it as the x-lead-manager-token header (or ?token=)" }, 401);
  }
  return null;
}

async function handleApi(req: Request, path: string, url: URL, isPublic: boolean): Promise<Response> {
  const seg = path.split("/").filter(Boolean); // e.g. ["api","leads","lead_x","notes"]
  if (seg[0] !== "api") return json({ ok: false, erreur: "not found" }, 404);
  if (isPublic) {
    const denied = checkPublicAuth(req, url);
    if (denied) return denied;
  }
  const rest = seg.slice(1);

  // GET /api/attachments/:attId — serve the stored file (inert + sandboxed:
  // only safe raster images and PDF are inline, everything else downloads)
  if (req.method === "GET" && rest[0] === "attachments" && rest.length === 2) {
    const attId = rest[1];
    if (!ID_RE.test(attId)) return json({ ok: false, erreur: "not found" }, 404);
    const found = withLock(() => load()).leads.flatMap((l) => (l.attachments || []).map((a) => [l.id, a] as const))
      .find(([, a]) => a.id === attId);
    if (!found) return json({ ok: false, erreur: "attachment not found" }, 404);
    const [leadId, att] = found;
    let data: Buffer;
    try {
      data = readFileSync(attPath(leadId, att));
    } catch {
      return json({ ok: false, erreur: "file missing" }, 404);
    }
    const inline = INLINE_MIME.test(att.mime);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": inline ? att.mime : "application/octet-stream",
        "content-length": String(data.byteLength),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${att.name.replace(/[^\w.\- ]+/g, "_")}"`,
        "cache-control": "private, max-age=3600",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (req.method === "GET" && rest[0] === "statuses") return json({ ok: true, statuses: STATUSES, noteTypes: NOTE_TYPES });
  if (req.method === "GET" && rest[0] === "stats") return stats();
  if (rest[0] !== "leads") return json({ ok: false, erreur: "not found" }, 404);

  // /api/leads
  if (rest.length === 1) {
    if (req.method === "GET") return listLeads(url);
    if (req.method === "POST") {
      const b = await readBody(req);
      const lead: Lead = {
        id: newId("lead"),
        name: str(b.name, 200, "name", true),
        company: str(b.company, 200, "company"),
        phone: str(b.phone, 60, "phone"),
        email: str(b.email, 200, "email"),
        status: str(b.status, 24, "status") || "new",
        source: str(b.source, 40, "source") || "api",
        tags: cleanTags(b.tags),
        notes: str(b.notes, 5000, "notes"),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        history: [],
      };
      checkLead(lead);
      withLock(() => {
        const d = load();
        d.leads.push(lead);
        save(d);
      });
      return json({ ok: true, lead }, 201);
    }
    return json({ ok: false, erreur: "method not allowed" }, 405);
  }

  const id = rest[1];
  if (rest.length === 2) {
    if (req.method === "GET") {
      const lead = withLock(() => load()).leads.find((l) => l.id === id);
      return lead ? json({ ok: true, lead }) : json({ ok: false, erreur: "lead not found: " + id }, 404);
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      const b = await readBody(req);
      return withLock(() => {
        const d = load();
        const lead = d.leads.find((l) => l.id === id);
        if (!lead) return json({ ok: false, erreur: "lead not found: " + id }, 404);
        let touched = false;
        for (const f of ["name", "company", "phone", "email", "status", "source", "notes"] as const) {
          if (b[f] !== undefined) {
            (lead as any)[f] = str(b[f], f === "phone" ? 60 : f === "status" ? 24 : f === "notes" ? 5000 : 200, f);
            touched = true;
          }
        }
        if (b.tags !== undefined) {
          lead.tags = cleanTags(b.tags);
          touched = true;
        }
        if (!touched) return json({ ok: false, erreur: "nothing to update" }, 400);
        checkLead(lead);
        lead.updatedAt = nowIso();
        save(d);
        return json({ ok: true, lead });
      });
    }
    if (req.method === "DELETE") {
      return withLock(() => {
        const d = load();
        const i = d.leads.findIndex((l) => l.id === id);
        if (i < 0) return json({ ok: false, erreur: "lead not found: " + id }, 404);
        const [removed] = d.leads.splice(i, 1);
        save(d);
        try { rmSync(join(FILES_DIR, id), { recursive: true, force: true }); } catch {}
        return json({ ok: true, deleted: removed });
      });
    }
    return json({ ok: false, erreur: "method not allowed" }, 405);
  }

  // /api/leads/:id/attachments (GET list, POST upload)
  if (rest.length === 3 && rest[2] === "attachments") {
    if (req.method === "GET") {
      const lead = withLock(() => load()).leads.find((l) => l.id === id);
      if (!lead) return json({ ok: false, erreur: "lead not found: " + id }, 404);
      const attachments = lead.attachments || [];
      return json({ ok: true, count: attachments.length, attachments });
    }
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("multipart/form-data")) {
        const form = await req.formData();
        const author = str(url.searchParams.get("author") || (form.get("author") as string) || "", 60, "author") || "api";
        const files = [...form.getAll("file"), ...form.getAll("files")].filter((v): v is File => v instanceof File);
        if (!files.length) return json({ ok: false, erreur: "no file in form (field 'file')" }, 400);
        const saved: Att[] = [];
        for (const file of files) {
          const data = new Uint8Array(await file.arrayBuffer());
          saved.push(await saveAttachment(id, data, (file as File).name || "fichier", (file as File).type || "", author));
        }
        return json({ ok: true, count: saved.length, attachments: saved }, 201);
      }
      // raw body: POST /api/leads/<id>/attachments?name=rapport.pdf&mime=application/pdf
      const buf = new Uint8Array(await req.arrayBuffer());
      const att = await saveAttachment(id, buf, url.searchParams.get("name") || "fichier", url.searchParams.get("mime") || "", str(url.searchParams.get("author") || "", 60, "author") || "api");
      return json({ ok: true, count: 1, attachments: [att] }, 201);
    }
    return json({ ok: false, erreur: "method not allowed" }, 405);
  }

  // /api/leads/:id/attachments/:attId (DELETE)
  if (rest.length === 4 && rest[2] === "attachments" && req.method === "DELETE") {
    const attId = rest[3];
    if (!ID_RE.test(attId)) return json({ ok: false, erreur: "not found" }, 404);
    return withLock(() => {
      const d = load();
      const lead = d.leads.find((l) => l.id === id);
      const att = lead?.attachments?.find((a) => a.id === attId);
      if (!lead || !att) return json({ ok: false, erreur: "attachment not found" }, 404);
      lead.attachments = lead.attachments!.filter((a) => a.id !== attId);
      lead.updatedAt = nowIso();
      save(d);
      try { unlinkSync(attPath(id, att)); } catch {}
      return json({ ok: true, deleted: att });
    });
  }

  // /api/leads/:id/history (GET) and /api/leads/:id/notes (GET, POST)
  if (rest.length === 3 && rest[2] === "history" && req.method === "GET") {
    const lead = withLock(() => load()).leads.find((l) => l.id === id);
    if (!lead) return json({ ok: false, erreur: "lead not found: " + id }, 404);
    const history = [...lead.history].sort((a, b) => (a.at > b.at ? 1 : -1));
    return json({ ok: true, count: history.length, history });
  }
  if (rest.length === 3 && rest[2] === "notes") {
    if (req.method === "GET") {
      const lead = withLock(() => load()).leads.find((l) => l.id === id);
      if (!lead) return json({ ok: false, erreur: "lead not found: " + id }, 404);
      const history = [...lead.history].sort((a, b) => (a.at > b.at ? 1 : -1));
      return json({ ok: true, count: history.length, history });
    }
    if (req.method === "POST") {
      const b = await readBody(req);
      const note: Note = {
        id: newId("note"),
        at: nowIso(),
        type: str(b.type, 20, "type") || "note",
        text: str(b.text, 5000, "text", true),
        author: str(b.author, 60, "author") || "api",
      };
      if (!NOTE_TYPES.includes(note.type)) return json({ ok: false, erreur: "invalid note type: " + note.type }, 400);
      return withLock(() => {
        const d = load();
        const lead = d.leads.find((l) => l.id === id);
        if (!lead) return json({ ok: false, erreur: "lead not found: " + id }, 404);
        lead.history.push(note);
        lead.updatedAt = nowIso();
        save(d);
        return json({ ok: true, note }, 201);
      });
    }
    return json({ ok: false, erreur: "method not allowed" }, 405);
  }

  return json({ ok: false, erreur: "not found" }, 404);
}

// ---------- server ----------
let indexHtml = "";
// the installed payload is PREFIXED (ob-plugin-<id>-index.html); the bare name
// only exists when running from the source tree
for (const p of [
  join(import.meta.dir, `ob-plugin-${PLUGIN_ID}-index.html`),
  join(import.meta.dir, "index.html"),
]) {
  try {
    indexHtml = readFileSync(p, "utf8");
    break;
  } catch {}
}

Bun.serve({
  port: Number(process.env.OPEN_BOT_PAGE_PORT ?? 4747),
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    for (const prefix of [`/api/pages/${PLUGIN_ID}`, `/hooks/${PLUGIN_ID}`]) {
      if (path === prefix) path = "/";
      else if (path.startsWith(prefix + "/")) path = path.slice(prefix.length);
    }
    if (req.method === "OPTIONS") return json({ ok: true });
    if (path === "/healthz") return new Response("ok");
    const isPublic = url.pathname.startsWith(`/hooks/${PLUGIN_ID}/`);
    if (path === "/" || path === "/index.html") {
      return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    try {
      return await handleApi(req, path, url, isPublic);
    } catch (e: any) {
      const msg = String(e?.message || e);
      const status = msg === "lead store busy" ? 503 : msg.includes("JSON") ? 400 : 400;
      return json({ ok: false, erreur: msg }, status);
    }
  },
});
