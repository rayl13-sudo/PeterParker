// Map page: OpenStreetMap of UC Irvine with every parking lot shaded by category
// (free, permit, paid, limited/tow risk) and marked, with UCI permit and
// daily-pass details, what each lot is for, and tow/time-limit warnings in popups.
// Leaflet is loaded as a global (L) by map.html.
import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { renderAvatar } from "./avatar.js";

const SIGN_IN_PAGE = "index.html";
const UCI_CENTER = [33.6461, -117.8427]; // Aldrich Park, middle of campus
// Start this many zoom levels past the fit-all-lots view. Each level is 2x, so 2 = 4x.
const EXTRA_ZOOM = 2;

// One entry per lot category: drives the map shading, markers, popups, the key and
// the list order. Blue = free, gray = costs something, light red = you might be
// ticketed or towed. Paid lots get a dashed edge to read differently from permit lots.
const CATEGORIES = {
  free: { label: "Free", color: "#3f5fae", fillOpacity: 0.55, marker: "pin" },
  permit: { label: "Permit required", color: "#3d4457", fillOpacity: 0.4 },
  paid: { label: "Paid", color: "#6b7184", fillOpacity: 0.12, dashArray: "5 4", weight: 2 },
  limited: { label: "Limited / may be towed", color: "#e06f68", fillOpacity: 0.3, marker: "dot" },
};
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const isFree = (lot) => lot.category === "free";

const $ = (id) => document.getElementById(id);

function toSignIn() {
  clearToken();
  location.replace(SIGN_IN_PAGE);
}

if (!getToken()) toSignIn();
setUnauthorizedHandler(toSignIn);

// ---------- Remembered UI state (best effort; storage may be unavailable) ----------

function loadFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveFlag(key, value) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Not critical.
  }
}

// ---------- Map ----------

const map = L.map("map", { zoomControl: false, dragging: true }).setView(UCI_CENTER, 16);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

function pinIcon(lot) {
  return L.divIcon({
    className: "pin",
    html: `<svg viewBox="0 0 28 36" width="28" height="36" aria-hidden="true">
      <path fill="${CATEGORIES[lot.category].color}"
            d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 22.6 14 35 14 35s12.5-12.4 12.5-21.7C26.5 6.4 21 1 14 1Z"/>
      <text x="14" y="18" text-anchor="middle">P</text>
    </svg>`,
    iconSize: [28, 36],
    iconAnchor: [14, 35],
    popupAnchor: [0, -32],
  });
}

// Visitor prices and hours from UCI (filled in from the API response).
let permitInfo = null;
const VISITOR_PERMIT = "GNA"; // one-day General visitor permit

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const memberPermits = (lot) => lot.permits.filter((p) => p.code !== VISITOR_PERMIT);
const takesVisitorPass = (lot) => lot.permits.some((p) => p.code === VISITOR_PERMIT);

function permitSection(lot) {
  const section = el("div", "popup-section");
  section.append(el("h4", null, "Permits accepted"));
  const permits = memberPermits(lot);
  if (!permits.length) {
    section.append(el("p", null, "UCI permit required. UCI's public permit pages don't say which permit this lot takes."));
    return section;
  }
  const list = el("ul", "permit-list");
  for (const permit of permits) {
    const li = el("li");
    li.append(el("b", null, permit.name), el("span", null, `${permit.who} · ${permit.price}`));
    list.append(li);
  }
  section.append(list);
  if (lot.permit_note) section.append(el("p", "popup-note", lot.permit_note));
  return section;
}

function dailyPassSection(lot) {
  const section = el("div", "popup-section");
  section.append(el("h4", null, "Daily pass"));
  const surface = lot.parking === "surface";
  const rates = permitInfo.visitor_rates.filter((r) => !r.name.startsWith("Overnight") || (surface && takesVisitorPass(lot)));
  const table = el("ul", "rate-list");
  for (const rate of rates) {
    const li = el("li");
    li.title = rate.where;
    li.append(el("span", null, rate.name), el("b", null, rate.price));
    table.append(li);
  }
  section.append(table);
  section.append(
    el("p", "popup-note", takesVisitorPass(lot)
      ? "Weekdays 7 a.m.–midnight in general stalls; buy at a kiosk, dispenser or PARKbyPLATE."
      : "Weekdays: check the signs or dispenser at this lot for which pass applies."),
    el("p", "popup-note", "Evenings after 5 p.m. and weekends: the $16 one-day General pass works in general, P and AR stalls."),
  );
  return section;
}

function warningBox(lot) {
  const box = el("div", "popup-warning");
  box.append(el("b", null, lot.time_limit ? `⚠ ${lot.time_limit} max · tow risk` : "⚠ May be ticketed or towed"));
  box.append(el("p", null, lot.warning ?? "This isn't public parking. Park only if you're visiting what it serves, and check the posted signs."));
  if (lot.warning_source) {
    const src = el("a", null, "Source");
    src.href = lot.warning_source;
    src.target = "_blank";
    src.rel = "noopener";
    box.append(src);
  }
  return box;
}

function popupContent(lot) {
  const cat = CATEGORIES[lot.category];
  const root = el("div", "popup");

  const tag = el("span", "tag", cat.label);
  tag.style.setProperty("--tag-color", cat.color);
  root.append(el("strong", null, lot.name), tag);

  if (lot.serves.length) {
    const serves = el("p", "popup-serves");
    serves.append(el("b", null, "For: "), document.createTextNode(lot.serves.join(" · ")));
    root.append(serves);
  }

  const details = [
    lot.restriction && `Who can park: ${lot.restriction}`,
    lot.time_limit && `Time limit: ${lot.time_limit}`,
    lot.permit_accepted && "UCI permits also accepted",
    lot.inferred,
    lot.capacity && `${lot.capacity.toLocaleString()} spaces`,
    lot.opening_hours && `Hours: ${lot.opening_hours}`,
  ].filter(Boolean);
  for (const text of details) root.append(el("p", null, text));

  if (lot.category === "limited") root.append(warningBox(lot));

  if (lot.uci && (lot.category === "permit" || lot.category === "paid")) {
    root.append(permitSection(lot));
    if (lot.category === "paid" || takesVisitorPass(lot)) {
      root.append(dailyPassSection(lot));
    } else {
      root.append(el("p", "popup-note", "Evenings after 5 p.m. and weekends: a $16 one-day General pass works in general, P and AR stalls."));
    }
    const source = el("a", "popup-source", `Rates: UCI Transportation, ${permitInfo.academic_year}`);
    source.href = "https://parking.uci.edu/permits/visitor";
    source.target = "_blank";
    source.rel = "noopener";
    root.append(source);
  }

  const link = el("a", null, "Directions →");
  link.href = `https://www.openstreetmap.org/directions?to=${lot.lat},${lot.lon}#map=18/${lot.lat}/${lot.lon}`;
  link.target = "_blank";
  link.rel = "noopener";
  root.append(link);
  return root;
}

const POPUP_OPTIONS = { maxWidth: 300, maxHeight: 380 };

function dot(lot) {
  const cat = CATEGORIES[lot.category];
  return L.circleMarker([lot.lat, lot.lon], {
    radius: 6,
    color: "#fff",
    weight: 2,
    fillColor: cat.color,
    fillOpacity: 1,
  });
}

// Each lot is shaded by its outline; free lots also get a pin and limited lots a dot
// so every spot is easy to find. Lots mapped as a single point only get the marker.
function addLot(lot) {
  const cat = CATEGORIES[lot.category];
  const content = popupContent(lot);
  const area = lot.outline.length
    ? L.polygon(lot.outline, {
        color: cat.color,
        weight: cat.weight ?? 1.5,
        fillColor: cat.color,
        fillOpacity: cat.fillOpacity,
        dashArray: cat.dashArray,
      })
        .bindPopup(content, POPUP_OPTIONS)
        .addTo(map)
    : null;

  const marker =
    cat.marker === "pin"
      ? L.marker([lot.lat, lot.lon], { icon: pinIcon(lot), title: lot.name, zIndexOffset: 500 })
      : cat.marker === "dot" || !area
        ? dot(lot)
        : null;
  if (!marker) return area;
  marker.addTo(map);
  if (area) marker.on("click", () => area.openPopup([lot.lat, lot.lon]));
  else marker.bindPopup(content, POPUP_OPTIONS);
  return marker;
}

// ---------- Side list: Free / Permit / Paid / Limited tabs ----------

const LIST_TABS = {
  free: { title: "Free parking", match: (lot) => isFree(lot) },
  permit: { title: "Permit parking", match: (lot) => lot.category === "permit" },
  paid: { title: "Paid parking", match: (lot) => lot.category === "paid" },
  limited: { title: "Limited / tow-risk parking", match: (lot) => lot.category === "limited" },
};
let listEntries = []; // [{ lot, layer }]
let activeTab = "free";

function listMeta(lot) {
  const cat = CATEGORIES[lot.category];
  if (lot.category === "paid") return "One-day pass $16 · Reserved $20 · Hourly $4–$5";
  if (lot.category === "limited") {
    if (lot.utc) return `University Town Center · ${lot.time_limit} max · tow risk`;
    return [lot.restriction.split(":")[0].split(";")[0], lot.serves[0]?.split(" (")[0]].filter(Boolean).join(" · ");
  }
  if (lot.category === "permit") {
    const codes = memberPermits(lot).map((p) => (p.code === "S-ANY" ? "any S/P zone" : p.code));
    const visitors = takesVisitorPass(lot) ? "Visitors $16/day" : null;
    if (!codes.length) {
      if (!lot.uci) return cat.label;
      return visitors ? `${visitors} · permit type not published` : "UCI permit (type not published)";
    }
    return [`Permits: ${codes.join(", ")}`, visitors].filter(Boolean).join(" · ");
  }
  return cat.label + (lot.capacity ? ` · ${lot.capacity} spaces` : "");
}

function listItem({ lot, layer }) {
  const btn = el("button");
  btn.type = "button";
  const swatch = el("i", "swatch");
  swatch.style.background = CATEGORIES[lot.category].color;
  const text = el("span", "spot-text");
  text.append(el("span", null, lot.name), el("small", null, listMeta(lot)));
  btn.append(swatch, text);
  btn.addEventListener("click", () => {
    map.flyTo([lot.lat, lot.lon], 18, { duration: 0.6 });
    map.once("moveend", () => layer.fire("click", { latlng: L.latLng(lot.lat, lot.lon) }));
  });
  const li = el("li");
  li.append(btn);
  return li;
}

function renderList() {
  const tab = LIST_TABS[activeTab];
  const entries = listEntries.filter(({ lot }) => tab.match(lot));
  $("panel-title").textContent = `${tab.title} near UCI`;
  $("spot-count").textContent = `${entries.length} ${entries.length === 1 ? "lot" : "lots"}`;
  $("spot-list").replaceChildren(...entries.map(listItem));
  document.querySelectorAll(".list-tab").forEach((btn) => {
    const active = btn.dataset.list === activeTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}

document.querySelectorAll(".list-tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.list;
    renderList();
  }),
);

function renderLots(lots) {
  lots = [...lots].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  listEntries = lots.map((lot) => ({ lot, layer: addLot(lot) }));
  for (const [key, tab] of Object.entries(LIST_TABS)) {
    document.querySelector(`.list-tab[data-list="${key}"] .count`).textContent = lots.filter(tab.match).length;
  }
  renderList();
  if (lots.length) fitToLots(lots);
}

function fitToLots(lots) {
  // Leave room for the side panel (desktop) or bottom sheet (mobile).
  const panel = $("panel").getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  map.fitBounds(L.latLngBounds(lots.map((lot) => [lot.lat, lot.lon])), {
    paddingTopLeft: [mobile ? 32 : panel.right + 32, 48],
    paddingBottomRight: [48, mobile ? window.innerHeight - panel.top + 32 : 48],
    maxZoom: 16,
    animate: false,
  });
  // Zoom in 4x, keeping campus where it is on screen. Drag to see the rest.
  map.setZoomAround(UCI_CENTER, map.getZoom() + EXTRA_ZOOM, { animate: false });
}

// ---------- Collapsible side panel and key ----------

function setupCollapsible({ container, toggle, storageKey, labels }) {
  const apply = (collapsed) => {
    container.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (labels) toggle.setAttribute("aria-label", collapsed ? labels.show : labels.hide);
  };
  apply(loadFlag(storageKey));
  toggle.addEventListener("click", () => {
    const collapsed = !container.classList.contains("collapsed");
    apply(collapsed);
    saveFlag(storageKey, collapsed);
  });
}

setupCollapsible({
  container: $("panel"),
  toggle: $("panel-toggle"),
  storageKey: "pp_panel_collapsed",
  labels: { show: "Show free parking list", hide: "Hide free parking list" },
});
setupCollapsible({ container: $("map-key"), toggle: $("key-toggle"), storageKey: "pp_key_collapsed" });

function renderKey() {
  $("key-list").replaceChildren(
    ...Object.values(CATEGORIES).map((cat) => {
      const li = document.createElement("li");
      const swatch = document.createElement("i");
      swatch.className = "key-swatch";
      swatch.style.setProperty("--swatch", cat.color);
      swatch.style.setProperty("--swatch-fill", cat.fillOpacity);
      if (cat.dashArray) swatch.classList.add("dashed");
      const label = document.createElement("span");
      label.textContent = cat.label;
      li.append(swatch, label);
      return li;
    }),
  );
}
renderKey();

// ---------- Boot ----------

$("logout").addEventListener("click", async () => {
  try {
    await api.logout();
  } finally {
    toSignIn();
  }
});

async function init() {
  try {
    const [user, parking] = await Promise.all([api.me(), api.parking()]);
    $("user-name").textContent = user.username ?? user.email;
    $("user-name").title = user.email;
    renderAvatar($("user-avatar"), user.avatar);
    permitInfo = parking.permit_info;
    renderLots(parking.lots);
  } catch (err) {
    $("spot-count").textContent = "";
    $("map-error").textContent = err.message;
    $("map-error").hidden = false;
  }
}

init();
