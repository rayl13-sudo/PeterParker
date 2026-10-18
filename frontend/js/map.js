// Map page: OpenStreetMap of UC Irvine with every parking lot shaded by category
// (free, permit, paid, limited/tow risk) and marked, with UCI permit and
// daily-pass details, what each lot is for, and tow/time-limit warnings in popups.
// Leaflet is loaded as a global (L) by map.html.
import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { bindAvatarPreview, renderAvatar } from "./avatar.js";
import { averageRating, initReviews, openReviews, ratingLabel } from "./reviews.js";
import { startMapTour } from "./map-tour.js";
import { createMapHistory } from "./map-history.mjs";
import { ARC_HOURS_SOURCE, STALL_NOTE, assignedArea, describeWindow, isHomeLot, notValidFor, permitStatus, rulesSourceFor } from "./permit-rules.js";
import { AVAILABILITY_NOTE, openNow } from "./availability.js";

const SIGN_IN_PAGE = "index.html";
const UCI_CENTER = [33.6461, -117.8427]; // Aldrich Park, middle of campus
// Start this many zoom levels past the fit-all-lots view. Each level is 2x, so 2 = 4x.
const EXTRA_ZOOM = 2;

// One entry per lot category: drives the map shading, markers, popups, the key and
// the list order. Blue = free, gray = costs something, light red = you might be
// ticketed or towed. Paid lots get a dashed edge to read differently from permit lots.
const CATEGORIES = {
  free: { label: "Free", color: "#3f5fae", fillOpacity: 0.55, marker: "pin" },
  // Permit lots your own permit covers right now (see permit-rules.js); shown only if you set one.
  mine: { label: "Free with your permit", color: "#13806a", fillOpacity: 0.5 },
  permit: { label: "Permit required", color: "#3d4457", fillOpacity: 0.4 },
  paid: { label: "Paid", color: "#6b7184", fillOpacity: 0.12, dashArray: "5 4", weight: 2 },
  limited: { label: "Limited / may be towed", color: "#e06f68", fillOpacity: 0.3, marker: "dot" },
  // UCI's "Faculty, Staff & Visitor Parking" lots (map.uci.edu) that aren't also student zone lots.
  staff: { label: "Faculty & staff", color: "#8a5cb8", fillOpacity: 0.35 },
};
const CATEGORY_ORDER = Object.keys(CATEGORIES);
const isFree = (lot) => lot.category === "free";

const $ = (id) => document.getElementById(id);
let mapHistory = null;
let savedView = false;

function rememberTarget(type, id) {
  mapHistory?.remember({ type, id });
  renderRecentShortcuts();
}

function saveButton(type, id, name, compact = false) {
  const button = el("button", "save-place");
  button.type = "button";
  const update = () => {
    const saved = mapHistory?.isSaved({ type, id }) ?? false;
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute("aria-label", `${saved ? "Remove" : "Save"} ${name} ${saved ? "from" : "to"} saved places`);
    button.title = saved ? "Remove from saved places" : "Save place";
    button.textContent = compact ? (saved ? "★" : "☆") : (saved ? "★ Saved" : "☆ Save");
  };
  update();
  button.addEventListener("click", () => {
    mapHistory?.toggleSaved({ type, id });
    update();
    updateSavedButton();
    renderList();
  });
  return button;
}

function updateSavedButton() {
  $("saved-count").textContent = mapHistory?.saved().length ? `(${mapHistory.saved().length})` : "";
  $("saved-toggle").setAttribute("aria-pressed", String(savedView));
}

function toSignIn() {
  clearToken();
  window.ppNavigate(SIGN_IN_PAGE, { replace: true });
}

if (!getToken()) toSignIn();
setUnauthorizedHandler(toSignIn);

// ---------- Remembered UI state (best effort; storage may be unavailable) ----------

function loadFlag(key, fallback = false) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
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

// flyTo handles camera animation; avoid a queued CSS zoom overriding a selected lot.
const map = L.map("map", { zoomControl: false, dragging: true, zoomAnimation: false }).setView(UCI_CENTER, 16);
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
let uciSource = null; // map.uci.edu, where official space counts come from
const VISITOR_PERMIT = "GNA"; // one-day General visitor permit

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const memberPermits = (lot) => lot.permits.filter((p) => p.code !== VISITOR_PERMIT);
const takesVisitorPass = (lot) => lot.permits.some((p) => p.code === VISITOR_PERMIT);

// A pay lot stays a pay lot even when your permit covers it, and staff/permit lots
// with UCI dispensers or ParkbyPlate are also places visitors can pay.
// "Paid lot" = a lot with a parking fee (OSM fee=yes), even if it's now a staff lot.
const isPaidLot = (lot) => (lot.baseCategory ?? lot.category) === "paid" || lot.pay.includes("fee");
const PAY_LABELS = { dispenser: "permit dispenser", pay_by_space: "Pay-by-Space", parkbyplate: "ParkbyPlate (pay by plate)", fee: "pay station" };
const payMethods = (lot) => {
  const named = lot.pay.filter((k) => k !== "fee");
  return (named.length ? named : lot.pay).map((k) => PAY_LABELS[k]);
};
const coveredLabel = (lot) =>
  isPaidLot(lot)
    ? `Paid lot · your ${userPermit} permit covers it ${lot.permitStatus.until}`
    : `Free with your ${userPermit} permit · ${lot.permitStatus.until}`;

// ----- Spaces: regular / accessible / EV, from UCI's map where it has them -----

const STALL_LABELS = {
  General: "Regular",
  "AR Reserved (7am-5pm)": "“AR” reserved (7am–5pm)",
  "AR Reserved (24 Hr)": "“AR” reserved (24 hr)",
  "AR Reserved": "“AR” reserved",
  "AR-CAV Reserved": "“AR-CAV” reserved",
  "P Preferred": "“P” preferred",
  "X Executive": "“X” executive",
  "MX Motorcycle": "Motorcycle",
  "Electric Vehicle": "EV stalls (designated)",
  "Electric Veh. (ADA)": "EV stalls (accessible)",
  "ADA (Standard)": "Accessible",
  "ADA (Van)": "Accessible (van)",
  "E-Plate": "E-plate (UCI vehicles)",
};
const fmt = (n) => Number(n).toLocaleString();

// "Sat 3:40 pm", campus time.
const campusClock = () =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" })
    .format(new Date())
    .replace(/\s?([AP])M/, (_, ap) => ` ${ap.toLowerCase()}m`);

function statTile(value, label, title) {
  const tile = el("div", "stat");
  if (title) tile.title = title;
  tile.append(el("b", null, value), el("span", null, label));
  return tile;
}

function spacesSection(lot) {
  const sp = lot.spaces;
  const section = el("div", "popup-section spaces");
  const official = sp.source === "uci";
  section.append(el("h4", null, official ? `Spaces · ${fmt(sp.total)} total` : sp.source === "osm" ? `Spaces · ${fmt(sp.total)} total` : `Spaces · ≈${fmt(sp.total)} (estimated)`));

  const evPorts = sp.ev_ports ? sp.ev_ports.level1 + sp.ev_ports.level2 : 0;
  const open = openNow(lot);
  const tiles = el("div", "stat-row");
  tiles.append(
    statTile(official ? fmt(sp.regular ?? 0) : sp.source === "osm" ? "—" : `≈${fmt(sp.total)}`, "Regular",
      official ? "General stalls (UCI)" : "Not broken down; estimate"),
    statTile(open ? `~${fmt(open.open)}` : "—", "Open now", open ? `About ${Math.round(open.occupancy * 100)}% full at this time on a typical day` : "Lot size unknown"),
    statTile(official ? fmt(evPorts) : "—", "EV ports", official && sp.ev_ports ? `${sp.ev_ports.level2} Level 2 · ${sp.ev_ports.level1} Level 1` : "No public charging listed"),
  );
  tiles.querySelectorAll(".stat")[1].classList.add("open-now");
  section.append(tiles);
  if (open) section.append(el("p", "popup-note open-note", `Open now is typical for ${campusClock()} (${Math.round(open.occupancy * 100)}% full). ${AVAILABILITY_NOTE}`));
  section.append(accessibleSubsection(sp));

  if (official) {
    if (sp.ev_ports) {
      section.append(el("p", "popup-note", `Charging: ${sp.ev_ports.level2} Level 2 · ${sp.ev_ports.level1} Level 1 ports (ChargePoint). Tesla chargers: 0. Teslas can use Level 2 ports with Tesla's J1772 adapter.`));
    } else {
      section.append(el("p", "popup-note", "Charging: none here. Tesla chargers: 0."));
    }
    const details = el("details", "stall-breakdown");
    details.append(el("summary", null, `All ${Object.keys(sp.breakdown).length} stall types${sp.levels ? ` · ${sp.levels} levels` : ""}`));
    const list = el("ul");
    for (const [kind, qty] of Object.entries(sp.breakdown)) {
      const li = el("li");
      li.append(el("span", null, STALL_LABELS[kind] ?? kind), el("b", null, fmt(qty)));
      list.append(li);
    }
    details.append(list);
    section.append(details);
    const src = el("a", "popup-source", "Counts: UCI campus map");
    src.href = lot.uci_map_id ? `https://map.uci.edu/?id=463#!m/${lot.uci_map_id}` : (uciSource ?? "https://map.uci.edu/?id=463");
    src.target = "_blank";
    src.rel = "noopener";
    section.append(src);
  } else {
    section.append(
      el("p", "popup-note", sp.source === "osm"
        ? "Total from OpenStreetMap. The owner doesn't publish EV or Tesla counts."
        : "Size estimated from the lot's mapped area (~30 m² per space incl. aisles). EV and Tesla chargers: none listed."),
    );
  }
  return section;
}

const WHEELCHAIR_ICON =
  '<svg class="a11y-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="4.5" r="2"/><path d="M11 8v6h5l2.5 5"/><path d="M8.5 11a5.5 5.5 0 1 0 7 7"/></svg>';

// "Accessible parking" subsection: UCI's counts (standard / van / accessible EV) and where
// the stalls are; otherwise the ADA minimum for a lot that size, marked as an estimate.
function accessibleSubsection(sp) {
  const box = el("div", "accessible-sub");
  const head = el("h5");
  head.insertAdjacentHTML("beforeend", WHEELCHAIR_ICON);
  head.append(el("span", null, "Accessible parking"));
  box.append(head);

  if (sp.accessible == null) {
    box.append(el("p", "popup-note", "Not published for this lot."));
    return box;
  }
  const count = el("p", "a11y-count");
  count.append(el("b", null, sp.accessible_is_minimum ? `≥${fmt(sp.accessible)}` : fmt(sp.accessible)));
  count.append(el("span", null, sp.accessible === 1 && !sp.accessible_is_minimum ? " spot" : " spots"));
  box.append(count);

  if (sp.accessible_is_minimum) {
    box.append(el("p", "popup-note", "Not published by the owner; this is the minimum the ADA requires for a lot this size."));
    return box;
  }
  const parts = [
    sp.accessible_standard ? `${fmt(sp.accessible_standard)} standard` : null,
    sp.accessible_van ? `${fmt(sp.accessible_van)} van-accessible` : null,
    sp.accessible_ev ? `${fmt(sp.accessible_ev)} accessible EV` : null,
  ].filter(Boolean);
  if (parts.length) {
    const chips = el("div", "a11y-parts");
    for (const part of parts) chips.append(el("span", null, part));
    box.append(chips);
  }
  if (sp.accessible === 0) box.append(el("p", "popup-note", "UCI lists no accessible stalls in this lot."));
  for (const note of sp.accessible_where) box.append(el("p", "a11y-where", note));
  box.append(el("p", "popup-note", "Display a DMV disabled-person placard or plate. A valid UCI permit is also required."));
  return box;
}

function staffSection(lot) {
  const section = el("div", "popup-section");
  section.append(el("h4", null, "Faculty & staff parking"));
  section.append(el("p", null, "For UCI faculty and staff permits (“C” general, “AR” reserved, “X” executive)."));
  section.append(el("p", "popup-note", "Students with “S”/“P”/“E” permits and visitors with a $16 one-day pass may use general, P and non-24-hour AR stalls here weekdays after 5 pm and on weekends."));
  if (/^Lot 80$/.test(lot.name)) section.append(el("p", "popup-note", "Lot 80: UCI asks you to email parking@uci.edu to park here."));
  if (/^Lot 1C$/.test(lot.name)) section.append(el("p", "popup-note", "Lot 1C isn't valid for “C” general permits."));
  const src = el("a", "popup-source", "UCI faculty & staff permits");
  src.href = "https://parking.uci.edu/permits/faculty-staff/";
  src.target = "_blank";
  src.rel = "noopener";
  section.append(src);
  return section;
}

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
  if (lot.pay.length) section.append(el("p", "popup-note pay-methods", `Pay here: ${payMethods(lot).join(" · ")}`));
  section.append(
    el("p", "popup-note", takesVisitorPass(lot)
      ? "Weekdays 7 a.m.–Midnight in general stalls; buy at a kiosk, dispenser or PARKbyPLATE."
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
  rememberTarget("lot", lot.id);
  const cat = CATEGORIES[lot.category];
  const root = el("div", "popup");

  const tag = el("span", "tag", lot.category === "mine" && isPaidLot(lot) ? "Paid lot · covered by your permit" : cat.label);
  tag.style.setProperty("--tag-color", cat.color);
  root.append(el("strong", null, lot.name), tag);
  // Overlapping trait: e.g. a faculty/staff lot where visitors can also pay.
  if (lot.pay.length && (lot.baseCategory ?? lot.category) !== "paid") {
    const paidTag = el("span", "tag tag-also", "Also paid");
    paidTag.style.setProperty("--tag-color", CATEGORIES.paid.color);
    paidTag.title = `Visitors can pay here: ${payMethods(lot).join(", ")}`;
    root.append(paidTag);
  }

  if (lot.serves.length) {
    const serves = el("p", "popup-serves");
    // OSM adds lowercase place types such as "(cafe)"; keep actual name qualifiers like "(AIRB)".
    const names = lot.serves.map((name) => name.replace(/\s+\([a-z][a-z ]*\)$/, ""));
    serves.append(el("b", null, "For: "), document.createTextNode(names.join(" · ")));
    root.append(serves);
  }

  const details = [
    lot.restriction && `Who can park: ${lot.restriction}`,
    lot.time_limit && `Time limit: ${lot.time_limit}`,
    lot.permit_accepted && "UCI permits also accepted",
    lot.merged_from > 1 && `${lot.merged_from} connected sections of one lot`,
    lot.inferred,
    lot.opening_hours && `Hours: ${lot.opening_hours}`,
  ].filter(Boolean);
  for (const text of details) root.append(el("p", null, text));

  if (lot.category === "limited") root.append(warningBox(lot));
  if (lot.permitStatus) root.append(permitSectionForYou(lot));
  if (lot.spaces) root.append(spacesSection(lot));

  const baseCategory = lot.baseCategory ?? lot.category;
  if (baseCategory === "staff") {
    root.append(staffSection(lot));
    if (lot.pay.length) root.append(dailyPassSection(lot));
  } else if (lot.uci && (baseCategory === "permit" || baseCategory === "paid")) {
    root.append(permitSection(lot));
    if (baseCategory === "paid" || takesVisitorPass(lot)) {
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

  const rating = ratingLabel("lot", lot.id);
  const actions = el("div", "popup-actions");
  const go = el("button", "pill-button primary", "Directions");
  go.type = "button";
  go.addEventListener("click", () => {
    map.closePopup();
    startDirections(lot);
  });
  const reviews = el("button", "pill-button", rating ? `Reviews · ${rating}` : "Reviews");
  reviews.type = "button";
  reviews.addEventListener("click", () => {
    map.closePopup();
    showLotReviews(lot);
  });
  actions.append(go, reviews, saveButton("lot", lot.id, lot.name));
  root.append(actions);
  return root;
}

const POPUP_OPTIONS = { maxWidth: 300, maxHeight: 380, autoPan: false };
let nextParkingPopupZoom = null;

function centerParkingPopup({ popup, zoom = map.getZoom() }) {
  clearTimeout(fitTimer);
  map.stop();
  // Make room for details even on short phones or when the legend is expanded.
  if (window.matchMedia("(max-width: 640px)").matches) setPanelLevel(0);
  const frame = map.getContainer().getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  const panel = $("panel");
  const panelRect = panel.getBoundingClientRect();
  const keyRect = $("map-key").getBoundingClientRect();
  const controls = map.getContainer().querySelector(".leaflet-top.leaflet-right");
  const controlWidth = controls?.getBoundingClientRect().width ?? 0;
  const panelOpen = !panel.classList.contains("collapsed");
  const left = !mobile && panelOpen ? Math.max(frame.left, panelRect.right) + 16 : frame.left + 16;
  const right = frame.right - controlWidth - 24;
  const top = mobile ? Math.max(frame.top + 16, keyRect.bottom + 12) : frame.top + 16;
  const bottom = mobile && panelOpen ? panelRect.top - 16
    : Math.min(frame.bottom - 24, mobile ? frame.bottom - 24 : keyRect.top - 16);
  const availableHeight = bottom - top;
  // Long descriptions scroll within the space above the mobile results sheet.
  popup.options.maxHeight = Math.max(80, Math.min(380, availableHeight - 64));
  popup.options.maxWidth = Math.max(180, Math.min(300, right - left - 48));
  popup.update();
  const box = popup.getElement().getBoundingClientRect();
  const offset = L.point(
    (box.left + box.right - left - right) / 2,
    (box.top + box.bottom - top - bottom) / 2,
  );
  // Compute the final center at the target zoom, keeping the popup's pixel offset.
  const anchor = map.latLngToContainerPoint(popup.getLatLng());
  const center = map.unproject(
    map.project(popup.getLatLng(), zoom).add(map.getSize().divideBy(2)).add(offset).subtract(anchor),
    zoom,
  );
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    map.setView(center, zoom, { animate: false, reset: true });
  } else if (zoom !== map.getZoom()) {
    map.flyTo(center, zoom, { duration: 0.7, easeLinearity: 0.35 });
  } else {
    map.panTo(center, { animate: true, duration: 0.7, easeLinearity: 0.35 });
  }
}

map.on("popupopen", ({ popup }) => {
  const zoom = nextParkingPopupZoom ?? map.getZoom();
  nextParkingPopupZoom = null;
  requestAnimationFrame(() => {
    if (map.hasLayer(popup)) centerParkingPopup({ popup, zoom });
  });
});

// Lots in your permit's own zone/area get a thick green edge at all times: solid while
// the permit is valid there, dashed while it isn't (e.g. before 7 am).
const HOME_COLOR = "#13806a";
const homeEdge = (lot) =>
  lot.home ? { color: HOME_COLOR, weight: 3.5, dashArray: lot.category === "mine" ? null : "7 5" } : null;

function dot(lot) {
  const cat = CATEGORIES[lot.category];
  return L.circleMarker([lot.lat, lot.lon], {
    radius: lot.home ? 7 : 6,
    color: lot.home ? HOME_COLOR : "#fff",
    weight: lot.home ? 3 : 2,
    fillColor: cat.color,
    fillOpacity: 1,
  });
}

// Each lot is shaded by its outline; free lots also get a pin and limited lots a dot
// so every spot is easy to find. Lots mapped as a single point only get the marker.
function addLot(lot) {
  const cat = CATEGORIES[lot.category];
  const edge = homeEdge(lot);
  const area = lot.outline.length
    ? L.polygon(lot.outline.map((ring) => [ring]), { // each ring is its own piece, not a hole
        color: edge?.color ?? cat.color,
        weight: edge?.weight ?? cat.weight ?? 1.5,
        fillColor: cat.color,
        fillOpacity: cat.fillOpacity,
        dashArray: edge ? edge.dashArray : cat.dashArray,
        className: lot.home ? "home-lot" : undefined,
      })
        .bindPopup(() => popupContent(lot), POPUP_OPTIONS)
        .addTo(map)
    : null;

  // Limited lots share one dot per area (see groupDots), unless a lot has no shape at all.
  const sharedDot = lot.category === "limited" && lot.dot_group && area;
  const marker =
    cat.marker === "pin"
      ? L.marker([lot.lat, lot.lon], { icon: pinIcon(lot), title: lot.name, zIndexOffset: 500 })
      : (cat.marker === "dot" && !sharedDot) || !area
        ? dot(lot)
        : null;
  if (marker) {
    marker.addTo(map);
    if (area) marker.on("click", () => area.openPopup([lot.lat, lot.lon]));
    else marker.bindPopup(() => popupContent(lot), POPUP_OPTIONS);
  }
  // `primary` is what a list click "clicks" to open the popup.
  return { area, marker, primary: marker ?? area };
}

// ---------- Your permit: permit lots it covers right now count as free ----------

let userPermit = null; // e.g. "S4"; set in settings
let canHoldPermit = false; // UCI accounts only; others see permit lots but no permit options
const permitName = (code) => permitInfo?.permits?.[code]?.name ?? code;

// Re-labels lots for the current time; returns true if any lot changed.
function applyPermit(lots, now = new Date()) {
  let changed = false;
  for (const lot of lots) {
    lot.baseCategory ??= lot.category;
    lot.permitStatus = userPermit ? permitStatus(lot, userPermit, now) : null;
    lot.home = isHomeLot(lot, userPermit);
    const next = lot.permitStatus?.active ? "mine" : lot.baseCategory;
    if (next !== lot.category) {
      lot.category = next;
      changed = true;
    }
  }
  return changed;
}

function permitSectionForYou(lot) {
  const status = lot.permitStatus;
  const section = el("div", "popup-section permit-yours");
  section.append(el("h4", null, `Your ${permitName(userPermit)} permit`));
  const area = assignedArea(userPermit);
  if (lot.home && area) section.append(el("p", "permit-home-tag", `Part of ${area.title.replace(/^Your/, "your")}`));
  section.append(
    status.active
      ? el("p", "permit-now ok", `Free for you now · ${status.until}`)
      : el("p", "permit-now no", "Not valid here right now"),
  );
  const list = el("ul", "permit-windows");
  for (const rule of status.windows) {
    const li = el("li", rule === status.active ? "now" : null);
    li.append(el("b", null, describeWindow(rule)), el("span", null, rule.label));
    list.append(li);
  }
  section.append(list);
  const notValid = notValidFor(userPermit);
  if (notValid.length) {
    const details = el("details", "permit-not-valid");
    details.append(el("summary", null, "Not valid in"), el("ul", null));
    for (const item of notValid) details.lastChild.append(el("li", null, item));
    section.append(details);
  }
  const note = el("p", "popup-note", notValid.length ? "" : `${STALL_NOTE} `);
  const src = el("a", null, "UCI permit rules");
  src.href = rulesSourceFor(userPermit);
  src.target = "_blank";
  src.rel = "noopener";
  note.append(src);
  if (status.windows.some((rule) => rule.label.includes("ARC is open"))) {
    const arc = el("a", null, "ARC hours");
    arc.href = ARC_HOURS_SOURCE;
    arc.target = "_blank";
    arc.rel = "noopener";
    note.append(" · ", arc);
  }
  section.append(note);
  return section;
}

// The banner's permit badge doubles as a compact picker for switching permits.
const PERMIT_MENU_GROUPS = [
  { label: "Commuter “S”", test: (c) => /^S\d$/.test(c) },
  { label: "Preferred “P”", test: (c) => /^P\d$/.test(c) },
  { label: "Resident", test: (c) => c.startsWith("R-") },
  { label: "Evening", test: (c) => c === "E" },
  { label: "Faculty & staff", test: (c) => ["C", "AR", "X"].includes(c) },
];

function renderPermitBanner() {
  const banner = $("permit-banner");
  if (!canHoldPermit) {
    banner.hidden = true;
    return;
  }
  const count = listEntries.filter(({ lot }) => lot.category === "mine").length;
  banner.className = userPermit ? "permit-banner" : "permit-banner empty";

  const picker = el("div", "permit-picker");
  const toggle = el("button", "permit-badge");
  toggle.type = "button";
  toggle.id = "permit-toggle";
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", userPermit ? `Your permit: ${permitName(userPermit)}. Change permit` : "Choose your permit");
  toggle.append(el("span", null, userPermit ?? "Add permit"));
  toggle.insertAdjacentHTML("beforeend", '<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>');
  toggle.addEventListener("click", () => (picker.querySelector(".permit-menu") ? closePermitMenu() : openPermitMenu(picker)));
  picker.append(toggle);

  const text = userPermit
    ? count
      ? `${count} ${count === 1 ? "lot is" : "lots are"} free with your permit right now`
      : "Your permit isn't valid in any lot right now"
    : "Have a UCI permit? Pick it to see where you park free.";
  banner.replaceChildren(picker, el("span", "permit-banner-text", text));

  // Your zone's / resident area's lots, always listed, each one a shortcut to the lot.
  const area = assignedArea(userPermit);
  const home = listEntries.filter(({ lot }) => lot.home);
  if (area && home.length) {
    const row = el("div", "permit-home");
    row.append(el("span", "permit-home-title", `${area.title}:`));
    for (const entry of home) {
      const chip = el("button", `permit-home-lot${entry.lot.category === "mine" ? " now" : ""}`, shortLotName(entry.lot));
      chip.type = "button";
      chip.title = `${entry.lot.name}${entry.lot.category === "mine" ? " · valid now" : " · not valid right now"}`;
      chip.addEventListener("click", () => focusLot(entry));
      row.append(chip);
    }
    banner.append(row);
  }
}

// "Anteater Parking Structure" -> "APS"; "Mesa Parking Structure (MPS)" -> "MPS".
function shortLotName(lot) {
  const abbr = /\(([A-Z]{2,5})\)$/.exec(lot.name)?.[1];
  if (abbr) return abbr;
  if (/Parking Structure$/.test(lot.name)) return lot.name.replace(/ Parking Structure$/, "").split(/\s+/).map((w) => w[0]).join("") + "PS";
  return lot.name;
}

function openPermitMenu(picker) {
  if (!permitInfo?.holdable_permits) return;
  if (window.matchMedia("(max-width: 640px)").matches) setPanelLevel(3);
  const menu = el("div", "permit-menu");
  menu.setAttribute("role", "menu");
  for (const { label, test } of PERMIT_MENU_GROUPS) {
    const codes = permitInfo.holdable_permits.filter(test);
    if (!codes.length) continue;
    const row = el("div", "permit-menu-group");
    row.append(el("span", "permit-menu-label", label));
    const options = el("div", "permit-menu-options");
    for (const code of codes) {
      const btn = el("button", `permit-option${code === userPermit ? " current" : ""}`, code);
      btn.type = "button";
      btn.setAttribute("role", "menuitemradio");
      btn.setAttribute("aria-checked", String(code === userPermit));
      btn.title = `${permitName(code).replaceAll('"', "")}: ${permitInfo.permits[code]?.who ?? ""}`;
      btn.addEventListener("click", () => choosePermit(code));
      options.append(btn);
    }
    row.append(options);
    menu.append(row);
  }
  const none = el("button", `permit-option none${userPermit ? "" : " current"}`, "No permit");
  none.type = "button";
  none.setAttribute("role", "menuitemradio");
  none.setAttribute("aria-checked", String(!userPermit));
  none.addEventListener("click", () => choosePermit(null));
  menu.append(none);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePermitMenu({ refocus: true });
  });
  picker.append(menu);
  $("permit-toggle").setAttribute("aria-expanded", "true");
  (menu.querySelector(".permit-option.current") ?? menu.querySelector(".permit-option"))?.focus();
}

function closePermitMenu({ refocus = false } = {}) {
  const menu = document.querySelector(".permit-menu");
  if (!menu) return;
  menu.classList.add("closing");
  setTimeout(() => menu.remove(), 140);
  $("permit-toggle")?.setAttribute("aria-expanded", "false");
  if (refocus) $("permit-toggle")?.focus();
}

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".permit-picker")) closePermitMenu();
});

async function choosePermit(code) {
  closePermitMenu();
  if (code === userPermit) return;
  const previous = userPermit;
  userPermit = code; // update the map right away; undo if saving fails
  applyPermit(allLots);
  buildLotLayers();
  try {
    await api.setPermit(code);
  } catch (err) {
    userPermit = previous;
    applyPermit(allLots);
    buildLotLayers();
    $("map-error").textContent = `Couldn't save your permit: ${err.message}`;
    $("map-error").hidden = false;
  }
}

// ---------- Side list ----------

let listEntries = []; // [{ lot, area, marker, primary }]

function listMeta(lot) {
  const cat = CATEGORIES[lot.category];
  const spaces = lot.spaces?.total ? ` · ${lot.spaces.source === "uci" ? "" : "≈"}${fmt(lot.spaces.total)} spaces` : "";
  if (lot.category === "staff") return `Faculty & staff${lot.pay.length ? " · also paid for visitors" : ""}${spaces}`;
  if (lot.category === "mine") return coveredLabel(lot);
  if (lot.home) return `${assignedArea(userPermit).title} · not valid right now`;
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

function listItem({ lot, primary: layer }, walkMeters) {
  const btn = el("button", "spot-item");
  btn.type = "button";
  const swatch = el("i", "swatch");
  swatch.style.background = CATEGORIES[lot.category].color;
  const text = el("span", "spot-text");
  const meta = walkMeters == null ? listMeta(lot) : `${walkLabel(walkMeters)} · ${CATEGORIES[lot.category].label}`;
  text.append(el("span", null, lot.name), el("small", null, meta));
  const rating = ratingLabel("lot", lot.id);
  if (rating) text.append(el("small", "rating-line", rating));
  const open = openNow(lot);
  if (open && (lot.baseCategory ?? lot.category) !== "limited") {
    text.append(el("small", "open-line", `~${fmt(open.open)} open now (typical)`));
  }
  if (lot.spaces?.accessible != null && !lot.spaces.accessible_is_minimum) {
    text.append(el("small", "a11y-line", `♿ ${fmt(lot.spaces.accessible)} accessible`));
  }
  btn.append(swatch, text);
  btn.addEventListener("click", () => focusLot({ lot, primary: layer }));
  const li = el("li");
  li.className = "savable-row";
  li.append(btn, saveButton("lot", lot.id, lot.name, true));
  if (walkMeters != null) {
    const actions = el("div", "item-actions");
    const go = el("button", "pill-button primary", "Directions");
    go.type = "button";
    go.setAttribute("aria-label", `Directions via ${lot.name}`);
    go.addEventListener("click", () => startDirections(lot));
    const reviews = el("button", "pill-button", "Reviews");
    reviews.type = "button";
    reviews.setAttribute("aria-label", `Reviews of ${lot.name}`);
    reviews.addEventListener("click", () => showLotReviews(lot));
    actions.append(go, reviews);
    li.append(actions);
  }
  return li;
}

function placeItem(place) {
  const btn = el("button", "spot-item place-item");
  btn.type = "button";
  btn.innerHTML = PLACE_ICON;
  const text = el("span", "spot-text");
  text.append(el("span", null, place.name), el("small", null, place.kind ? `${place.kind} · show nearby parking` : "Show nearby parking"));
  const rating = ratingLabel("place", place.id);
  if (rating) text.append(el("small", "rating-line", rating));
  btn.append(text);
  btn.addEventListener("click", () => setDestination(place));
  const li = el("li");
  li.className = "savable-row";
  li.append(btn, saveButton("place", place.id, place.name, true));
  return li;
}

const sectionHeading = (text) => el("li", "list-heading", text);

// Shown above the closest lots once a destination is picked, inviting a look at its reviews.
function placeCard(place) {
  const li = el("li", "place-card");
  li.append(el("strong", null, place.name));
  li.append(saveButton("place", place.id, place.name));
  if (place.kind) li.append(el("small", null, place.kind));
  const rating = ratingLabel("place", place.id);
  li.append(el("p", "rating-line", rating ?? "No reviews yet"));
  const btn = el("button", "pill-button", rating ? "See reviews" : "Be the first to review");
  btn.type = "button";
  btn.addEventListener("click", () => showPlaceReviews(place));
  li.append(btn);
  return li;
}

function showLotReviews(lot) {
  openReviews({ type: "lot", id: lot.id, name: lot.name, kind: CATEGORIES[lot.category].label });
}

function showPlaceReviews(place) {
  openReviews({ type: "place", id: place.id, name: place.name, kind: place.kind });
}

function listTitle(cats, minStars) {
  const names = CATEGORY_ORDER.filter((c) => cats.has(c)).map((c) => FILTER_NAMES[c]);
  const what = names.length ? `${names.join(" & ")} parking` : "Parking";
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
  return minStars ? `${title} rated ${minStars}+ ★` : `${title} near UCI`;
}

// Rebuilds the side list. With `animate`, items cascade in (used for chip clicks,
// picking a destination, first load; not on every keystroke).
function renderList({ animate = false } = {}) {
  if (!animate) $("spot-list").classList.remove("enter");
  buildList();
  if (animate) animateList();
}

function animateList() {
  const list = $("spot-list");
  [...list.children].slice(0, 14).forEach((li, i) => li.style.setProperty("--i", i));
  list.classList.remove("enter");
  void list.offsetWidth; // restart the animation
  list.classList.add("enter");
}

function buildList() {
  const { categories: cats, minStars, text } = activeFilters();
  updateSavedButton();

  if (savedView && !destination) {
    const items = (mapHistory?.saved() ?? []).map((item) => {
      if (item.type === "place") {
        const place = places.find((candidate) => candidate.id === item.id);
        return place ? placeItem(place) : null;
      }
      const entry = listEntries.find((candidate) => candidate.lot.id === item.id);
      return entry ? listItem(entry) : null;
    }).filter(Boolean);
    $("panel-title").textContent = "Saved places";
    $("spot-count").textContent = `${items.length} saved ${items.length === 1 ? "place" : "places"}`;
    $("spot-list").replaceChildren(...(items.length ? items : [el("li", "no-results", "Use ☆ beside a place or parking lot to save it here.")]));
    return;
  }

  if (destination) {
    $("panel-title").textContent = `Parking near ${destination.name}`;
    const usable = nearest.filter(({ entry }) => entry.lot.category !== "limited");
    const risky = nearest.filter(({ entry }) => entry.lot.category === "limited");
    const filtered = cats.size || minStars;
    $("spot-count").textContent = filtered ? `Closest ${listTitle(cats, minStars).toLowerCase().replace(" near uci", "")}` : "Closest lots by walking distance";
    const items = [placeCard(destination)];
    if (usable.length) items.push(sectionHeading("Closest parking"), ...usable.map(({ entry, meters }) => listItem(entry, meters)));
    if (risky.length) items.push(sectionHeading(usable.length ? "Also nearby: may be towed" : "Closest (may be towed)"), ...risky.map(({ entry, meters }) => listItem(entry, meters)));
    if (!usable.length && !risky.length) items.push(el("li", "no-results", "No nearby lots match these filters."));
    $("spot-list").replaceChildren(...items);
    return;
  }

  const lots = filteredEntries;
  $("panel-title").textContent = text ? "Search results" : listTitle(cats, minStars);
  const parts = [];
  if (placeResults.length) parts.push(`${placeResults.length} ${placeResults.length === 1 ? "place" : "places"}`);
  parts.push(`${lots.length} ${lots.length === 1 ? "lot" : "lots"}`);
  $("spot-count").textContent = text ? `${parts.join(" and ")} for “${text}”` : parts.join(" and ");
  const items = [];
  if (placeResults.length) items.push(sectionHeading("Places: pick one to see the closest parking"), ...placeResults.map(placeItem));
  if (lots.length) items.push(...(placeResults.length ? [sectionHeading("Parking lots")] : []), ...lots.map((e) => listItem(e)));
  if (!items.length) {
    const hint = minStars ? "No rated lots match yet. Try a lower rating." : "Nothing matches. Try a shorter or different word.";
    items.push(el("li", "no-results", hint));
  }
  $("spot-list").replaceChildren(...items);
}

$("saved-toggle").addEventListener("click", () => {
  const opening = !savedView;
  clearSearch();
  savedView = opening;
  $("search-shortcuts").hidden = true;
  renderList();
});

// ---------- Search: bold matching lots, fade the rest, as you type ----------

let filteredEntries = []; // lots passing the current filters (all lots when none are on)
let placeResults = []; // buildings/places matching the search
let places = []; // searchable destinations, from /api/places
let destination = null; // the chosen place, once picked
let nearest = []; // [{ entry, meters }] closest lots to the destination
let destinationMarker = null;
let fitTimer = null;
const NEAREST_LOTS = 6;
const NEAREST_RISKY = 2;
const MAX_PLACE_RESULTS = 6;

// Chips under the search box. Words typed in the search box can switch these on too.
const chipFilters = { categories: new Set(), minStars: 0 };
const FILTER_NAMES = { free: "free", permit: "permit", paid: "paid", limited: "limited", staff: "faculty & staff" };
const CATEGORY_WORDS = {
  free: "free", paid: "paid", pay: "paid", meter: "paid", metered: "paid", fee: "paid",
  permit: "permit", permits: "permit", uci: "permit",
  limited: "limited", tow: "limited", towing: "limited", private: "limited", customers: "limited",
  staff: "staff", faculty: "staff", employee: "staff", employees: "staff",
};
// Only dropped when a category or rating word is typed, so "parking" alone still matches names.
const FILLER_WORDS = new Set(["parking", "park", "lot", "lots", "spot", "spots", "space", "spaces", "near", "with", "and", "or", "rated", "rating", "only"]);

let parsedQuery = { tokens: [], categories: new Set(), minStars: 0, text: "" };

// "free parking", "paid lots", "4+ stars", "permit 4 stars mesa" -> categories, rating, words.
function parseQuery(raw) {
  let rest = raw.toLowerCase();
  let minStars = 0;
  const stars = rest.match(/(\d(?:\.\d)?)\s*\+?\s*(?:stars?|★)/);
  if (stars) {
    minStars = Math.min(5, Math.max(1, Number(stars[1])));
    rest = rest.replace(stars[0], " ");
  }
  let tokens = normalize(rest).split(" ").filter(Boolean);
  const categories = new Set(tokens.filter((t) => CATEGORY_WORDS[t]).map((t) => CATEGORY_WORDS[t]));
  if (categories.size || minStars) {
    tokens = tokens.filter((t) => !CATEGORY_WORDS[t] && !FILLER_WORDS.has(t));
  }
  return { tokens, categories, minStars, text: raw.trim() };
}

// Chips and typed words combined.
function activeFilters() {
  return {
    categories: new Set([...chipFilters.categories, ...parsedQuery.categories]),
    minStars: Math.max(chipFilters.minStars, parsedQuery.minStars),
    tokens: parsedQuery.tokens,
    text: parsedQuery.text,
  };
}

// Which filter chips a lot belongs to: its own type, plus "free" when your permit covers it now.
// (So a staff lot that's free for you still shows under Staff.)
function lotTypes(lot) {
  const own = lot.baseCategory ?? lot.category;
  const types = [own];
  if (lot.pay.length && own !== "paid") types.push("paid"); // e.g. staff lots visitors can pay at
  if (lot.category === "mine" && !isPaidLot(lot)) types.push("free"); // a pay lot your permit covers isn't free parking
  return types;
}

function passes(lot, { categories, minStars, tokens }, { ignoreText = false } = {}) {
  if (categories.size && !lotTypes(lot).some((t) => categories.has(t))) return false;
  if (minStars && !((averageRating("lot", lot.id) ?? 0) >= minStars)) return false;
  return ignoreText || tokens.every((t) => searchableText(lot).includes(t));
}

// After a chip removes typed filter words, drop leftovers like "parking" or "lots" too.
function setSearchText(text) {
  let value = text.replace(/\s+/g, " ").trim();
  if (normalize(value).split(" ").filter(Boolean).every((t) => FILLER_WORDS.has(t))) value = "";
  $("search").value = value;
  $("search-clear").hidden = !value;
  parsedQuery = parseQuery(value);
}

function syncChips() {
  document.querySelectorAll(".chip-toggle[data-category]").forEach((chip) => {
    const c = chip.dataset.category;
    const byChip = chipFilters.categories.has(c);
    const byText = parsedQuery.categories.has(c);
    chip.setAttribute("aria-pressed", String(byChip || byText));
    chip.classList.toggle("implied", byText && !byChip); // switched on by typing
  });
  const stars = Math.max(chipFilters.minStars, parsedQuery.minStars);
  document.querySelectorAll(".star-chip").forEach((chip) => {
    const on = Number(chip.dataset.stars) === stars;
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("implied", on && parsedQuery.minStars > chipFilters.minStars);
  });
}

const PLACE_ICON =
  '<svg class="place-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/></svg>';

// Lowercase, no accents or punctuation, so "trader joes" finds "Trader Joe's".
const normalize = (text) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "") // apostrophes vanish: "Joe's" -> "joes"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const searchIndex = new Map(); // lot id -> normalized name + the places it serves
const searchableText = (lot) => {
  if (!searchIndex.has(lot.id)) searchIndex.set(lot.id, normalize([lot.name, ...lot.serves].join(" ")));
  return searchIndex.get(lot.id);
};

// ---------- Shared red dots: one per area of limited lots ----------
//
// The backend groups limited lots within ~95 m (lot.dot_group). Each lot keeps its own
// shaded outline; the group gets one dot in the middle. Clicking it opens the lot, or
// a short list to choose from when the dot covers several.

let dotGroups = []; // [{ entries, marker }]

function groupDots() {
  const byGroup = new Map();
  for (const entry of listEntries) {
    if (entry.lot.category !== "limited" || !entry.lot.dot_group || !entry.area) continue;
    if (!byGroup.has(entry.lot.dot_group)) byGroup.set(entry.lot.dot_group, []);
    byGroup.get(entry.lot.dot_group).push(entry);
  }
  dotGroups = [...byGroup.values()].map((entries) => {
    const lat = entries.reduce((sum, e) => sum + e.lot.lat, 0) / entries.length;
    const lon = entries.reduce((sum, e) => sum + e.lot.lon, 0) / entries.length;
    const marker = dot({ category: "limited", lat, lon }).addTo(map);
    const group = { entries, marker };
    for (const entry of entries) entry.dotGroup = group;
    marker.on("click", () => {
      if (entries.length === 1) entries[0].area.openPopup([entries[0].lot.lat, entries[0].lot.lon]);
      else L.popup(POPUP_OPTIONS).setLatLng([lat, lon]).setContent(groupPopup(entries)).openOn(map);
    });
    return group;
  });
}

function groupPopup(entries) {
  const root = el("div", "popup");
  if (entries.every((e) => e.lot.utc)) {
    root.append(el("strong", null, `University Town Center · ${entries.length} lots`));
    root.append(el("p", null, "Shopper parking, mostly 2 hours max; students parking here to walk to campus have been towed. Pick a lot for details:"));
  } else {
    root.append(el("strong", null, `${entries.length} limited-parking areas here`));
    root.append(el("p", null, "Each may be ticketed or towed if you're not visiting what it serves. Pick one for details:"));
  }
  const list = el("div", "building-confirm-list");
  for (const entry of entries) {
    const btn = el("button", "chip-link", entry.lot.name);
    btn.type = "button";
    btn.title = entry.lot.restriction ?? "";
    btn.addEventListener("click", () => {
      map.closePopup();
      entry.area.openPopup([entry.lot.lat, entry.lot.lon]);
    });
    list.append(btn);
  }
  root.append(list);
  return root;
}

// A shared dot looks like its liveliest lot: highlighted if any match, faded if all are.
function refreshGroupDot(group) {
  const states = group.entries.map((e) => e.state ?? "normal");
  const state = states.includes("match") ? "match" : states.every((s) => s === "dim") ? "dim" : "normal";
  const faded = state === "dim" ? 0.2 : 1;
  group.marker.setStyle({ opacity: faded, fillOpacity: faded }).setRadius(state === "match" ? 8 : 6);
  if (state === "match") group.marker.bringToFront();
}

function setLotState(entry, state) {
  entry.state = state;
  if (entry.dotGroup) refreshGroupDot(entry.dotGroup);
  const { lot, area, marker } = entry;
  const cat = CATEGORIES[lot.category];
  const weight = homeEdge(lot)?.weight ?? cat.weight ?? 1.5;
  const styles = {
    normal: { weight, opacity: 1, fillOpacity: cat.fillOpacity },
    match: { weight: weight + 2.5, opacity: 1, fillOpacity: Math.min(cat.fillOpacity + 0.3, 0.85) },
    dim: { weight: 1, opacity: 0.15, fillOpacity: cat.fillOpacity * 0.15 },
  };
  if (area) {
    area.setStyle(styles[state]);
    if (state === "match") area.bringToFront();
  }
  if (!marker) return;
  if (marker instanceof L.CircleMarker) {
    const faded = state === "dim" ? 0.2 : 1;
    marker.setStyle({ opacity: faded, fillOpacity: faded }).setRadius((state === "match" ? 8 : 6) + (lot.home ? 1 : 0));
    if (state === "match") marker.bringToFront();
  } else {
    marker.setOpacity(state === "dim" ? 0.2 : 1);
    marker.setZIndexOffset(state === "match" ? 1000 : 500);
    marker.getElement()?.classList.toggle("match", state === "match");
  }
}

function fitToResults(entries, extraPoint) {
  if (!entries.length && !extraPoint) return;
  const bounds = L.latLngBounds([]);
  if (extraPoint) bounds.extend(L.latLng(extraPoint.lat, extraPoint.lon));
  for (const { lot, area } of entries) {
    bounds.extend(area ? area.getBounds() : L.latLng(lot.lat, lot.lon));
  }
  fitBoundsAroundPanel(bounds, 17);
}

function fitBoundsAroundPanel(bounds, maxZoom) {
  // Keep what we're showing clear of the side panel (or bottom sheet) and the key.
  const panel = $("panel");
  const key = $("map-key");
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  const panelOpen = !panel.classList.contains("collapsed");
  const rect = panel.getBoundingClientRect();
  const keyRect = key.getBoundingClientRect();
  const keyBottom = !mobile && !key.classList.contains("collapsed") ? keyRect.height + 40 : 48;
  map.flyToBounds(bounds, {
    paddingTopLeft: [!mobile && panelOpen ? rect.right + 32 : 32, mobile ? keyRect.bottom + 16 : 48],
    paddingBottomRight: [48, mobile && panelOpen ? window.innerHeight - rect.top + 32 : keyBottom],
    maxZoom,
    duration: 0.5,
  });
}

function findPlaces(tokens, minStars) {
  const query = tokens.join(" ");
  return places
    .filter((place) => tokens.every((t) => place.search.includes(t)))
    .filter((place) => !minStars || (averageRating("place", place.id) ?? 0) >= minStars)
    .sort((a, b) => (b.search.startsWith(query) - a.search.startsWith(query)) || a.name.length - b.name.length)
    .slice(0, MAX_PLACE_RESULTS);
}

function focusLot({ lot, primary: layer }) {
  clearTimeout(fitTimer);
  rememberTarget("lot", lot.id);
  savedView = false;
  $("search-shortcuts").hidden = true;
  renderList();
  if (window.matchMedia("(max-width: 640px)").matches) setPanelExpanded(false);
  map.stop();
  map.closePopup();
  nextParkingPopupZoom = 18;
  layer.fire("click", { latlng: L.latLng(lot.lat, lot.lon) });
}

function renderRecentShortcuts(showOnFocus = false) {
  const box = $("search-shortcuts");
  if (!mapHistory || document.activeElement !== $("search") || (!showOnFocus && $("search").value.trim())) {
    box.hidden = true;
    return;
  }
  const targets = mapHistory.recent().map((item) => {
    const target = item.type === "place"
      ? places.find((place) => place.id === item.id)
      : listEntries.find((entry) => entry.lot.id === item.id);
    return target ? { type: item.type, target } : null;
  }).filter(Boolean);
  if (!targets.length) { box.hidden = true; return; }
  const title = el("strong", null, "Recent searches");
  const buttons = targets.map(({ type, target }) => {
    const name = type === "place" ? target.name : target.lot.name;
    const button = el("button", null, name);
    button.type = "button";
    button.addEventListener("click", () => {
      box.hidden = true;
      if (type === "place") setDestination(target);
      else focusLot(target);
    });
    return button;
  });
  box.replaceChildren(title, ...buttons);
  box.hidden = false;
}

// Re-applies search text + chips: highlights matching lots, fades the rest, refreshes the list.
function applyFilters({ fit = true, animate = false } = {}) {
  clearTimeout(fitTimer);
  syncChips();
  if (destination) {
    rankNearest();
    renderList({ animate });
    if (fit) fitToResults(nearest.map(({ entry }) => entry), destination);
    return;
  }
  const filters = activeFilters();
  const active = filters.categories.size || filters.minStars || filters.tokens.length;
  placeResults = filters.tokens.length ? findPlaces(filters.tokens, filters.minStars) : [];
  filteredEntries = listEntries.filter(({ lot }) => passes(lot, filters));
  const matched = new Set(filteredEntries);
  listEntries.forEach((entry) => setLotState(entry, !active ? "normal" : matched.has(entry) ? "match" : "dim"));
  renderList({ animate });
  // Move the map once typing pauses, so it doesn't jump on every letter.
  if (fit && active && filteredEntries.length) fitTimer = setTimeout(() => fitToResults(filteredEntries), 350);
}

function runSearch() {
  const raw = $("search").value;
  $("search-clear").hidden = !raw;
  if (raw.trim()) savedView = false;
  renderRecentShortcuts();
  clearDestination(); // typing again means looking for something new
  parsedQuery = parseQuery(raw);
  applyFilters();
}

document.querySelectorAll(".chip-toggle[data-category]").forEach((chip) =>
  chip.addEventListener("click", () => {
    savedView = false;
    const c = chip.dataset.category;
    if (parsedQuery.categories.has(c) && !chipFilters.categories.has(c)) {
      // Turning off a filter that came from the search text: remove those words.
      const words = Object.keys(CATEGORY_WORDS).filter((w) => CATEGORY_WORDS[w] === c).join("|");
      setSearchText($("search").value.replace(new RegExp(`\\b(${words})\\b`, "gi"), ""));
    } else if (chipFilters.categories.has(c)) chipFilters.categories.delete(c);
    else chipFilters.categories.add(c);
    applyFilters({ animate: true });
  }),
);
document.querySelectorAll(".star-chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    savedView = false;
    const value = Number(chip.dataset.stars);
    const current = Math.max(chipFilters.minStars, parsedQuery.minStars);
    // Clicking the rating that's already on turns it off, like the type chips.
    chipFilters.minStars = value === current ? 0 : value;
    if (parsedQuery.minStars) {
      setSearchText($("search").value.replace(/(\d(?:\.\d)?)\s*\+?\s*(?:stars?|★)/i, ""));
    }
    applyFilters({ animate: true });
  }),
);

function clearSearch() {
  $("search").value = "";
  if (!$("directions-view").hidden) closeDirections();
  runSearch();
}

// ---------- Destination: a building or place, and the lots closest to it ----------

function meters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

const formatDistance = (m) => (m < 160 ? `${Math.max(50, Math.round((m * 3.281) / 50) * 50)} ft` : `${(m / 1609.34).toFixed(1)} mi`);
const formatDuration = (s) => {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
// Paths aren't straight lines: assume ~25% detour at a ~5 km/h walk.
const walkLabel = (straightMeters) => `~${formatDuration((straightMeters * 1.25) / 1.4)} walk · ${formatDistance(straightMeters)}`;

const destinationIcon = L.divIcon({
  className: "destination-pin",
  html: '<svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><path d="M16 1C8 1 1.5 7.3 1.5 15.2 1.5 26 16 39 16 39s14.5-13 14.5-23.8C30.5 7.3 24 1 16 1Z"/><path class="flag" d="M12 9v14M12 9.5h8.5l-2 3 2 3H12"/></svg>',
  iconSize: [32, 40],
  iconAnchor: [16, 39],
  tooltipAnchor: [0, -36],
});

function setDestination(place, { remember = true } = {}) {
  clearTimeout(fitTimer);
  savedView = false;
  destination = place;
  placeResults = [];
  $("search").value = place.name;
  $("search-clear").hidden = false;
  $("search-shortcuts").hidden = true;
  if (remember) rememberTarget("place", place.id);

  showDestinationMarker(place);

  parsedQuery = parseQuery(""); // the box now names the destination, not a filter
  applyFilters({ animate: true });
}

// Closest lots to the destination among those passing the chips: usable lots first,
// then a couple of nearby tow-risk lots, flagged (or only those, if that's the filter).
function rankNearest() {
  const filters = activeFilters();
  const ranked = listEntries
    .filter(({ lot }) => passes(lot, filters, { ignoreText: true }))
    .map((entry) => ({ entry, meters: meters(destination, entry.lot) }))
    .sort((a, b) => a.meters - b.meters);
  const usable = ranked.filter(({ entry }) => entry.lot.category !== "limited").slice(0, NEAREST_LOTS);
  const farthest = usable.length ? usable.at(-1).meters : Infinity;
  const risky = ranked
    .filter(({ entry, meters }) => entry.lot.category === "limited" && meters < farthest)
    .slice(0, usable.length ? NEAREST_RISKY : NEAREST_LOTS);
  nearest = [...usable, ...risky];
  const close = new Set(nearest.map(({ entry }) => entry));
  listEntries.forEach((entry) => setLotState(entry, close.has(entry) ? "match" : "dim"));
}

function showDestinationMarker(place) {
  destinationMarker?.remove();
  destinationMarker = L.marker([place.lat, place.lon], { icon: destinationIcon, zIndexOffset: 2000, keyboard: false })
    .bindTooltip(place.name, { direction: "top", permanent: true, className: "destination-label" })
    .on("click", () => showPlaceReviews(place))
    .addTo(map);
}

// ---------- Click a building to make it the destination ----------
//
// Places carry their footprint (or the footprint of the building they're in). Clicking
// inside one asks to confirm, then does exactly what picking it in the search does.

function insideRing([lat, lon], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [y1, x1] = ring[i];
    const [y2, x2] = ring[j];
    if (y1 > lat !== y2 > lat && lon < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) hit = !hit;
  }
  return hit;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][1] * ring[i][0] - ring[i][1] * ring[j][0];
  return Math.abs(sum / 2);
}

// Places under a point, sharing the smallest footprint there: the building itself first,
// then whatever's mapped inside it (a cafe, an office).
function placesAt(latlng) {
  const point = [latlng.lat, latlng.lng];
  const hits = [];
  for (const place of places) {
    const ring = place.outline?.find((r) => insideRing(point, r));
    if (ring) hits.push({ place, ring, area: ringArea(ring) });
  }
  if (!hits.length) return null;
  const smallest = Math.min(...hits.map((h) => h.area));
  const here = hits.filter((h) => h.area <= smallest * 1.0001);
  here.sort((a, b) => (a.place.id.startsWith("node/") - b.place.id.startsWith("node/")) || a.place.name.localeCompare(b.place.name));
  return { ring: here[0].ring, places: [...new Map(here.map((h) => [h.place.name, h.place])).values()] };
}

let buildingHighlight = null;

function confirmBuilding(latlng) {
  const found = placesAt(latlng);
  if (!found) return;
  const [main, ...inside] = found.places;
  buildingHighlight?.remove();
  buildingHighlight = L.polygon(found.ring, {
    color: "#2f55c4", weight: 2.5, dashArray: "5 4", fillColor: "#2f55c4", fillOpacity: 0.15, interactive: false,
  }).addTo(map);

  const root = el("div", "popup building-confirm");
  root.append(el("small", "building-confirm-ask", "Navigate here?"), el("strong", null, main.name));
  if (main.kind) root.append(el("p", null, main.kind));
  const choose = (place) => {
    map.closePopup();
    setDestination(place);
  };
  const actions = el("div", "popup-actions");
  const yes = el("button", "pill-button primary", "Yes, find parking");
  yes.type = "button";
  yes.addEventListener("click", () => choose(main));
  const no = el("button", "pill-button", "Cancel");
  no.type = "button";
  no.addEventListener("click", () => map.closePopup());
  actions.append(yes, no);
  root.append(actions);
  if (inside.length) {
    root.append(el("p", "building-confirm-also", "Or something inside:"));
    const list = el("div", "building-confirm-list");
    for (const place of inside) {
      const btn = el("button", "chip-link", place.name);
      btn.type = "button";
      btn.addEventListener("click", () => choose(place));
      list.append(btn);
    }
    root.append(list);
  }
  L.popup({ maxWidth: 260, className: "building-popup" })
    .setLatLng(latlng)
    .setContent(root)
    .on("remove", () => {
      buildingHighlight?.remove();
      buildingHighlight = null;
    })
    .openOn(map);
  yes.focus({ preventScroll: true });
}

// Lot shapes and markers handle their own clicks; this only sees clicks on the basemap.
map.on("click", (e) => {
  if (pendingPick) return; // the trip planner is waiting for a point
  confirmBuilding(e.latlng);
});

function clearDestination() {
  if (!destination) return;
  destination = null;
  nearest = [];
  destinationMarker?.remove();
  destinationMarker = null;
}

$("search").addEventListener("input", runSearch);
$("search").addEventListener("focus", () => renderRecentShortcuts(true));
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".search")) $("search-shortcuts").hidden = true;
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("search-shortcuts").hidden) $("search-shortcuts").hidden = true;
    else clearSearch();
  }
  if (e.key === "Enter" && placeResults.length) setDestination(placeResults[0]);
  else if (e.key === "Enter" && $("search").value.trim() && filteredEntries.length) focusLot(filteredEntries[0]);
});
$("search-clear").addEventListener("click", () => {
  clearSearch();
  $("search").focus();
});
// "/" jumps to search from anywhere on the page (opening the panel if it's pushed in).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.target.closest("input, textarea")) return;
  e.preventDefault();
  if ($("panel").classList.contains("collapsed")) $("panel-toggle").click();
  $("search").focus();
});

let allLots = [];

function renderLots(lots) {
  allLots = lots;
  applyPermit(allLots);
  buildLotLayers();
  if (lots.length) fitToLots(lots);
}

// (Re)draws every lot. Called at start, and when your permit's coverage changes
// (new permit, or the clock passing 7 am / 3 pm / 5 pm / midnight).
function buildLotLayers({ animate = true } = {}) {
  for (const { area, marker } of listEntries) {
    area?.remove();
    marker?.remove();
  }
  for (const group of dotGroups) group.marker.remove();
  const lots = [...allLots].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  listEntries = lots.map((lot) => ({ lot, ...addLot(lot) }));
  groupDots();
  for (const chip of document.querySelectorAll(".chip-toggle[data-category]")) {
    const c = chip.dataset.category;
    const count = lots.filter((lot) => lotTypes(lot).includes(c)).length;
    chip.querySelector(".count").textContent = count;
    chip.querySelector(".swatch").style.background = CATEGORIES[c].color;
  }
  renderKey();
  renderPermitBanner();
  applyFilters({ fit: false, animate });
}

// Permit hours change during the day: re-check every minute, redraw only on change.
setInterval(() => {
  if (!allLots.length) return;
  if (userPermit && applyPermit(allLots)) buildLotLayers({ animate: false });
  else renderList(); // keep "open now" in step with the clock
}, 60_000);

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

function setupCollapsible({ container, toggle, storageKey, labels, defaultCollapsed = false }) {
  const apply = (collapsed) => {
    container.classList.toggle("collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    if (labels) toggle.setAttribute("aria-label", collapsed ? labels.show : labels.hide);
  };
  apply(container.id === "panel" && window.matchMedia("(max-width: 640px)").matches
    ? false : loadFlag(storageKey, defaultCollapsed));
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
setupCollapsible({
  container: $("map-key"), toggle: $("key-toggle"),
  storageKey: window.matchMedia("(max-width: 640px)").matches ? "pp_mobile_key_collapsed" : "pp_key_collapsed",
  defaultCollapsed: window.matchMedia("(max-width: 640px)").matches,
});

// Four mobile snap points, including a handle-only position to reveal the map.
const panelHandle = $("panel-handle");
const panel = $("panel");
const sheetLevels = [0, 0.42, 0.7, 1];
const sheetNames = ["Minimized", "Preview", "Medium height", "Full height"];
let sheetLevel = 1;
function setPanelLevel(level) {
  sheetLevel = Math.max(0, Math.min(sheetLevels.length - 1, level));
  panel.dataset.level = String(sheetLevel);
  panel.classList.toggle("compact-filters", sheetLevel >= 2 || $("spot-list").scrollTop > 8);
  panel.classList.toggle("expanded", sheetLevel === 3);
  panel.style.removeProperty("--sheet-height");
  panel.querySelector(".panel-body").inert = sheetLevel === 0 && window.matchMedia("(max-width: 640px)").matches;
  panelHandle.setAttribute("aria-valuenow", String(sheetLevel + 1));
  panelHandle.setAttribute("aria-valuetext", sheetNames[sheetLevel]);
}
function setPanelExpanded(expanded) {
  setPanelLevel(expanded ? 3 : 1);
}
panelHandle.addEventListener("keydown", (event) => {
  const levels = { ArrowUp: sheetLevel + 1, ArrowDown: sheetLevel - 1, Home: 0, End: 3 };
  if (!(event.key in levels)) return;
  event.preventDefault();
  setPanelLevel(levels[event.key]);
});
let sheetDrag = null;
panelHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !window.matchMedia("(max-width: 640px)").matches) return;
  sheetDrag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height,
    available: panel.parentElement.clientHeight, level: sheetLevel };
  panelHandle.setPointerCapture(event.pointerId);
});
panelHandle.addEventListener("pointermove", (event) => {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const fraction = (sheetDrag.height + sheetDrag.y - event.clientY) / sheetDrag.available;
  sheetDrag.fraction = Math.max(sheetLevels[0], Math.min(1, fraction));
  // Keep the handle reachable while dragging toward the full-screen snap point.
  panel.classList.add("dragging");
  panel.classList.remove("expanded");
  panel.style.setProperty("--sheet-height", `${Math.min(0.92, sheetDrag.fraction) * 100}%`);
});
function finishSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.id) return;
  const drag = sheetDrag;
  sheetDrag = null;
  panel.classList.remove("dragging");
  const fraction = event.type === "pointercancel" ? sheetLevels[drag.level]
    : drag.fraction ?? sheetLevels[drag.level];
  const nearest = sheetLevels.reduce((best, point, index) =>
    Math.abs(point - fraction) < Math.abs(sheetLevels[best] - fraction) ? index : best, 0);
  setPanelLevel(nearest);
  if (panelHandle.hasPointerCapture(event.pointerId)) panelHandle.releasePointerCapture(event.pointerId);
}
panelHandle.addEventListener("pointerup", finishSheetDrag);
panelHandle.addEventListener("pointercancel", finishSheetDrag);
panelHandle.addEventListener("lostpointercapture", finishSheetDrag);
setPanelLevel(1);
panel.addEventListener("focusin", (event) => {
  if (!window.matchMedia("(max-width: 640px)").matches || !event.target.matches("input, textarea")) return;
  setPanelLevel(3);
});
window.matchMedia("(max-width: 640px)").addEventListener("change", (event) => {
  if (event.matches && panel.classList.contains("collapsed")) $("panel-toggle").click();
  setPanelLevel(sheetLevel);
});

function renderKey() {
  $("key-list").replaceChildren(
    ...Object.entries(CATEGORIES).filter(([key]) => key !== "mine" || userPermit).map(([, cat]) => {
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
  const area = assignedArea(userPermit);
  if (area) {
    const li = document.createElement("li");
    const swatch = document.createElement("i");
    swatch.className = "key-swatch home";
    const label = document.createElement("span");
    label.textContent = `${area.title} (outlined)`;
    li.append(swatch, label);
    $("key-list").append(li);
  }
}
renderKey();

// ---------- Your live location ----------

const FRESH_FIX_MS = 60_000; // a fix this recent is good enough to route from
let here = null; // { lat, lon, accuracy, time }
let watchId = null;
let recenterOnFix = false;
const hereLayer = L.layerGroup().addTo(map);
const hereIcon = L.divIcon({ className: "you-dot", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 9] });
let hereMarker = null;
let hereAccuracy = null;

const LocateControl = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const btn = L.DomUtil.create("button", "locate-button");
    btn.type = "button";
    btn.id = "locate";
    btn.title = "Show my location";
    btn.setAttribute("aria-label", "Show my location");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>';
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, "click", () => watchLocation({ recenter: true }));
    return btn;
  },
});
new LocateControl().addTo(map);

function setLocateState(state, message) {
  const btn = $("locate");
  btn.dataset.state = state; // off | locating | on | error
  btn.title = message ?? (state === "on" ? "Centre on my location" : "Show my location");
}

function onPosition(pos) {
  here = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, time: Date.now() };
  const latlng = [here.lat, here.lon];
  if (!hereMarker) {
    hereAccuracy = L.circle(latlng, { radius: here.accuracy, color: "#2f55c4", weight: 1, opacity: 0.4, fillOpacity: 0.12, interactive: false });
    hereMarker = L.marker(latlng, { icon: hereIcon, zIndexOffset: 3000, keyboard: false, title: "You are here" })
      .bindTooltip("You", { direction: "top", offset: [0, -8], className: "destination-label" });
    hereLayer.addLayer(hereAccuracy).addLayer(hereMarker);
  } else {
    hereMarker.setLatLng(latlng);
    hereAccuracy.setLatLng(latlng).setRadius(here.accuracy);
  }
  setLocateState("on");
  if (recenterOnFix) {
    recenterOnFix = false;
    map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 0.6 });
  }
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    stopWatching();
    setLocateState("error", "Location access is turned off in your browser");
  } else if (!here) {
    setLocateState("error", "Your location isn't available right now");
  }
}

function stopWatching() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// Start following your location (the browser asks the first time). With
// `recenter`, the map moves to you once there's a fix.
function watchLocation({ recenter = false } = {}) {
  if (!navigator.geolocation) {
    setLocateState("error", "Your browser can't share your location");
    return;
  }
  if (recenter && here) map.flyTo([here.lat, here.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
  else recenterOnFix = recenter;
  if (watchId !== null) return;
  setLocateState("locating");
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 10_000,
    timeout: 20_000,
  });
}

// If you've already allowed location for this site, show it without asking again.
navigator.permissions
  ?.query({ name: "geolocation" })
  .then((status) => {
    if (status.state === "granted") watchLocation();
  })
  .catch(() => {});

// ---------- Directions: drive to a lot, then walk to the destination ----------

const routeLayer = L.layerGroup().addTo(map);
let directionsRun = 0; // bumps on every new request so stale answers are ignored

const PANEL_VIEWS = ["list-view", "directions-view", "reviews-view"];

function showPanelView(name) {
  for (const view of PANEL_VIEWS) $(view).hidden = view !== name;
  document.querySelector(".filters").hidden = name !== "list-view"; // filters only apply to the list
  if ($("panel").classList.contains("collapsed")) $("panel-toggle").click();
  if (window.matchMedia("(max-width: 640px)").matches) {
    if (name !== "list-view") setPanelLevel(3);
    panel.querySelector(".panel-body").scrollTop = 0;
  }
}

const showDirectionsView = (show) => showPanelView(show ? "directions-view" : "list-view");

function directionsStatus(text, kind) {
  const status = $("directions-status");
  status.textContent = text ?? "";
  status.className = `panel-sub ${kind ?? ""}`;
}

function currentPosition() {
  if (here && Date.now() - here.time < FRESH_FIX_MS) return Promise.resolve(here);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Your browser can't share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onPosition(pos);
        watchLocation(); // keep the dot following you from now on
        resolve(here);
      },
      (err) =>
        reject(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location access was turned off."
              : err.code === err.TIMEOUT
                ? "Finding your location took too long."
                : "Your location isn't available right now.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

function stepList(route, onClick) {
  const list = el("ol", "step-list");
  for (const step of route.steps) {
    const li = el("li");
    const btn = el("button");
    btn.type = "button";
    btn.append(el("span", null, step.instruction));
    if (step.distance >= 5) btn.append(el("small", null, formatDistance(step.distance)));
    btn.addEventListener("click", () => onClick(step));
    li.append(btn);
    list.append(li);
  }
  return list;
}

function routeSection(title, route, kind) {
  const section = el("section", `route-section ${kind}`);
  const head = el("h3");
  head.append(el("span", `route-mark ${kind}`), el("span", null, title));
  section.append(head, el("p", "route-meta", `${formatDuration(route.duration)} · ${formatDistance(route.distance)}`));
  section.append(stepList(route, (step) => map.flyTo([step.lat, step.lon], 18, { duration: 0.5 })));
  return section;
}

// ---------- Trip planner: From -(drive)-> parking lot -(walk)-> To ----------
//
// From and To can each be your live location, a place, a lot, or a pin dropped
// on the map. Change either (type, pick on the map, drag its marker, swap) and
// the route is planned again.

const HERE = { kind: "here", name: "My location" };
const trip = { from: null, to: null, lot: null, lotChosen: false };
const tripLayer = L.layerGroup().addTo(map);
let pendingPick = null; // map-click handler while picking a point
let suggestFor = null; // "from" | "to" while suggestions are open
let suggestions = [];

const placeEndpoint = (place) => ({ kind: "place", name: place.name, lat: place.lat, lon: place.lon, place });
const lotEndpoint = (lot) => ({ kind: "lot", name: lot.name, lat: lot.lat, lon: lot.lon, lot });
const pinEndpoint = ({ lat, lng }) => ({ kind: "pin", name: "Dropped pin", lat, lon: lng });

const startIcon = L.divIcon({ className: "trip-start", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] });

// Directions from the list or a popup: keep your start, go via this lot.
function startDirections(lot) {
  trip.from = trip.from ?? HERE;
  trip.to = destination ? placeEndpoint(destination) : lotEndpoint(lot);
  trip.lot = lot;
  trip.lotChosen = true;
  destinationMarker?.remove(); // the trip's own markers take over
  showDirectionsView(true);
  renderTripFields();
  planTrip();
}

let fromSearching = false; // the From dropdown swapped for a search box

function renderTripFields() {
  // From: a dropdown button showing the current start (or a search box while searching).
  const fromField = document.querySelector(".from-field");
  fromField.classList.toggle("is-here", trip.from?.kind === "here");
  fromField.classList.toggle("searching", fromSearching);
  $("from-label").textContent = trip.from?.name ?? "Choose a starting point";
  $("from-select").hidden = fromSearching;
  $("trip-from").hidden = !fromSearching;
  document.querySelector('.trip-clear[data-end="from"]').hidden = !fromSearching;

  // To: a search box.
  const input = $("trip-to");
  if (document.activeElement !== input) input.value = trip.to?.name ?? "";
  input.closest(".trip-field").classList.toggle("is-here", trip.to?.kind === "here");
  document.querySelector('.trip-clear[data-end="to"]').hidden = !input.value;
}

// ----- The From dropdown -----

const FROM_ICONS = {
  here: '<span class="sugg-icon here"></span>',
  pin: '<svg class="sugg-icon" viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><path d="M9 10h6M12 7v6"/></svg>',
  search: '<svg class="sugg-icon plain" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg>',
  current: '<svg class="sugg-icon" viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/></svg>',
};

function fromMenuItems() {
  const items = [];
  const current = trip.from;
  if (current && current.kind !== "here") {
    items.push({ icon: "current", label: current.name, detail: "Current start", checked: true, pick: () => closeFromMenu() });
  }
  items.push(
    { icon: "here", label: "My location", detail: here ? "Follows you live" : "Uses your device's location", checked: current?.kind === "here", pick: () => setEndpoint("from", HERE) },
    { icon: "pin", label: "Drop a pin on the map", detail: "Click anywhere, then drag it to adjust", pick: () => startPick("from") },
    { icon: "search", label: "Search for a place or lot…", detail: "Buildings, shops, parking", pick: () => startFromSearch() },
  );
  return items;
}

function openFromMenu() {
  const menu = $("from-menu");
  menu.replaceChildren(
    ...fromMenuItems().map((item) => {
      const li = el("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(!!item.checked));
      const btn = el("button", `from-option${item.checked ? " checked" : ""}`);
      btn.type = "button";
      btn.insertAdjacentHTML("beforeend", FROM_ICONS[item.icon]);
      const text = el("span", "spot-text");
      text.append(el("span", null, item.label), el("small", null, item.detail));
      btn.append(text);
      if (item.checked) btn.insertAdjacentHTML("beforeend", '<svg class="check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>');
      btn.addEventListener("click", () => {
        closeFromMenu();
        item.pick();
      });
      li.append(btn);
      return li;
    }),
  );
  menu.hidden = false;
  $("from-select").setAttribute("aria-expanded", "true");
  menu.querySelector(".from-option")?.focus();
}

function closeFromMenu({ refocus = false } = {}) {
  const menu = $("from-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  $("from-select").setAttribute("aria-expanded", "false");
  if (refocus) $("from-select").focus();
}

function startFromSearch() {
  fromSearching = true;
  renderTripFields();
  const input = $("trip-from");
  input.value = "";
  input.focus();
}

function stopFromSearch() {
  if (!fromSearching) return;
  fromSearching = false;
  hideSuggestions();
  renderTripFields();
}

$("from-select").addEventListener("click", () => ($("from-menu").hidden ? openFromMenu() : closeFromMenu()));
$("from-select").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    openFromMenu();
  }
});
$("from-menu").addEventListener("keydown", (e) => {
  const options = [...$("from-menu").querySelectorAll(".from-option")];
  const i = options.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    options[(i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length]?.focus();
  }
  if (e.key === "Escape") closeFromMenu({ refocus: true });
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".from-field")) closeFromMenu();
});

// Closest lots you can use near a point (respecting the filter chips).
function closestLots(point, count = 4) {
  const filters = activeFilters();
  const candidates = listEntries.filter(({ lot }) => passes(lot, filters, { ignoreText: true }));
  const usable = candidates.filter(({ lot }) => lot.category !== "limited");
  return (usable.length ? usable : candidates)
    .map((entry) => ({ lot: entry.lot, meters: meters(point, entry.lot) }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, count);
}

function setEndpoint(end, endpoint, { fit = true } = {}) {
  cancelPick();
  // Done typing: let the field show the chosen name.
  if (document.activeElement?.matches("#trip-from, #trip-to")) document.activeElement.blur();
  if (end === "from") fromSearching = false;
  trip[end] = endpoint;
  if (end === "to") {
    trip.lotChosen = false; // new destination: pick its closest lot again
    if (endpoint?.kind === "place") {
      destination = endpoint.place; // "Back to results" shows parking near it
      rankNearest();
      renderList();
    }
  }
  hideSuggestions();
  renderTripFields();
  planTrip({ fit });
}

function drawTripMarkers() {
  tripLayer.clearLayers();
  const { from, to } = trip;
  if (from && from.kind !== "here") {
    tripLayer.addLayer(
      L.marker([from.lat, from.lon], { icon: startIcon, draggable: true, zIndexOffset: 2500, title: "Drag to move the start" })
        .bindTooltip(from.kind === "pin" ? "Start" : from.name, { direction: "top", offset: [0, -10], className: "destination-label" })
        .on("dragend", (e) => setEndpoint("from", pinEndpoint(e.target.getLatLng()), { fit: false })),
    );
  }
  if (to && to.kind !== "here") {
    tripLayer.addLayer(
      L.marker([to.lat, to.lon], { icon: destinationIcon, draggable: true, zIndexOffset: 2600, title: "Drag to move the destination" })
        .bindTooltip(to.kind === "pin" ? "Destination" : to.name, { direction: "top", permanent: true, className: "destination-label" })
        .on("dragend", (e) => setEndpoint("to", pinEndpoint(e.target.getLatLng()), { fit: false })),
    );
  }
}

// Pills for the closest lots to the destination; click one to park there instead.
function renderLotOptions(lot) {
  const box = $("trip-lots");
  if (!trip.to || trip.to.kind === "lot") return box.replaceChildren();
  const options = closestLots(trip.to);
  if (!options.some((o) => o.lot === lot)) options.push({ lot, meters: meters(trip.to, lot) });
  box.replaceChildren(
    el("span", "trip-lots-label", "Park at"),
    ...options.map(({ lot: option, meters: m }) => {
      const pill = el("button", "chip-toggle trip-lot");
      pill.type = "button";
      pill.setAttribute("aria-pressed", String(option === lot));
      const swatch = el("i", "swatch");
      swatch.style.background = CATEGORIES[option.category].color;
      pill.append(swatch, el("span", null, option.name), el("span", "count", `~${formatDuration((m * 1.25) / 1.4)}`));
      pill.title = `${option.name} · ${CATEGORIES[option.category].label} · ${walkLabel(m)} to ${trip.to.name}`;
      pill.addEventListener("click", () => {
        trip.lot = option;
        trip.lotChosen = true;
        planTrip({ fit: false });
      });
      return pill;
    }),
  );
}

async function planTrip({ fit = true } = {}) {
  const run = ++directionsRun;
  routeLayer.clearLayers();
  drawTripMarkers();
  $("directions-summary").hidden = true;
  $("directions-steps").replaceChildren();
  $("directions-reroute").hidden = true;
  const { from, to } = trip;
  if (!from || !to) {
    $("trip-lots").replaceChildren();
    directionsStatus(!from && !to ? "Choose where you're starting and where you're going." : !from ? "Choose a starting point." : "Choose a destination.");
    return;
  }

  // Going to a lot means parking there; otherwise the lot you picked, or the closest usable one.
  if (to.kind === "lot") trip.lot = to.lot;
  else if (!trip.lotChosen || !trip.lot) trip.lot = closestLots(to)[0]?.lot ?? null;
  const lot = trip.lot;
  renderLotOptions(lot);
  if (!lot) {
    directionsStatus("No parking lots match your filters near there.", "warn");
    return;
  }

  let start = from;
  if (from.kind === "here") {
    directionsStatus("Finding your location… your browser may ask for permission.");
    try {
      start = await currentPosition();
    } catch (err) {
      if (run !== directionsRun) return;
      trip.from = null;
      renderTripFields();
      directionsStatus(`${err.message} Choose another starting point.`, "warn");
      openFromMenu();
      return;
    }
  }
  if (run !== directionsRun) return;

  const walkNeeded = to.kind !== "lot";
  directionsStatus("Finding the best route…");
  let drive, walk;
  try {
    [drive, walk] = await Promise.all([
      api.route("car", start, lot),
      walkNeeded ? api.route("foot", lot, to.kind === "here" ? start : to).catch((err) => ({ error: err })) : null,
    ]);
  } catch (err) {
    if (run !== directionsRun) return;
    directionsStatus(`Couldn't get driving directions: ${err.message}`, "error");
    return;
  }
  if (run !== directionsRun) return;

  // Draw: start -> lot (solid) and lot -> destination (dotted walk). Lines start
  // hidden and draw in once the map has finished moving to them.
  const driveCasing = L.polyline(drive.path, { color: "#fff", weight: 10, opacity: 0 });
  const driveLine = L.polyline(drive.path, { color: "#2f55c4", weight: 6, opacity: 0, lineCap: "round" });
  routeLayer.addLayer(driveCasing).addLayer(driveLine);
  let walkLine = null;
  const bounds = driveLine.getBounds();
  if (walk && !walk.error) {
    walkLine = L.polyline(walk.path, { color: "#3d4457", weight: 4, opacity: 0, dashArray: "1 9", lineCap: "round" });
    routeLayer.addLayer(walkLine);
    bounds.extend(walkLine.getBounds());
  }
  if (fit) fitBoundsAroundPanel(bounds, 18);
  revealRoute(run, driveCasing, driveLine, walkLine, { immediate: !fit });

  // Summary + steps
  const walked = walk && !walk.error;
  const total = drive.duration + (walked ? walk.duration : 0);
  const summary = $("directions-summary");
  summary.replaceChildren(
    el("span", "chip drive", `Drive ${formatDuration(drive.duration)}`),
    ...(walked ? [el("span", "chip walk", `Walk ${formatDuration(walk.duration)}`)] : []),
    el("span", "chip total", `About ${formatDuration(total)} total`),
  );
  summary.hidden = false;

  const parkNote = el("div", "park-note");
  parkNote.append(el("b", null, `Park at ${lot.name}`), el("span", null, ` · ${CATEGORIES[lot.category].label}`));
  if (lot.category === "limited") parkNote.append(el("small", null, lot.time_limit ? `${lot.time_limit} max · tow risk` : "Not public parking: you may be towed"));
  if (lot.category === "mine") parkNote.append(el("small", null, coveredLabel(lot)));
  if (lot.category === "permit") parkNote.append(el("small", null, "Needs a UCI permit or visitor pass"));
  if (lot.category === "staff") parkNote.append(el("small", null, "Faculty & staff permits; others weekdays after 5 pm & weekends"));
  if (lot.category === "paid") parkNote.append(el("small", null, "One-day pass $16 · hourly $4–$5"));

  const sections = [routeSection(`Drive to ${lot.name}`, drive, "drive"), parkNote];
  if (walkNeeded) {
    sections.push(
      walk.error
        ? el("p", "map-error", `Couldn't get walking directions: ${walk.error.message}`)
        : routeSection(`Walk to ${to.name}`, walk, "walk"),
    );
  }
  $("directions-steps").replaceChildren(...sections);
  directionsStatus("");
  $("directions-reroute").hidden = from.kind !== "here";
}

// ----- From / To fields: type to search, or use your location / the map -----

function suggestionsFor(end, text) {
  const tokens = normalize(text).split(" ").filter(Boolean);
  const items = [];
  if (end === "from") {
    // The dropdown already offers your location and a pin.
  } else if (trip[end]?.kind !== "here") items.push({ label: "Use my location", detail: "Follows you live", icon: "here", pick: () => setEndpoint(end, HERE) });
  if (end !== "from") items.push({ label: "Pick a point on the map", detail: "Click anywhere on the map", icon: "pin", pick: () => startPick(end) });
  if (tokens.length) {
    for (const place of findPlaces(tokens, 0).slice(0, 5)) {
      items.push({ label: place.name, detail: place.kind ?? "Place", icon: "place", pick: () => setEndpoint(end, placeEndpoint(place)) });
    }
    const lots = listEntries.filter(({ lot }) => tokens.every((t) => searchableText(lot).includes(t))).slice(0, 4);
    for (const { lot } of lots) {
      items.push({ label: lot.name, detail: CATEGORIES[lot.category].label, icon: "lot", color: CATEGORIES[lot.category].color, pick: () => setEndpoint(end, lotEndpoint(lot)) });
    }
  }
  return items;
}

const SUGGESTION_ICONS = {
  here: '<span class="sugg-icon here"></span>',
  pin: '<svg class="sugg-icon" viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><path d="M9 10h6M12 7v6"/></svg>',
  place: PLACE_ICON,
};

function showSuggestions(end) {
  suggestFor = end;
  const input = $(`trip-${end}`);
  const text = input.value === trip[end]?.name ? "" : input.value;
  suggestions = suggestionsFor(end, text);
  const list = $("trip-suggestions");
  list.replaceChildren(
    ...suggestions.map((item, i) => {
      const li = el("li");
      li.setAttribute("role", "option");
      li.id = `sugg-${i}`;
      const btn = el("button", "sugg");
      btn.type = "button";
      btn.tabIndex = -1;
      if (item.icon === "lot") {
        const swatch = el("i", "swatch");
        swatch.style.background = item.color;
        btn.append(swatch);
      } else btn.insertAdjacentHTML("beforeend", SUGGESTION_ICONS[item.icon]);
      const text = el("span", "spot-text");
      text.append(el("span", null, item.label), el("small", null, item.detail));
      btn.append(text);
      btn.addEventListener("click", item.pick);
      li.append(btn);
      return li;
    }),
  );
  list.dataset.end = end;
  list.hidden = false;
}

function hideSuggestions() {
  suggestFor = null;
  $("trip-suggestions").hidden = true;
}

function startPick(end) {
  cancelPick();
  hideSuggestions();
  document.activeElement?.blur();
  renderTripFields();
  directionsStatus(`Click the map to set your ${end === "from" ? "starting point" : "destination"}.`, "warn");
  map.getContainer().classList.add("picking-start");
  pendingPick = (e) => setEndpoint(end, pinEndpoint(e.latlng));
  map.once("click", pendingPick);
}

function cancelPick() {
  if (pendingPick) map.off("click", pendingPick);
  pendingPick = null;
  map.getContainer().classList.remove("picking-start");
}

for (const end of ["from", "to"]) {
  const input = $(`trip-${end}`);
  input.addEventListener("focus", () => {
    input.select();
    showSuggestions(end);
  });
  input.addEventListener("input", () => {
    document.querySelector(`.trip-clear[data-end="${end}"]`).hidden = !input.value;
    showSuggestions(end);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideSuggestions();
      input.value = trip[end]?.name ?? "";
      input.blur();
      if (end === "from") {
        stopFromSearch();
        $("from-select").focus();
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Typed something: take the first search match; otherwise the first option.
      const typed = suggestions.filter((s) => s.icon === "place" || s.icon === "lot");
      (typed[0] ?? suggestions[0])?.pick();
    }
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      if (suggestFor === end && !$("trip-suggestions").contains(document.activeElement)) {
        hideSuggestions();
        if (end === "from") stopFromSearch();
        renderTripFields();
      }
    }, 150),
  );
}
// Keep focus in the field while clicking a suggestion.
$("trip-suggestions").addEventListener("pointerdown", (e) => e.preventDefault());

document.querySelectorAll(".trip-clear").forEach((btn) =>
  btn.addEventListener("click", () => {
    const end = btn.dataset.end;
    if (end === "from") return stopFromSearch(); // × on the From search box just cancels the search
    cancelPick();
    trip[end] = null;
    if (end === "to") trip.lotChosen = false;
    const input = $(`trip-${end}`);
    input.value = "";
    planTrip();
    renderTripFields();
    input.focus();
  }),
);

$("trip-swap").addEventListener("click", () => {
  cancelPick();
  [trip.from, trip.to] = [trip.to, trip.from];
  trip.lotChosen = false;
  if (trip.to?.kind === "place") destination = trip.to.place;
  const swap = $("trip-swap");
  swap.classList.remove("spun");
  void swap.offsetWidth;
  swap.classList.add("spun");
  renderTripFields();
  planTrip();
});

// Draws the driving line along its path, then fades in the walking leg.
function revealRoute(run, casing, line, walkLine, { immediate = false } = {}) {
  let shown = false;
  const show = () => {
    if (shown || run !== directionsRun) return;
    shown = true;
    casing.setStyle({ opacity: 0.8 });
    line.setStyle({ opacity: 0.9 });
    const path = line.getElement();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      if (path) Object.assign(path.style, { strokeDasharray: "", strokeDashoffset: "", transition: "" });
      walkLine?.setStyle({ opacity: 1 });
    };
    if (!path || reduce) return finish();
    const length = path.getTotalLength();
    Object.assign(path.style, { strokeDasharray: `${length}`, strokeDashoffset: `${length}`, transition: "none" });
    path.getBoundingClientRect(); // apply the start state before animating
    Object.assign(path.style, {
      transition: `stroke-dashoffset ${Math.min(1400, 500 + length / 3)}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      strokeDashoffset: "0",
    });
    path.addEventListener("transitionend", finish, { once: true });
    map.once("zoomstart", finish); // zooming redraws the path, so stop drawing
  };
  if (immediate) return show();
  map.once("moveend", show);
  setTimeout(show, 1000); // in case the map didn't need to move
}

function closeDirections() {
  directionsRun++;
  closeFromMenu();
  fromSearching = false;
  cancelPick();
  hideSuggestions();
  routeLayer.clearLayers();
  tripLayer.clearLayers();
  showDirectionsView(false);
  if (destination) {
    showDestinationMarker(destination);
    $("search").value = destination.name;
    $("search-clear").hidden = false;
    applyFilters({ fit: false, animate: true });
  }
}

$("directions-back").addEventListener("click", closeDirections);
$("directions-reroute").addEventListener("click", () => planTrip());

// ---------- Boot ----------

const accountMenu = $("account-menu");
const mobileFilterToggle = $("mobile-filter-toggle");
const filterPanel = document.querySelector(".filters");
function closeMobileFilters() {
  filterPanel.classList.remove("filters-open");
  mobileFilterToggle.setAttribute("aria-expanded", "false");
}
mobileFilterToggle.addEventListener("click", () => {
  const open = filterPanel.classList.toggle("filters-open");
  mobileFilterToggle.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (!filterPanel.contains(event.target) && !mobileFilterToggle.contains(event.target)) closeMobileFilters();
});
filterPanel.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMobileFilters();
    mobileFilterToggle.focus();
  }
});
$("spot-list").addEventListener("scroll", () => {
  panel.classList.toggle("compact-filters", sheetLevel >= 2 || $("spot-list").scrollTop > 8);
  closeMobileFilters();
}, { passive: true });
const menuTrigger = accountMenu.querySelector("summary");
accountMenu.addEventListener("click", (event) => {
  if (event.target.closest(".account-dropdown button, .account-dropdown a")) accountMenu.open = false;
});
document.addEventListener("click", (event) => {
  if (!accountMenu.contains(event.target)) accountMenu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && accountMenu.open) {
    accountMenu.open = false;
    menuTrigger.focus();
  }
});
$("parking-tricks").addEventListener("click", () => $("parking-tricks-dialog").showModal());
$("parking-tricks-dialog").addEventListener("close", () => menuTrigger.focus());


async function init() {
  try {
    const [user, parking, placeData] = await Promise.all([
      api.me(),
      api.parking(),
      api.places().catch(() => ({ places: [] })), // search still works for lots without these
      initReviews({ showPanelView, onChange: () => listEntries.length && applyFilters({ fit: false }) }),
    ]);
    places = placeData.places.map((place) => ({
      ...place,
      search: normalize([place.name, place.kind ?? ""].join(" ")),
    }));
    mapHistory = createMapHistory(user.id);
    $("user-name").textContent = user.username ?? user.email;
    $("user-name").title = user.email;
    renderAvatar($("user-avatar"), user.avatar);
    bindAvatarPreview($("user-avatar"), () => user.avatar);
    permitInfo = parking.permit_info;
    uciSource = parking.uci_source ?? null;
    canHoldPermit = Boolean(user.is_uci);
    userPermit = canHoldPermit ? user.permit ?? null : null;
    renderLots(parking.lots);
    const tourActions = {
      showExample: () => {
        const studentCenter = places.find((place) => place.name === "Student Center");
        if (!studentCenter) return false;
        setDestination(studentCenter, { remember: false });
        return true;
      },
      clearExample: clearSearch,
    };
    $("tour-help").addEventListener("click", () => startMapTour(user, tourActions, true));
    $("tour-help").hidden = false;
    startMapTour(user, tourActions);
  } catch (err) {
    $("spot-count").textContent = "";
    $("map-error").textContent = err.message;
    $("map-error").hidden = false;
  }
}

init();
