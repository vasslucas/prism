/* Scramjet-powered, Chrome-styled tabbed web proxy */
"use strict";

const SEARCH_ENGINE = "https://duckduckgo.com/?q=";

// ---------- Scramjet controller + bare-mux transport ----------
const scramjet = new $scramjetLoadController().ScramjetController({
  prefix: "/scramjet/",
  wasmUrl: "/scramjet.wasm.wasm",
  bundleUrl: "/scramjet.bundle.js",
  syncUrl: "/scramjet.sync.js",
});

async function initTransport() {
  const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
  const current = await connection.getTransport();
  if (!current) {
    // No transport configured yet — use the bundled Epoch WS transport.
    // Change the socket URL to your own epoch/wisp server if needed.
    await connection.setTransport("epoch", [{ wasm: false, websocket: "wss://epoch.mercurywork.shop/ws" }]);
  }
}

async function waitForSW() {
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (!navigator.serviceWorker.controller) {
    // first install: wait until the SW takes control
    await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  } else {
    await reg.ready;
  }
}

// ---------- Tab model ----------
/** tab = { id, title, url, frame|null, ntpEl, active } */
let tabs = [];
let seq = 0;
let ready = false;

const elsTabs = document.getElementById("tabs");
const elsContent = document.getElementById("content");
const elsAddress = document.getElementById("address");

function activeTab() {
  return tabs.find((t) => t.active);
}

function createTabElement(tab) {
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = tab.id;
  el.innerHTML = `
    <div class="tab-favicon"></div>
    <div class="tab-title">New Tab</div>
    <button class="tab-close" title="Close">&#10005;</button>`;
  el.addEventListener("mousedown", (e) => {
    if (e.target.closest(".tab-close")) return;
    activateTab(tab.id);
  });
  el.querySelector(".tab-close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });
  elsTabs.appendChild(el);
  tab.el = el;
  return el;
}

function renderTabChrome(tab) {
  if (!tab.el) return;
  tab.el.classList.toggle("active", tab.active);
  tab.el.querySelector(".tab-title").textContent = tab.title || "New Tab";
}

function makeNTP(tab) {
  const ntp = document.createElement("div");
  ntp.className = "ntp";
  ntp.innerHTML = `
    <div class="ntp-logo">proxy</div>
    <div class="ntp-search">
      <input type="text" placeholder="Search or type a URL" spellcheck="false" />
    </div>
    <div class="shortcuts"></div>`;
  const shortcuts = [
    ["YouTube", "https://youtube.com", "▶"],
    ["GitHub", "https://github.com", ""],
    ["Reddit", "https://reddit.com", "(r)"],
    ["Wikipedia", "https://wikipedia.org", "W"],
    ["DuckDuckGo", "https://duckduckgo.com", "D"],
  ];
  const grid = ntp.querySelector(".shortcuts");
  for (const [name, url, glyph] of shortcuts) {
    const s = document.createElement("div");
    s.className = "shortcut";
    s.innerHTML = `<div class="tile">${glyph}</div><span>${name}</span>`;
    s.addEventListener("click", () => navigate(activeTab(), url));
    grid.appendChild(s);
  }
  ntp.querySelector("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigate(tab, e.target.value.trim());
  });
  elsContent.appendChild(ntp);
  return ntp;
}

function newTab(url) {
  const tab = {
    id: ++seq,
    title: "New Tab",
    url: null,
    frame: null,
    ntpEl: null,
    active: false,
  };
  tab.ntpEl = makeNTP(tab);
  createTabElement(tab);
  tabs.push(tab);
  activateTab(tab.id);
  if (url) navigate(tab, url);
  return tab;
}

function activateTab(id) {
  const target = tabs.find((t) => t.id === id);
  if (!target) return;
  for (const t of tabs) {
    t.active = t === target;
    renderTabChrome(t);
  }
  for (const t of tabs) {
    const showPage = t.active && !!t.url;
    const showNtp = t.active && !t.url;
    if (t.frame) t.frame.frame.classList.toggle("visible", showPage);
    if (t.ntpEl) t.ntpEl.classList.toggle("visible", showNtp);
  }
  const t = activeTab();
  elsAddress.value = t && t.url ? t.url : "";
  document.title = (t && t.title) || "New Tab";
  updateNavButtons();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  const wasActive = tab.active;
  if (tab.frame) {
    tab.frame.frame.remove(); // detach the iframe (ScramjetFrame has no destroy())
  }
  if (tab.ntpEl) tab.ntpEl.remove();
  if (tab.el) tab.el.remove();
  tabs.splice(idx, 1);
  if (!tabs.length) { newTab(); return; }
  if (wasActive) activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
}

// ---------- Navigation ----------
function normalizeInput(raw) {
  if (!raw) return null;
  let input = raw.trim();
  if (/^https?:\/\//i.test(input)) return input;
  // looks like a host? (no spaces, has a dot)
  if (!/\s/.test(input) && /^[^\s]+\.[^\s]+/.test(input)) return "https://" + input;
  return SEARCH_ENGINE + encodeURIComponent(input);
}

async function navigate(tab, rawInput) {
  const url = normalizeInput(rawInput);
  if (!url || !ready) return;

  if (!tab.frame) {
    const frame = scramjet.createFrame(); // creates its own iframe element
    tab.frame = frame;
    elsContent.appendChild(frame.frame);   // mount it in the content area
    frame.addEventListener("urlchange", (e) => {
      tab.url = e.url;
      if (tab.active) elsAddress.value = e.url;
      refreshTitle(tab);
    });
  }

  tab.ntpEl.classList.remove("visible");
  tab.frame.frame.classList.add("visible");
  tab.url = url;
  if (tab.active) elsAddress.value = url;

  try {
    tab.frame.go(url); // go() is synchronous in ScramjetController's ScramjetFrame
  } catch (err) {
    console.error("navigation failed:", err);
  }
  refreshTitle(tab);
  updateNavButtons();
}

// Best-effort title sync — cross-origin so we can't read the DOM; derive a label from the URL.
function refreshTitle(tab) {
  if (!tab.url) return;
  let host = "";
  try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  tab.title = host || tab.url;
  renderTabChrome(tab);
  if (tab.active) document.title = tab.title;
}

function updateNavButtons() {
  const t = activeTab();
  document.getElementById("back").disabled = !(t && t.frame);
  document.getElementById("forward").disabled = !(t && t.frame);
}

// ---------- UI wiring ----------
document.getElementById("newtab").addEventListener("click", () => newTab());

elsAddress.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const t = activeTab();
    if (t) navigate(t, elsAddress.value);
    elsAddress.blur();
  }
  if (e.key === "Escape") { elsAddress.value = activeTab()?.url || ""; elsAddress.blur(); }
});
elsAddress.addEventListener("focus", () => elsAddress.select());

document.getElementById("reload").addEventListener("click", () => {
  const t = activeTab();
  if (t && t.url) navigate(t, t.url);
});
document.getElementById("back").addEventListener("click", () => {
  const t = activeTab();
  if (t && t.frame) t.frame.back();
});
document.getElementById("forward").addEventListener("click", () => {
  const t = activeTab();
  if (t && t.frame) t.frame.forward();
});

// keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") { e.preventDefault(); newTab(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") { e.preventDefault(); const t = activeTab(); if (t) closeTab(t.id); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); elsAddress.focus(); }
  if (e.key === "F5") { e.preventDefault(); document.getElementById("reload").click(); }
});

// ⋮ menu
const menuPop = document.createElement("div");
menuPop.className = "menu-pop";
menuPop.innerHTML = `
  <button data-act="newtab">New tab</button>
  <button data-act="closetab">Close tab</button>
  <div class="menu-sep"></div>
  <button data-act="reload">Reload</button>
  <button data-act="home">Go to New Tab page</button>`;
document.body.appendChild(menuPop);
document.getElementById("menu").addEventListener("click", (e) => {
  e.stopPropagation();
  menuPop.classList.toggle("open");
});
menuPop.addEventListener("click", (e) => {
  const act = e.target.dataset.act;
  menuPop.classList.remove("open");
  if (act === "newtab") newTab();
  if (act === "closetab") { const t = activeTab(); if (t) closeTab(t.id); }
  if (act === "reload") document.getElementById("reload").click();
  if (act === "home") { const t = activeTab(); if (t) { t.url = null; activateTab(t.id); } }
});
document.addEventListener("click", () => menuPop.classList.remove("open"));

// ---------- Boot ----------
(async () => {
  try {
    await initTransport();
    await waitForSW(); // scramjet's controller does NOT register the SW itself
    await scramjet.init();
    ready = true;
  } catch (err) {
    console.error("Scramjet boot failed:", err);
    document.getElementById("content").innerHTML =
      '<div style="padding:40px;font-family:monospace;color:#5f6368">Proxy engine failed to start: ' + err + "</div>";
    return;
  }
  newTab();
})();
