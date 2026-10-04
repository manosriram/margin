import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let pdf, docName, docHash, scale, io;
let notes = [];          // {id, doc, page, rects:[[x,y,w,h] as page fractions], quote, image?, question, answer, model, created, pinned}
let active = null;       // note currently shown in the margin even if unpinned
let showAll = false;     // margin shows every past question, not just pinned ones
let sidebarOpen = false;
let snipping = false;    // region-select mode (ask about a figure/table/equation as an image)
let model = store.get("margin:model", ""); // "provider|model"
let side = store.get("margin:side", 0.3);  // margin width as a fraction of the reader, so window resizes keep the ratio
let zoom = store.get("margin:zoom", 1);    // PDF only, on top of fit-to-width; the margin and toolbar keep their size
const pageText = {};
const pages = $("pages");

// ---------- intro ----------
const drop = $("drop");
$("file").onchange = (e) => open(e.target.files[0]);
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => open(e.dataTransfer.files[0]));
$("home").onclick = () => (location.href = "/?home");

// `margin file.pdf` → the server hands us that file
if (!location.search.includes("home")) fetch("/api/doc", { cache: "no-store" }).then(async (r) => {
  if (r.ok) open(new File([await r.blob()], r.headers.get("X-Doc-Name") || "document.pdf", { type: "application/pdf" }));
});

// ---------- toolbar ----------
$("history").onclick = () => { showAll = !showAll; if (showAll) sidebarOpen = true; renderCards(); };
$("sideBtn").onclick = () => toggleSidebar();
$("snipBtn").onclick = () => setSnip(!snipping);
let suggestOn = store.get("margin:suggest", false);
$("suggest").setAttribute("aria-checked", suggestOn);
$("suggestLbl").onclick = () => $("suggest").click();
$("suggest").onclick = () => {
  suggestOn = !suggestOn;
  $("suggest").setAttribute("aria-checked", suggestOn);
  store.set("margin:suggest", suggestOn);
  if (!active || active.question) return;
  if (suggestOn && !active.sugs) return loadSuggestions(active);
  const el = $("cards").querySelector(`[data-id="${active.id}"] .sugs`);
  if (el) fillSuggestions(el, active);
};

function toggleSidebar(open = !sidebarOpen) { sidebarOpen = open; renderCards(); }
function setSnip(on) {
  snipping = on;
  pages.classList.toggle("snip", on);
  $("snipBtn").classList.toggle("on", on);
  if (on) flash("Drag over a figure, table or equation");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (snipping) return setSnip(false);
    if (active) { active = null; return renderCards(); }
    return;
  }
  if ($("reader").hidden || e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, [role=listbox]")) return;
  const k = e.key.toLowerCase();
  if (k === "r") setSnip(!snipping);
  else if (k === "g") { e.preventDefault(); pageNo.focus(); }
  else if (k === "+" || k === "=") zoomStep(1);
  else if (k === "-") zoomStep(-1);
  else if (k === "0") setZoom(1);
  else if (k === "m") toggleSidebar();
});

// ---------- model dropdown ----------
const dd = $("modelDD"), ddBtn = dd.querySelector("button"), ddMenu = dd.querySelector("ul");
fetch("/api/models").then((r) => r.json()).then((providers) => {
  for (const p of providers) {
    const g = document.createElement("li");
    g.className = "dd-group";
    g.role = "presentation";
    g.textContent = p.name;
    ddMenu.append(g);
    for (const m of p.models) {
      const li = document.createElement("li");
      li.role = "option";
      li.tabIndex = -1;
      li.dataset.value = `${p.id}|${m}`;
      li.textContent = m;
      ddMenu.append(li);
    }
  }
  const opts = [...ddMenu.querySelectorAll("[role=option]")];
  if (!opts.some((o) => o.dataset.value === model)) model = opts[0]?.dataset.value || "";
  syncModel();
});
function syncModel() {
  ddMenu.querySelectorAll("[role=option]").forEach((o) => o.setAttribute("aria-selected", o.dataset.value === model));
  ddBtn.querySelector("span").textContent = model.split("|")[1] || "model";
}
function ddOpen(open) {
  ddMenu.hidden = !open;
  ddBtn.setAttribute("aria-expanded", open);
  if (open) (ddMenu.querySelector('[aria-selected="true"]') || ddMenu.querySelector("[role=option]"))?.focus();
}
function pick(o) {
  model = o.dataset.value;
  store.set("margin:model", model);
  syncModel();
  ddOpen(false);
  ddBtn.focus();
}
ddBtn.onclick = () => ddOpen(ddMenu.hidden);
ddMenu.onclick = (e) => { const o = e.target.closest("[role=option]"); if (o) pick(o); };
ddMenu.onkeydown = (e) => {
  const opts = [...ddMenu.querySelectorAll("[role=option]")], i = opts.indexOf(document.activeElement);
  if (e.key === "ArrowDown") opts[Math.min(i + 1, opts.length - 1)].focus();
  else if (e.key === "ArrowUp") opts[Math.max(i - 1, 0)].focus();
  else if (e.key === "Enter" || e.key === " ") pick(document.activeElement);
  else if (e.key === "Escape") { ddOpen(false); ddBtn.focus(); }
  else if (e.key === "Tab") return ddOpen(false);
  else return;
  e.preventDefault();
  e.stopPropagation();
};
document.addEventListener("mousedown", (e) => { if (!dd.contains(e.target)) ddOpen(false); });

// ---------- token usage (whole margin run; cached answers are free) ----------
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
async function refreshUsage() {
  const u = await fetch("/api/usage").then((r) => r.json()).catch(() => null);
  if (!u?.calls) return;
  const el = $("usage");
  el.hidden = false;
  el.textContent = `${fmtTok(u.in + u.cacheRead + u.cacheWrite + u.out)} tok`;
  el.title = `This session · ${u.calls} model calls\n` +
    `input ${fmtTok(u.in)} · cache read ${fmtTok(u.cacheRead)} · cache write ${fmtTok(u.cacheWrite)}\n` +
    `output ${fmtTok(u.out)}\n≈ $${u.cost.toFixed(3)} at API prices`;
}
refreshUsage();

// ---------- recent papers (intro) ----------
const ago = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function since(sec) {
  const d = sec - Date.now() / 1000;
  for (const [unit, n] of [["day", 86400], ["hour", 3600], ["minute", 60]]) if (Math.abs(d) >= n) return ago.format(Math.round(d / n), unit);
  return "just now";
}
fetch("/api/recent").then((r) => r.json()).then((docs) => {
  if (!docs.length) return;
  $("recent").hidden = false;
  $("recentList").replaceChildren(...docs.map((d) => {
    const b = document.createElement("button");
    b.innerHTML = `<span class="rname"></span><span class="rmeta"></span>`;
    b.querySelector(".rname").textContent = d.name;
    b.querySelector(".rmeta").textContent = `${d.pages ? d.pages + " pages · " : ""}${since(d.opened)}`;
    b.onclick = async () => {
      const r = await fetch(`/api/docs/${d.hash}`);
      if (r.ok) open(new File([await r.blob()], d.name, { type: "application/pdf" }));
    };
    const li = document.createElement("li");
    li.append(b);
    return li;
  }));
}).catch(() => {});

// Keep a copy server-side (once per unique PDF) so it can be reopened from "recent".
async function remember(file, pages) {
  const url = `/api/docs/${docHash}?` + new URLSearchParams({ name: file.name, pages });
  const have = await fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  fetch(url, { method: "PUT", body: have ? "" : file }).catch(() => {});
}

// crypto.subtle and crypto.randomUUID exist only in secure contexts (https, or http on localhost).
// Opened from a LAN address over plain http they're missing, so fall back.
async function sha256(buf) {
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (crypto.subtle) return hex(await crypto.subtle.digest("SHA-256", buf));
  const r = await fetch("/api/hash", { method: "POST", body: buf });
  if (!r.ok) throw new Error(await r.text());
  return r.text();
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- open + render ----------
async function open(file) {
  if (!file || file.type !== "application/pdf") return;
  $("dropName").textContent = file.name;
  $("dropMeta").textContent = "opening…";
  const buf = await file.arrayBuffer();
  // notes are keyed by content hash, so renames/moves keep their history (hash before pdf.js takes the buffer)
  try {
    docHash = await sha256(buf);
  } catch (err) {
    $("dropMeta").textContent = "Couldn't read this PDF: " + err.message;
    return;
  }
  try {
    pdf = await pdfjs.getDocument({ data: buf }).promise;
  } catch (err) {
    $("dropMeta").textContent = "Couldn't open this PDF: " + err.message;
    return;
  }
  docName = file.name;
  remember(file, pdf.numPages);
  notes = await fetch(`/api/notes?doc=${docHash}`).then((r) => r.json()).catch(() => []);
  sidebarOpen = notes.some((n) => n.pinned);
  $("docName").textContent = file.name;
  document.title = `${file.name} · Margin`;
  $("intro").hidden = true;
  $("reader").hidden = false;
  renderCards();
  await layout(store.get(`margin:pos:${docHash}`, 0));
}

// Pages are sized to fit the reading column *with the margin open*, so toggling it never scrolls sideways.
let lastWidth = 0;
let layoutGen = 0;
async function layout(fraction) {
  const gen = ++layoutGen; // fast zoom clicks start overlapping layouts; only the last one wins
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const split = $("split").clientWidth;
  applySide(); // the reader was hidden (width 0) when the page loaded, and windows resize
  const s = Math.min(1.6, ((innerWidth > 760 ? split - sideWidth(split) : split) - 48) / first.width) * zoom;
  lastWidth = split;

  const els = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const vp = (await pdf.getPage(n)).getViewport({ scale: s });
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.n = n;
    // integer CSS size so canvas pixels map 1:1 to screen pixels (fractional sizes get resampled = blurry)
    el.style.width = Math.floor(vp.width) + "px";
    el.style.height = Math.floor(vp.height) + "px";
    el.innerHTML = `<canvas></canvas><div class="hl"></div><div class="textLayer"></div>`;
    els.push(el);
  }
  if (gen !== layoutGen) return;
  scale = s;
  io?.disconnect();
  io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); renderPage(e.target); }
  }, { root: pages, rootMargin: "600px 0px" });
  pages.replaceChildren(...els);
  $("pageCount").textContent = pdf.numPages;
  $("pageNo").style.width = String(pdf.numPages).length + 2 + "ch";
  els.forEach((el) => io.observe(el));
  pages.scrollTop = fraction * pages.scrollHeight;
  onScroll();
}

// ---------- PDF zoom ----------
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let zoomT;
function setZoom(z, now = true) {
  zoom = Math.max(ZOOMS[0], Math.min(z, ZOOMS.at(-1)));
  store.set("margin:zoom", zoom);
  $("zoomReset").textContent = Math.round(zoom * 100) + "%";
  if (!pdf) return;
  clearTimeout(zoomT);
  const go = () => layout(pages.scrollTop / pages.scrollHeight);
  if (now) go();
  else zoomT = setTimeout(go, 150); // pinch sends many events; relayout once it settles
}
const zoomStep = (dir) => setZoom(dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) ?? zoom : ZOOMS.findLast((z) => z < zoom - 0.001) ?? zoom);
$("zoomIn").onclick = () => zoomStep(1);
$("zoomOut").onclick = () => zoomStep(-1);
$("zoomReset").onclick = () => setZoom(1);
$("zoomReset").textContent = Math.round(zoom * 100) + "%";
// trackpad pinch (and ctrl+wheel) arrives as a wheel event with ctrlKey; zoom the PDF, not the whole UI
pages.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY * 0.01), false);
}, { passive: false });

// ---------- margin width (drag its left edge) ----------
const SIDE_MIN = 240, SIDE_MAX = 0.6;
const sideWidth = (split) => Math.max(SIDE_MIN, Math.min(side * split, SIDE_MAX * split));
function applySide() { $("split").style.setProperty("--side", sideWidth($("split").clientWidth) + "px"); }
const resizer = $("resizer");
resizer.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const sp = $("split"), r = sp.getBoundingClientRect();
  sp.classList.add("resizing");
  hidePop();
  const move = (ev) => {
    side = (r.right - ev.clientX) / r.width;
    applySide();
  };
  const up = () => {
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", up);
    resizer.removeEventListener("pointercancel", up);
    sp.classList.remove("resizing");
    side = sideWidth(r.width) / r.width; // store the clamped value
    store.set("margin:side", side);
    if (pdf) layout(pages.scrollTop / pages.scrollHeight); // refit pages to the new column
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", up);
  resizer.addEventListener("pointercancel", up);
});
resizer.ondblclick = () => {
  side = 0.3;
  store.set("margin:side", side);
  applySide();
  if (pdf) layout(pages.scrollTop / pages.scrollHeight);
};

let resizeT;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (pdf && !$("reader").hidden && $("split").clientWidth !== lastWidth) layout(pages.scrollTop / pages.scrollHeight);
  }, 250);
});

// browser zoom / moving to another display changes devicePixelRatio → repaint at the new density
const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => {
  document.querySelectorAll(".page[data-done]").forEach(paint);
  watchDpr();
}, { once: true });
watchDpr();

async function paint(el) {
  const page = await pdf.getPage(+el.dataset.n);
  const vp = page.getViewport({ scale });
  // fresh canvas each time: pdf.js refuses concurrent renders on one canvas
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(Math.floor(vp.width) * devicePixelRatio);
  canvas.height = Math.round(Math.floor(vp.height) * devicePixelRatio);
  await page.render({ canvas, viewport: vp, transform: [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0] }).promise;
  el.querySelector("canvas").replaceWith(canvas);
}

async function renderPage(el) {
  const page = await pdf.getPage(+el.dataset.n);
  const vp = page.getViewport({ scale });
  el.style.setProperty("--total-scale-factor", scale);
  const tl = el.querySelector(".textLayer");
  await Promise.all([
    paint(el),
    new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render(),
  ]);
  el.dataset.done = "1";
  const end = document.createElement("div");
  end.className = "endOfContent";
  tl.append(end);
  drawHighlights(el);
}

async function getPageText(n) {
  if (!pageText[n]) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    pageText[n] = tc.items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join("").slice(0, 8000);
  }
  return pageText[n];
}

// ---------- progress, page indicator, resume position ----------
let scrollRaf, flashT;
pages.addEventListener("scroll", () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => { onScroll(); flash(`${currentPage()} / ${pdf.numPages}`); });
});
function onScroll() {
  if (document.activeElement !== $("pageNo")) $("pageNo").value = currentPage();
  const max = pages.scrollHeight - pages.clientHeight;
  $("prog").style.width = (max > 0 ? (pages.scrollTop / max) * 100 : 100) + "%";
  if (docHash) store.set(`margin:pos:${docHash}`, pages.scrollTop / pages.scrollHeight);
}
// navbar page box: type a page number and press enter to jump there
const pageNo = $("pageNo");
function goToPage(n) {
  pages.querySelector(`.page[data-n="${Math.max(1, Math.min(n, pdf.numPages))}"]`)?.scrollIntoView();
}
pageNo.onfocus = () => pageNo.select();
pageNo.onkeydown = (e) => {
  if (e.key === "Enter") {
    const n = parseInt(pageNo.value, 10);
    if (n) goToPage(n);
    pageNo.blur();
  } else if (e.key === "Escape") {
    pageNo.blur();
  } else return;
  e.preventDefault();
  e.stopPropagation(); // Escape here shouldn't also close the active card
};
pageNo.onblur = () => (pageNo.value = currentPage());

function currentPage() {
  const mid = pages.getBoundingClientRect().top + pages.clientHeight / 2;
  const el = [...pages.children].find((p) => p.getBoundingClientRect().bottom > mid);
  return el ? +el.dataset.n : pdf.numPages;
}
function flash(text) {
  const el = $("pageind");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(flashT);
  flashT = setTimeout(() => el.classList.remove("show"), 1400);
}

// ---------- highlights ----------
// Pastel highlight colors: [fill, fill under the pointer, underline]. Each note keeps one color,
// picked from its id, so it stays the same across reloads without storing anything.
const PALETTE = [
  ["#fff59d", "#ffee58", "#d4b800"], // lemon
  ["#c8f2c2", "#a5e89c", "#5fae57"], // mint
  ["#ffd1e3", "#ffb3d0", "#d9709b"], // pink
  ["#cfe6ff", "#a9d1ff", "#5b8fd1"], // sky
  ["#ffdcb8", "#ffc68f", "#d98b3a"], // peach
  ["#e2d6ff", "#cdbaff", "#9273d1"], // lavender
];
function noteColor(note) {
  let h = 0;
  for (const ch of note.id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const [fill, strong, line] = PALETTE[Math.abs(h) % PALETTE.length];
  return `--c:${fill};--c-strong:${strong};--c-line:${line}`;
}

// A selection gives one rect per text span, and spans overlap; with multiply blending every overlap
// showed up darker. Merge rects on the same line into one, then split any overlap between lines.
function mergeRects(rects) {
  const out = rects.map((r) => [...r]);
  const sameLine = (a, b) => {
    const shared = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
    return shared > 0.5 * Math.min(a[3], b[3]) && b[0] <= a[0] + a[2] + 0.01 && b[0] + b[2] >= a[0] - 0.01;
  };
  // repeat until stable: a merged rect can grow into one that was kept apart earlier
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length; i++) for (let j = out.length - 1; j > i; j--) {
      const a = out[i], b = out[j];
      if (!sameLine(a, b)) continue;
      const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
      out[i] = [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
      out.splice(j, 1);
      merged = true;
    }
  }
  out.sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    if (b[1] >= a[1] + a[3] || b[0] >= a[0] + a[2] || b[0] + b[2] <= a[0]) continue;
    const mid = (a[1] + a[3] + b[1]) / 2, bottom = b[1] + b[3];
    a[3] = Math.max(0, mid - a[1]);
    b[1] = mid;
    b[3] = Math.max(0, bottom - mid);
  }
  return out;
}

function drawHighlights(el) {
  const n = +el.dataset.n, layer = el.querySelector(".hl");
  layer.innerHTML = "";
  const all = active && !notes.includes(active) ? [...notes, active] : notes; // include the draft being asked
  for (const note of all) if (note.page === n) for (const [x, y, w, h] of note.image ? note.rects : mergeRects(note.rects)) {
    const i = document.createElement("i");
    i.dataset.id = note.id;
    i.style.cssText = noteColor(note);
    i.classList.toggle("box", !!note.image);
    i.classList.toggle("flash", note.id === flashId);
    Object.assign(i.style, { left: x * 100 + "%", top: y * 100 + "%", width: w * 100 + "%", height: h * 100 + "%" });
    layer.append(i);
  }
}
// Scroll the passage (not just its page) to a third of the way down the view, then pulse it.
let flashId = null, flashT2;
function scrollToNote(note) {
  const el = pages.querySelector(`.page[data-n="${note.page}"]`);
  if (!el) return;
  const top = Math.min(...note.rects.map((r) => r[1]));
  const pr = el.getBoundingClientRect(), vr = pages.getBoundingClientRect();
  pages.scrollTo({ top: pages.scrollTop + pr.top - vr.top + top * pr.height - pages.clientHeight / 3, behavior: "smooth" });
  // the class is also set in drawHighlights, so the pulse survives the page rendering mid-scroll
  flashId = note.id;
  clearTimeout(flashT2);
  const set = (on) => pages.querySelectorAll(`.hl i[data-id="${note.id}"]`).forEach((i) => i.classList.toggle("flash", on));
  set(false);
  requestAnimationFrame(() => set(true)); // restart the animation on a repeat click
  flashT2 = setTimeout(() => { flashId = null; set(false); }, 1600);
}

const redrawAll = () => document.querySelectorAll(".page").forEach(drawHighlights);

function noteAt(e) {
  const el = e.target.closest?.(".page");
  if (!el) return null;
  const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  return notes.find((n) => n.page === +el.dataset.n && n.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh));
}

// ---------- selection / region → ask ----------
function startNote(el, rects, quote, image) {
  active = { id: uuid(), doc: docHash, page: +el.dataset.n, rects, quote, image, question: "", answer: "", pinned: false };
  sidebarOpen = true;
  renderCards();
  $("cards").querySelector("textarea")?.focus();
  if (suggestOn) loadSuggestions(active);
}

pages.addEventListener("mousedown", (e) => {
  if (!snipping) return e.target.closest(".textLayer")?.classList.add("selecting");
  const el = e.target.closest(".page");
  if (!el || e.button !== 0) return;
  e.preventDefault();
  const r = el.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
  const clamp = (v, max) => Math.max(0, Math.min(v, max));
  const box = document.createElement("div");
  box.className = "snipbox";
  el.append(box);
  let rect;
  const move = (ev) => {
    const x1 = clamp(ev.clientX - r.left, r.width), y1 = clamp(ev.clientY - r.top, r.height);
    rect = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    Object.assign(box.style, { left: rect[0] + "px", top: rect[1] + "px", width: rect[2] + "px", height: rect[3] + "px" });
  };
  const up = () => {
    removeEventListener("mousemove", move);
    removeEventListener("mouseup", up);
    box.remove();
    if (!rect || rect[2] < 8 || rect[3] < 8) return;
    setSnip(false);
    const f = [rect[0] / r.width, rect[1] / r.height, rect[2] / r.width, rect[3] / r.height];
    startNote(el, [f], "", crop(el, f));
  };
  addEventListener("mousemove", move);
  addEventListener("mouseup", up);
});

document.addEventListener("mouseup", () => document.querySelectorAll(".textLayer.selecting").forEach((t) => t.classList.remove("selecting")));

// Crop a page region from the rendered canvas; capped at ~1568px, past which Claude downsamples anyway.
function crop(el, [fx, fy, fw, fh]) {
  const src = el.querySelector("canvas");
  const sx = fx * src.width, sy = fy * src.height, sw = fw * src.width, sh = fh * src.height;
  const k = Math.min(1, 1568 / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

pages.addEventListener("mouseup", (e) => {
  if (snipping) return; // region drag is handled above
  setTimeout(() => {
    const sel = getSelection(), quote = sel.toString().trim();
    if (!quote) {
      const hit = noteAt(e);
      if (hit) { active = hit; sidebarOpen = true; renderCards(); focusCard(hit); }
      return;
    }
    const range = sel.getRangeAt(0);
    const el = range.startContainer.parentElement?.closest(".page");
    if (!el) return;
    const r = el.getBoundingClientRect();
    const rects = [...range.getClientRects()]
      .filter((c) => c.width > 1 && c.height > 1 && c.top < r.bottom && c.bottom > r.top)
      .map((c) => [(c.left - r.left) / r.width, (c.top - r.top) / r.height, c.width / r.width, c.height / r.height]);
    startNote(el, rects, quote);
  });
});

// hover: answers not in the margin show as a popover; ones in the margin light up their card.
// The popover is anchored under the highlight (not the cursor) and lingers briefly, so the
// pointer can move into it and scroll a long answer.
const pop = $("pop");
let popNote = null, popHideT;
function hidePop() { clearTimeout(popHideT); pop.hidden = true; popNote = null; }
function hidePopSoon() { clearTimeout(popHideT); popHideT = setTimeout(hidePop, 300); }
function showPop(note) {
  clearTimeout(popHideT);
  if (popNote === note) return;
  popNote = note;
  pop.style.cssText = noteColor(note);
  pop.replaceChildren(...turns(note).map((t) => {
    const d = document.createElement("div");
    d.className = "turn";
    d.innerHTML = `<div class="q"></div><div class="a"></div>`;
    d.querySelector(".q").textContent = "Q · " + t.question;
    d.querySelector(".a").innerHTML = md(t.answer);
    return d;
  }));
  pop.scrollTop = 0;
  pop.hidden = false;
  const rs = [...pages.querySelectorAll(`.hl i[data-id="${note.id}"]`)].map((i) => i.getBoundingClientRect());
  const top = Math.min(...rs.map((r) => r.top)), bottom = Math.max(...rs.map((r) => r.bottom)), left = Math.min(...rs.map((r) => r.left));
  const h = pop.offsetHeight, w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + "px";
  pop.style.top = (bottom + 6 + h < innerHeight ? bottom + 6 : Math.max(8, top - 6 - h)) + "px";
}
pop.addEventListener("mouseenter", () => clearTimeout(popHideT));
pop.addEventListener("mouseleave", hidePopSoon);
pages.addEventListener("scroll", hidePop);

pages.addEventListener("mousemove", (e) => {
  const hit = snipping ? null : noteAt(e);
  document.querySelectorAll(".hl i.on, .card.on").forEach((x) => x.classList.remove("on"));
  if (!hit) return popNote && hidePopSoon();
  document.querySelectorAll(`[data-id="${hit.id}"]`).forEach((x) => x.classList.add("on"));
  if (sidebarOpen && inMargin(hit)) return hidePop();
  showPop(hit);
});
pages.addEventListener("mouseleave", hidePopSoon);

// ---------- margin cards ----------
const inMargin = (n) => showAll || n.pinned || n === active;
const LONG = 360;           // answers longer than this start collapsed
const expanded = new Set(); // note ids the reader has expanded this session

function renderCards() {
  const shown = notes.filter(inMargin);
  if (active && !notes.includes(active)) shown.push(active);
  shown.sort((a, b) => a.page - b.page || a.rects[0]?.[1] - b.rects[0]?.[1]);
  $("split").classList.toggle("open", sidebarOpen);
  $("sideBtn").classList.toggle("on", sidebarOpen);
  $("history").textContent = `history (${notes.length})`;
  $("history").classList.toggle("on", showAll);
  const box = $("cards");
  box.replaceChildren(...shown.map(card));
  if (!shown.length) box.innerHTML = `<div class="empty">Highlight text, or press R to select a figure, to ask about it. Pinned answers stay here.</div>`;
  redrawAll();
}

function card(note) {
  const c = document.createElement("div");
  c.className = "card";
  c.dataset.id = note.id;
  c.style.cssText = noteColor(note); // card edge matches its highlight
  const goto = () => scrollToNote(note);
  if (note.image) {
    c.innerHTML = `<div class="quote"><small>p.${note.page} · region</small></div><img class="shot" alt="Selected region">`;
    c.querySelector(".shot").src = note.image;
    c.querySelector(".shot").onclick = goto;
  } else {
    c.innerHTML = `<div class="quote"><small>p.${note.page}</small></div>`;
    c.querySelector(".quote").append(note.quote);
  }
  c.querySelector(".quote").onclick = goto;

  if (!note.question) {
    c.insertAdjacentHTML("beforeend", `<textarea rows="2" placeholder="Ask about this ${note.image ? "region" : "passage"}…"></textarea><div class="hint">enter to ask · esc to close</div><div class="sugs"></div>`);
    const ta = c.querySelector("textarea");
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && ta.value.trim()) { e.preventDefault(); ask(note, ta.value.trim()); }
    };
    fillSuggestions(c.querySelector(".sugs"), note);
    return c;
  }
  turns(note).forEach((t, i) => {
    const d = document.createElement("div");
    d.className = "turn";
    d.dataset.i = i;
    d.innerHTML = `<div class="q"></div><div class="a"></div>`;
    d.querySelector(".q").textContent = "Q · " + t.question;
    d.querySelector(".q").onclick = goto;
    d.querySelector(".q").title = "Show in the paper";
    const a = d.querySelector(".a");
    a.innerHTML = md(t.answer);
    // ponytail: "long" is a character count, not a measured height; cheap and stable while the margin animates
    const key = i ? `${note.id}:${i}` : note.id;
    if (note !== active && t.answer.length > LONG && !expanded.has(key)) {
      a.classList.add("clamp");
      const more = document.createElement("button");
      more.className = "more";
      more.textContent = "more";
      more.onclick = () => { expanded.add(key); a.classList.remove("clamp"); more.remove(); };
      a.after(more);
    }
    c.append(d);
  });
  c.insertAdjacentHTML("beforeend", `<div class="actions"><span class="meta"></span><button class="reply">follow up</button><button class="pin"></button><button class="del">delete</button></div>`);
  c.querySelector(".meta").textContent = metaText(note);
  if (note === active && !note.busy) addFollowUp(c, note);
  const reply = c.querySelector(".reply");
  reply.hidden = note === active;
  reply.onclick = () => {
    active = note;
    renderCards();
    $("cards").querySelector(`[data-id="${note.id}"] .followup`)?.focus();
  };
  const pin = c.querySelector(".pin");
  pin.textContent = note.pinned ? "◆ pinned" : "◇ pin";
  pin.classList.toggle("pinned", note.pinned);
  pin.onclick = () => { note.pinned = !note.pinned; save(note); renderCards(); };
  c.querySelector(".del").onclick = () => {
    notes = notes.filter((n) => n !== note);
    if (active === note) active = null;
    fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    renderCards();
  };
  return c;
}

// The first question lives on the note itself; follow-ups on the same highlight go in note.thread.
const turns = (n) => [n, ...(n.thread || [])];

function addFollowUp(c, note) {
  if (c.querySelector(".followup")) return;
  const ta = document.createElement("textarea");
  ta.className = "followup";
  ta.rows = 1;
  ta.placeholder = "Ask a follow-up…";
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && ta.value.trim()) { e.preventDefault(); ask(note, ta.value.trim()); }
  };
  c.querySelector(".actions").before(ta);
  return ta;
}

const metaText = (note) => {
  const n = turns(note).at(-1);
  return n.created ? `${n.model || ""} · ${new Date(n.created).toLocaleDateString()}${n.cached ? " · cached" : ""}` : "";
};

function focusCard(note) {
  $("cards").querySelector(`[data-id="${note.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ---------- suggested questions ----------
async function loadSuggestions(note) {
  // update the chips in place: re-rendering the card would drop focus and any typed text
  const refresh = () => {
    const el = note === active && !note.question && $("cards").querySelector(`[data-id="${note.id}"] .sugs`);
    if (el) fillSuggestions(el, note);
  };
  note.sugs = "loading";
  refresh();
  const [provider] = model.split("|");
  try {
    const res = await fetch("/api/suggest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, doc: docName, page: note.page, selection: note.quote, image: note.image, context: await getPageText(note.page) }),
    });
    note.sugs = res.ok ? await res.json() : [];
  } catch {
    note.sugs = [];
  }
  refresh();
  refreshUsage();
}

function fillSuggestions(el, note) {
  el.replaceChildren();
  if (!suggestOn || !note.sugs) return;
  if (note.sugs === "loading") return (el.innerHTML = `<span class="loading">suggesting questions…</span>`);
  for (const q of note.sugs) {
    const b = document.createElement("button");
    b.textContent = q;
    b.onclick = () => ask(note, q);
    el.append(b);
  }
}

async function ask(note, question) {
  const [provider, m] = model.split("|");
  let turn = note;
  if (!note.question) {
    delete note.sugs;
    note.question = question;
    notes.push(note);
  } else {
    turn = { question, answer: "" };
    (note.thread ??= []).push(turn);
  }
  Object.assign(turn, { model: m, created: Date.now() });
  const history = turns(note).slice(0, -1).map(({ question, answer }) => ({ question, answer }));
  const i = history.length;
  note.busy = true;
  active = note;
  getSelection().removeAllRanges();
  renderCards();
  focusCard(note);
  const body = { provider, model: m, doc: docName, page: note.page, selection: note.quote, image: note.image, context: await getPageText(note.page), question, history };
  const out = () => $("cards").querySelector(`[data-id="${note.id}"] .turn[data-i="${i}"] .a`);
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    turn.cached = res.headers.get("X-Cache") === "hit";
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      turn.answer += value;
      const a = out();
      if (a) a.innerHTML = md(turn.answer);
    }
  } catch (err) {
    turn.answer += `\n⚠ ${err.message}`;
    const a = out();
    if (a) a.innerHTML = md(turn.answer);
  }
  delete note.busy;
  save(note);
  // update in place: a re-render would wipe a draft being typed
  const c = $("cards").querySelector(`[data-id="${note.id}"]`);
  if (c) {
    c.querySelector(".meta").textContent = metaText(note);
    // keep the conversation going: open a follow-up box, and focus it unless the reader is typing elsewhere
    if (note === active) {
      const ta = addFollowUp(c, note);
      if (ta && !document.activeElement?.closest("input, textarea")) ta.focus();
    }
  }
  refreshUsage();
}

const save = (note) => fetch(`/api/notes/${note.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...note, busy: undefined }) });

// Math: $$…$$ and \[…\] (display), $…$ and \(…\) (inline). Inline $ follows pandoc's rule
// (no space inside the delimiters, no digit right after) so "$5 and $10" stays plain text.
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g;
const escHTML = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// tiny markdown: math → KaTeX, escape, then **bold** and `code`. Math is pulled out first so
// escaping/markdown never touch the TeX; an unclosed $ while streaming just shows as text until it closes.
function md(s) {
  const math = [];
  s = s.replace(MATH, (src, d1, d2, i1, i2) => {
    const tex = d1 ?? d2 ?? i1 ?? i2;
    math.push(window.katex ? katex.renderToString(tex, { displayMode: d1 != null || d2 != null, throwOnError: false }) : escHTML(src));
    return `\u0000${math.length - 1}\u0000`;
  });
  return escHTML(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => math[i]);
}
