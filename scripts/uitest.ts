/**
 * lead-manager — headless UI harness (happy-dom), from the user's seat.
 * Usage: UI_PORT=4741 bun scripts/uitest.ts   (against the live page server)
 * Requires: bun add happy-dom (in scripts/ or repo root — dev only, not shipped)
 */
import { Window } from "happy-dom";

const PORT = Number(process.env.UI_PORT ?? 4747);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, failCnt = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCnt++; console.log(`  ✗ ${name} ${extra}`); }
}

async function main() {
  const cli = "ob-plugin-lead-manager-lead";
  // 0. clean the store from the user's seat (CLI)
  {
    const all = JSON.parse(new TextDecoder().decode(Bun.spawnSync([cli, "list", "--limit", "1000"]).stdout));
    for (const l of all.leads || []) {
      if (l.source === "uitest" || (l.name || "").includes("UI Test")) {
        Bun.spawnSync([cli, "delete", l.id]);
      }
    }
  }
  Bun.spawnSync([cli, "list"], {});
  const uniq = "Léo" + Date.now().toString(36);
  const seed = JSON.parse(
    new TextDecoder().decode(
      Bun.spawnSync([cli, "add", "--name", "UI Test " + uniq, "--company", "Uquisite", "--source", "uitest"]).stdout
    )
  );
  check("seed lead created", seed.ok === true, JSON.stringify(seed));

  // 1. fetch the page the server actually serves
  const html = await (await fetch(BASE + "/")).text();
  check("server serves html", html.includes("Lead Manager"));

  // 2. happy-dom window + fetch wrapper prefixing api/ like the dashboard proxy
  const win = new Window({ url: BASE + "/", settings: { disableCSSFileLoading: true } });
  try { Object.defineProperty(win.navigator, "language", { value: "fr-CA", configurable: true }); } catch {}
  const doc = win.document;
  win.confirm = () => true;
  const pageErrors: string[] = [];
  win.addEventListener("error", (e) => pageErrors.push(String((e as any).message || e)));
  doc.write(html);
  const realFetch = win.fetch.bind(win);
  const wrappedFetch = (input, init) => {
    const url = typeof input === "string" && input.startsWith("api/") ? `${BASE}/api/${input.slice(4)}` : input;
    return realFetch(url, init);
  };
  // run the inline script the way a browser would
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  const m = [null, scripts.sort((a, b) => b.length - a.length)[0]]; // the app script is the longest block
  check("inline script found", !!m && !!m[1]);
  new Function("window", "document", "fetch", "localStorage", "navigator", "confirm",
    "with(window){" + m[1] + "}")(
    win, doc, wrappedFetch,
    { getItem: () => null, setItem: () => {} },
    { language: "fr-CA" }, () => true
  );
  await sleep(400);

  const $ = (id) => doc.getElementById(id);
  const cards = () => [...doc.querySelectorAll(".card")];
  const cardOf = (title) => cards().find((c) => c.textContent.includes(title));

  // 3. initial render: FR locale auto-detected, cards, creation date on cards
  check("rendered cards >= 2", cards().length >= 2, `got ${cards().length}`);
  check("subline counts (fr)", $("subline").textContent.includes("lead"));
  const leo = cardOf("UI Test " + uniq);
  check("seed card rendered", !!leo);
  check("creation date on card", !!leo && /20\d\d|janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc/i.test(leo.querySelector(".foot").textContent), leo && leo.querySelector(".foot").textContent);
  check("status pill on card", !!leo && leo.querySelector(".status").textContent.trim() === "new");
  check("source badge on card", !!leo && leo.querySelector(".src").textContent.includes("uitest"));


  // 5. search filter
  $("q").value = "Léo";
  $("q").dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(400);
  check("search narrows to 1", cards().length === 1, `got ${cards().length}`);
  $("q").value = "zzzzaucun";
  $("q").dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(400);
  check("empty state shows", $("empty").style.display !== "none");
  $("q").value = "";
  $("q").dispatchEvent(new win.Event("input", { bubbles: true }));
  await sleep(400);

  // 6. status pill filter
  const newPill = [...doc.querySelectorAll(".pill")].find((p) => p.dataset.st === "new");
  newPill.click();
  await sleep(250);
  check("pill filter applies", cards().every((c) => c.querySelector(".status").textContent.trim() === "new"));
  newPill.click();
  await sleep(250);

  // 7. open drawer, timeline, add note from the user's seat
  cardOf("UI Test " + uniq).click();
  await sleep(250);
  check("drawer opens with name", $("dName").textContent === "UI Test " + uniq);
  const before = $("dTimeline").querySelectorAll(".titem").length;
  $("nType").value = "call";
  $("nText").value = "Appel de qualification — harness";
  $("nAdd").click();
  await sleep(500);
  const after = $("dTimeline").querySelectorAll(".titem").length;
  check("note appended to timeline", after === before + 1, `${before} -> ${after}`);
  const serverLead = await (await wrappedFetch(`api/leads/${seed.lead.id}`)).json();
  check("note persisted server-side", serverLead.lead.history.some((n) => n.text.includes("harness")));

  // 8. quick status change in the drawer
  $("dStatus").value = "contacted";
  $("dStatus").dispatchEvent(new win.Event("change", { bubbles: true }));
  await sleep(500);
  const upd = await (await wrappedFetch(`api/leads/${seed.lead.id}`)).json();
  check("status change persisted", upd.lead.status === "contacted", upd.lead.status);

  // 9. add-lead dialog end to end
  $("dClose").click();
  await sleep(200);
  $("addBtn").click();
  await sleep(200);
  const f = doc.querySelector("#f");
  f.querySelector('[name="name"]').value = "Dialog Danielle";
  f.querySelector('[name="company"]').value = "Dialog SARL";
  f.querySelector('[name="email"]').value = "danielle@sarl.qc";
  f.querySelector('[name="status"]').value = "new";
  $("fSave").click();
  await sleep(600);
  check("dialog add appears in grid", !!cardOf("Dialog Danielle"));
  const srv = await (await wrappedFetch("api/leads?q=danielle")).json();
  check("dialog add persisted", srv.count === 1, JSON.stringify(srv).slice(0, 120));
  check("dialog closed after save", !doc.getElementById("dlg").hasAttribute("open"));

  // 10. language toggle
  $("langBtn").click();
  await sleep(250);
  check("lang toggle -> EN", $("addBtn").textContent.includes("New lead"), $("addBtn").textContent);
  check("newLead label EN", doc.querySelector('[data-t="newLead"]').textContent === "New lead", doc.querySelector('[data-t="newLead"]') && doc.querySelector('[data-t="newLead"]').textContent);
  $("langBtn").click();
  await sleep(250);
  check("lang toggle -> FR", doc.querySelector('[data-t="newLead"]').textContent === "Nouveau lead");

  // 11. delete from the drawer (confirm overridden to true)
  cardOf("Dialog Danielle").click();
  await sleep(250);
  $("dDelete").click();
  await sleep(600);
  check("delete removes card", !cardOf("Dialog Danielle"));

  // 12. XSS escape: externally created lead (REST), user reloads the tab
  {
    const post = await (await wrappedFetch("api/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "<b>XSS</b> & co", source: "uitest" }) })).json();
    check("xss lead accepted by API", post.ok === true);
    const w2 = new Window({ url: BASE + "/", settings: { disableCSSFileLoading: true } });
    try { Object.defineProperty(w2.navigator, "language", { value: "fr-CA", configurable: true }); } catch {}
    const d2 = w2.document;
    const f2 = w2.fetch.bind(w2);
    const errs2: string[] = [];
    w2.addEventListener("error", (e) => errs2.push(String((e as any).message || e)));
    d2.write(html);
    const m2 = [null, [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).sort((a, b) => b.length - a.length)[0]];
    try {
      new Function("window", "document", "fetch", "localStorage", "navigator",
        "with(window){" + m2[1] + "}")(
        w2, d2,
        (u, i) => f2(typeof u === "string" && u.startsWith("api/") ? `${BASE}/${u}` : u, i),
        { getItem: () => null, setItem: () => {} },
        { language: "fr-CA" }
      );
    } catch (e) { errs2.push("script throw: " + e); }
    await sleep(600);
    const c2 = [...d2.querySelectorAll(".card")].find((c) => c.textContent.includes("XSS"));
    check("xss card as text after reload", !!c2 && c2.querySelector("b") === null, c2 ? c2.outerHTML.slice(0, 240) : "CARD NOT FOUND");
  }

  console.log(`\n${pass} passed, ${failCnt} failed`);
  if (pageErrors.length) console.log("page errors:", pageErrors.slice(0, 5));
  // cleanup: remove harness leads
  for (const nm of ["<b>XSS</b> & co"]) {
    const r = await (await wrappedFetch("api/leads?q=" + encodeURIComponent(nm.slice(0, 8)))).json();
    for (const l of r.leads || []) await wrappedFetch("api/leads/" + l.id, { method: "DELETE" });
  }
  const left = await (await wrappedFetch("api/leads")).json();
  for (const l of left.leads || []) if (l.source === "uitest") await wrappedFetch("api/leads/" + l.id, { method: "DELETE" });
  process.exit(failCnt ? 1 : 0);
}

main().catch((e) => { console.error("harness crash:", e); process.exit(2); });
process.on("beforeExit", () => process.exit(0));
