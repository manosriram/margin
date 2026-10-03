import * as pdfjs from "./vendor/pdfjs/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let pdf, docName, docKey;
let notes = [];     // {id, page, rects:[[x,y,w,h] as page fractions], quote, question, answer, pinned}
let active = null;  // note currently shown in the margin even if unpinned
const pageText = {};

// ---------- intro ----------
const drop = $("drop");
$("file").onchange = (e) => open(e.target.files[0]);
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => open(e.dataTransfer.files[0]));
$("home").onclick = () => location.reload();

// ---------- models ----------
fetch("/api/models").then((r) => r.json()).then((providers) => {
  const saved = store.get("margin:model", "");
  for (const p of providers) for (const m of p.models) {
    const o = new Option(`${p.name} · ${m}`, `${p.id}|${m}`);
    o.selected = o.value === saved;
    $("model").add(o);
  }
});
$("model").onchange = (e) => store.set("margin:model", e.target.value);
$("suggest").checked = store.get("margin:suggest", true);
$("suggest").onchange = (e) => {
  store.set("margin:suggest", e.target.checked);
  if (!active || active.question) return;
  if (e.target.checked && !active.sugs) return loadSuggestions(active);
  const el = $("cards").querySelector(`[data-id="${active.id}"] .sugs`);
  if (el) fillSuggestions(el, active);
};

// ---------- open + render ----------
async function open(file) {
  if (!file || file.type !== "application/pdf") return;
  $("dropName").textContent = file.name;
  $("dropMeta").textContent = "opening…";
  try {
    pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  } catch (err) {
    $("dropMeta").textContent = "Couldn't open this PDF: " + err.message;
    return;
  }
  docName = file.name;
  docKey = `margin:notes:${file.name}:${file.size}`;
  notes = store.get(docKey, []);
  $("docName").textContent = `${file.name} · ${pdf.numPages} pages`;
  $("intro").hidden = true;
  $("reader").hidden = false;
  await buildPages();
  renderCards();
}

async function buildPages() {
  const box = $("pages");
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  // ponytail: scale fixed at open time; re-layout on resize/zoom if people ask for it
  const scale = Math.min(1.6, (box.clientWidth - 48) / first.width);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); renderPage(e.target, scale); }
  }, { root: box, rootMargin: "600px 0px" });

  for (let n = 1; n <= pdf.numPages; n++) {
    const vp = (await pdf.getPage(n)).getViewport({ scale });
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.n = n;
    // integer CSS size so canvas pixels map 1:1 to screen pixels (fractional sizes get resampled = blurry)
    el.style.width = Math.floor(vp.width) + "px";
    el.style.height = Math.floor(vp.height) + "px";
    el.innerHTML = `<canvas></canvas><div class="hl"></div><div class="textLayer"></div><span class="num">${n}</span>`;
    box.append(el);
    io.observe(el);
  }

  // browser zoom / moving to another display changes devicePixelRatio → repaint at the new density
  const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener("change", () => {
    document.querySelectorAll(".page[data-done]").forEach((el) => paint(el, scale));
    watchDpr();
  }, { once: true });
  watchDpr();
}

async function paint(el, scale) {
  const page = await pdf.getPage(+el.dataset.n);
  const vp = page.getViewport({ scale });
  // fresh canvas each time: pdf.js refuses concurrent renders on one canvas
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(Math.floor(vp.width) * devicePixelRatio);
  canvas.height = Math.round(Math.floor(vp.height) * devicePixelRatio);
  await page.render({ canvas, viewport: vp, transform: [canvas.width / vp.width, 0, 0, canvas.height / vp.height, 0, 0] }).promise;
  el.querySelector("canvas").replaceWith(canvas);
}

async function renderPage(el, scale) {
  const page = await pdf.getPage(+el.dataset.n);
  const vp = page.getViewport({ scale });
  el.style.setProperty("--total-scale-factor", scale);
  const tl = el.querySelector(".textLayer");
  await Promise.all([
    paint(el, scale),
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

// ---------- highlights ----------
function drawHighlights(el) {
  const n = +el.dataset.n, layer = el.querySelector(".hl");
  layer.innerHTML = "";
  for (const note of notes) if (note.page === n) for (const [x, y, w, h] of note.rects) {
    const i = document.createElement("i");
    i.dataset.id = note.id;
    Object.assign(i.style, { left: x * 100 + "%", top: y * 100 + "%", width: w * 100 + "%", height: h * 100 + "%" });
    layer.append(i);
  }
}
const redrawAll = () => document.querySelectorAll(".page").forEach(drawHighlights);

function noteAt(e) {
  const el = e.target.closest?.(".page");
  if (!el) return null;
  const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  return notes.find((n) => n.page === +el.dataset.n && n.rects.some(([rx, ry, rw, rh]) => x >= rx && x <= rx + rw && y >= ry && y <= ry + rh));
}

// ---------- selection → ask ----------
const pages = $("pages");
pages.addEventListener("mousedown", (e) => e.target.closest(".textLayer")?.classList.add("selecting"));
document.addEventListener("mouseup", () => document.querySelectorAll(".textLayer.selecting").forEach((t) => t.classList.remove("selecting")));

pages.addEventListener("mouseup", (e) => setTimeout(() => {
  const sel = getSelection(), quote = sel.toString().trim();
  if (!quote) {
    const hit = noteAt(e);
    if (hit) { active = hit; renderCards(); focusCard(hit); }
    return;
  }
  const range = sel.getRangeAt(0);
  const el = range.startContainer.parentElement?.closest(".page");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const rects = [...range.getClientRects()]
    .filter((c) => c.width > 1 && c.height > 1 && c.top < r.bottom && c.bottom > r.top)
    .map((c) => [(c.left - r.left) / r.width, (c.top - r.top) / r.height, c.width / r.width, c.height / r.height]);
  notes = notes.filter((n) => n.question); // drop any unasked draft
  active = { id: crypto.randomUUID(), page: +el.dataset.n, rects, quote, question: "", answer: "", pinned: false };
  renderCards();
  $("cards").querySelector("textarea")?.focus();
  if ($("suggest").checked) loadSuggestions(active);
}));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !active) return;
  active = null;
  renderCards();
});

// hover: unpinned answers show as a popover; pinned ones light up their card
pages.addEventListener("mousemove", (e) => {
  const hit = noteAt(e), pop = $("pop");
  document.querySelectorAll(".hl i.on, .card.on").forEach((x) => x.classList.remove("on"));
  if (!hit) return (pop.hidden = true);
  document.querySelectorAll(`[data-id="${hit.id}"]`).forEach((x) => x.classList.add("on"));
  if (hit.pinned || hit === active) return (pop.hidden = true);
  pop.innerHTML = `<div class="q"></div><div class="a"></div>`;
  pop.querySelector(".q").textContent = "Q · " + hit.question;
  pop.querySelector(".a").innerHTML = md(hit.answer);
  pop.hidden = false;
  pop.style.left = Math.min(e.clientX + 14, innerWidth - 340) + "px";
  pop.style.top = Math.min(e.clientY + 14, innerHeight - pop.offsetHeight - 10) + "px";
});
pages.addEventListener("mouseleave", () => ($("pop").hidden = true));

// ---------- margin cards ----------
function renderCards() {
  const shown = notes.filter((n) => n.pinned || n === active);
  if (active && !notes.includes(active)) shown.push(active);
  shown.sort((a, b) => a.page - b.page || a.rects[0]?.[1] - b.rects[0]?.[1]);
  $("split").classList.toggle("open", shown.length > 0);
  const box = $("cards");
  box.replaceChildren(...shown.map(card));
  redrawAll();
}

function card(note) {
  const c = document.createElement("div");
  c.className = "card";
  c.dataset.id = note.id;
  c.innerHTML = `<div class="quote"><small>p.${note.page}</small></div>`;
  c.querySelector(".quote").append(note.quote);
  c.querySelector(".quote").onclick = () => document.querySelector(`.page[data-n="${note.page}"]`).scrollIntoView({ behavior: "smooth" });

  if (!note.question) {
    c.insertAdjacentHTML("beforeend", `<textarea rows="2" placeholder="Ask about this passage…"></textarea><div class="hint">enter to ask · esc to close</div><div class="sugs"></div>`);
    const ta = c.querySelector("textarea");
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && ta.value.trim()) { e.preventDefault(); ask(note, ta.value.trim()); }
    };
    fillSuggestions(c.querySelector(".sugs"), note);
    return c;
  }
  c.insertAdjacentHTML("beforeend", `<div class="q"></div><div class="a"></div><div class="actions"><button class="pin"></button><button class="del">delete</button></div>`);
  c.querySelector(".q").textContent = "Q · " + note.question;
  c.querySelector(".a").innerHTML = md(note.answer);
  const pin = c.querySelector(".pin");
  pin.textContent = note.pinned ? "◆ pinned" : "◇ pin";
  pin.classList.toggle("pinned", note.pinned);
  pin.onclick = () => { note.pinned = !note.pinned; save(); renderCards(); };
  c.querySelector(".del").onclick = () => { notes = notes.filter((n) => n !== note); if (active === note) active = null; save(); renderCards(); };
  return c;
}

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
  const [provider] = $("model").value.split("|");
  try {
    const res = await fetch("/api/suggest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, doc: docName, page: note.page, selection: note.quote, context: await getPageText(note.page) }),
    });
    note.sugs = res.ok ? await res.json() : [];
  } catch {
    note.sugs = [];
  }
  refresh();
}

function fillSuggestions(el, note) {
  el.replaceChildren();
  if (!$("suggest").checked || !note.sugs) return;
  if (note.sugs === "loading") return (el.innerHTML = `<span class="loading">suggesting questions…</span>`);
  for (const q of note.sugs) {
    const b = document.createElement("button");
    b.textContent = q;
    b.onclick = () => ask(note, q);
    el.append(b);
  }
}

async function ask(note, question) {
  delete note.sugs;
  note.question = question;
  notes.push(note);
  getSelection().removeAllRanges();
  renderCards();
  const [provider, model] = $("model").value.split("|");
  const body = { provider, model, doc: docName, page: note.page, selection: note.quote, context: await getPageText(note.page), question };
  const out = () => $("cards").querySelector(`[data-id="${note.id}"] .a`);
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      note.answer += value;
      const a = out();
      if (a) a.innerHTML = md(note.answer);
    }
  } catch (err) {
    note.answer += `\n⚠ ${err.message}`;
    const a = out();
    if (a) a.innerHTML = md(note.answer);
  }
  save();
}

const save = () => store.set(docKey, notes.filter((n) => n.question));

// tiny markdown: escape, then **bold** and `code`
function md(s) {
  const esc = s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return esc.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}
