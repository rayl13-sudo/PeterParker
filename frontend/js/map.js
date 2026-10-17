// Map page: OpenStreetMap of UC Irvine with every parking lot shaded by category
// (free, permit, paid, limited/tow risk) and marked, with UCI permit and
// daily-pass details, what each lot is for, and tow/time-limit warnings in popups.
// Leaflet is loaded as a global (L) by map.html.
import { api, setUnauthorizedHandler } from "./api.js";
import { clearToken, getToken } from "./auth.js";
import { renderAvatar } from "./avatar.js";
import { initReviews, openReviews, ratingLabel } from "./reviews.js";
import { startMapTour } from "./map-tour.js";

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
  actions.append(go, reviews);
  root.append(actions);
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
  const area = lot.outline.length
    ? L.polygon(lot.outline, {
        color: cat.color,
        weight: cat.weight ?? 1.5,
        fillColor: cat.color,
        fillOpacity: cat.fillOpacity,
        dashArray: cat.dashArray,
      })
        .bindPopup(() => popupContent(lot), POPUP_OPTIONS)
        .addTo(map)
    : null;

  const marker =
    cat.marker === "pin"
      ? L.marker([lot.lat, lot.lon], { icon: pinIcon(lot), title: lot.name, zIndexOffset: 500 })
      : cat.marker === "dot" || !area
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

// ---------- Side list: Free / Permit / Paid / Limited tabs ----------

const LIST_TABS = {
  free: { title: "Free parking", match: (lot) => isFree(lot) },
  permit: { title: "Permit parking", match: (lot) => lot.category === "permit" },
  paid: { title: "Paid parking", match: (lot) => lot.category === "paid" },
  limited: { title: "Limited / tow-risk parking", match: (lot) => lot.category === "limited" },
};
let listEntries = []; // [{ lot, area, marker, primary }]
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
  btn.append(swatch, text);
  btn.addEventListener("click", () => {
    map.flyTo([lot.lat, lot.lon], 18, { duration: 0.6 });
    map.once("moveend", () => layer.fire("click", { latlng: L.latLng(lot.lat, lot.lon) }));
  });
  const li = el("li");
  li.append(btn);
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
  li.append(btn);
  return li;
}

const sectionHeading = (text) => el("li", "list-heading", text);

// Shown above the closest lots once a destination is picked, inviting a look at its reviews.
function placeCard(place) {
  const li = el("li", "place-card");
  li.append(el("strong", null, place.name));
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

function renderList() {
  const searching = searchResults !== null || destination !== null;
  document.querySelector(".list-tabs").classList.toggle("searching", searching);

  if (destination) {
    $("panel-title").textContent = `Parking near ${destination.name}`;
    const usable = nearest.filter(({ entry }) => entry.lot.category !== "limited");
    const risky = nearest.filter(({ entry }) => entry.lot.category === "limited");
    $("spot-count").textContent = "Closest lots by walking distance";
    $("spot-list").replaceChildren(
      placeCard(destination),
      sectionHeading("Closest parking"),
      ...usable.map(({ entry, meters }) => listItem(entry, meters)),
      ...(risky.length ? [sectionHeading("Also nearby: may be towed")] : []),
      ...risky.map(({ entry, meters }) => listItem(entry, meters)),
    );
  } else if (searching) {
    const lots = searchResults;
    const places = placeResults;
    $("panel-title").textContent = "Search results";
    const parts = [];
    if (places.length) parts.push(`${places.length} ${places.length === 1 ? "place" : "places"}`);
    parts.push(`${lots.length} ${lots.length === 1 ? "lot" : "lots"}`);
    $("spot-count").textContent = `${parts.join(" and ")} for “${$("search").value.trim()}”`;
    const items = [];
    if (places.length) items.push(sectionHeading("Places: pick one to see the closest parking"), ...places.map(placeItem));
    if (lots.length) items.push(...(places.length ? [sectionHeading("Parking lots")] : []), ...lots.map((e) => listItem(e)));
    if (!items.length) items.push(el("li", "no-results", "Nothing matches. Try a shorter or different word."));
    $("spot-list").replaceChildren(...items);
  } else {
    const tab = LIST_TABS[activeTab];
    const entries = listEntries.filter(({ lot }) => tab.match(lot));
    $("panel-title").textContent = `${tab.title} near UCI`;
    $("spot-count").textContent = `${entries.length} ${entries.length === 1 ? "lot" : "lots"}`;
    $("spot-list").replaceChildren(...entries.map((e) => listItem(e)));
  }
  document.querySelectorAll(".list-tab").forEach((btn) => {
    const active = btn.dataset.list === activeTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
}

document.querySelectorAll(".list-tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    activeTab = btn.dataset.list;
    if (searchResults !== null || destination) clearSearch(); // picking a tab leaves search
    renderList();
  }),
);

// ---------- Search: bold matching lots, fade the rest, as you type ----------

let searchResults = null; // null = not searching; otherwise the matching list entries
let placeResults = []; // buildings/places matching the search
let places = []; // searchable destinations, from /api/places
let destination = null; // the chosen place, once picked
let nearest = []; // [{ entry, meters }] closest lots to the destination
let destinationMarker = null;
let fitTimer = null;
const NEAREST_LOTS = 6;
const NEAREST_RISKY = 2;
const MAX_PLACE_RESULTS = 6;

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

function setLotState({ lot, area, marker }, state) {
  const cat = CATEGORIES[lot.category];
  const weight = cat.weight ?? 1.5;
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
    marker.setStyle({ opacity: faded, fillOpacity: faded }).setRadius(state === "match" ? 8 : 6);
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

function findPlaces(tokens, query) {
  return places
    .filter((place) => tokens.every((t) => place.search.includes(t)))
    .sort((a, b) => (b.search.startsWith(query) - a.search.startsWith(query)) || a.name.length - b.name.length)
    .slice(0, MAX_PLACE_RESULTS);
}

function runSearch() {
  const raw = $("search").value;
  const query = normalize(raw);
  const tokens = query.split(" ").filter(Boolean);
  $("search-clear").hidden = !raw;
  clearTimeout(fitTimer);
  clearDestination(); // typing again means looking for something new
  if (!tokens.length) {
    searchResults = null;
    placeResults = [];
    listEntries.forEach((entry) => setLotState(entry, "normal"));
    renderList();
    return;
  }
  placeResults = findPlaces(tokens, query);
  const matched = new Set(
    listEntries.filter(({ lot }) => tokens.every((t) => searchableText(lot).includes(t))),
  );
  searchResults = [...matched];
  listEntries.forEach((entry) => setLotState(entry, matched.has(entry) ? "match" : "dim"));
  renderList();
  // Move the map once typing pauses, so it doesn't jump on every letter.
  fitTimer = setTimeout(() => fitToResults(searchResults ?? []), 350);
}

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

function setDestination(place) {
  clearTimeout(fitTimer);
  destination = place;
  searchResults = null;
  placeResults = [];
  $("search").value = place.name;
  $("search-clear").hidden = false;

  destinationMarker?.remove();
  destinationMarker = L.marker([place.lat, place.lon], { icon: destinationIcon, zIndexOffset: 2000, keyboard: false })
    .bindTooltip(place.name, { direction: "top", permanent: true, className: "destination-label" })
    .on("click", () => showPlaceReviews(place))
    .addTo(map);

  // Lots you can actually use first; a couple of nearby tow-risk lots after, flagged.
  const ranked = listEntries
    .map((entry) => ({ entry, meters: meters(place, entry.lot) }))
    .sort((a, b) => a.meters - b.meters);
  const usable = ranked.filter(({ entry }) => entry.lot.category !== "limited").slice(0, NEAREST_LOTS);
  const farthest = usable.at(-1)?.meters ?? Infinity;
  const risky = ranked
    .filter(({ entry, meters }) => entry.lot.category === "limited" && meters < farthest)
    .slice(0, NEAREST_RISKY);
  nearest = [...usable, ...risky];
  const close = new Set(nearest.map(({ entry }) => entry));
  listEntries.forEach((entry) => setLotState(entry, close.has(entry) ? "match" : "dim"));
  renderList();
  fitToResults(nearest.map(({ entry }) => entry), place);
}

function clearDestination() {
  if (!destination) return;
  destination = null;
  nearest = [];
  destinationMarker?.remove();
  destinationMarker = null;
}

$("search").addEventListener("input", runSearch);
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSearch();
  if (e.key === "Enter" && placeResults.length) setDestination(placeResults[0]);
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

function renderLots(lots) {
  lots = [...lots].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  listEntries = lots.map((lot) => ({ lot, ...addLot(lot) }));
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

// ---------- Directions: drive to a lot, then walk to the destination ----------

const routeLayer = L.layerGroup().addTo(map);
let directionsRun = 0; // bumps on every new request so stale answers are ignored

const PANEL_VIEWS = ["list-view", "directions-view", "reviews-view"];

function showPanelView(name) {
  for (const view of PANEL_VIEWS) $(view).hidden = view !== name;
  if ($("panel").classList.contains("collapsed")) $("panel-toggle").click();
}

const showDirectionsView = (show) => showPanelView(show ? "directions-view" : "list-view");

function directionsStatus(text, kind) {
  const status = $("directions-status");
  status.textContent = text ?? "";
  status.className = `panel-sub ${kind ?? ""}`;
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Your browser can't share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
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

// Fallback when location isn't available: the next click on the map is the start.
function pickStartOnMap(run) {
  return new Promise((resolve) => {
    const container = map.getContainer();
    container.classList.add("picking-start");
    map.once("click", (e) => {
      container.classList.remove("picking-start");
      if (run === directionsRun) resolve({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
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

async function startDirections(lot) {
  const run = ++directionsRun;
  const target = destination;
  routeLayer.clearLayers();
  showDirectionsView(true);
  $("directions-title").textContent = target ? `To ${target.name}` : `To ${lot.name}`;
  $("directions-summary").hidden = true;
  $("directions-steps").replaceChildren();

  directionsStatus("Finding your location… your browser may ask for permission.");
  let start;
  try {
    start = await currentPosition();
  } catch (err) {
    if (run !== directionsRun) return;
    directionsStatus(`${err.message} Click on the map where you're starting from.`, "warn");
    start = await pickStartOnMap(run);
  }
  if (run !== directionsRun) return;

  directionsStatus("Finding the best route…");
  let drive, walk;
  try {
    [drive, walk] = await Promise.all([
      api.route("car", start, lot),
      target ? api.route("foot", lot, target).catch((err) => ({ error: err })) : null,
    ]);
  } catch (err) {
    if (run !== directionsRun) return;
    directionsStatus(`Couldn't get driving directions: ${err.message}`, "error");
    return;
  }
  if (run !== directionsRun) return;

  // Draw: you -> lot (solid) and lot -> destination (dotted walk).
  const driveLine = L.polyline(drive.path, { color: "#2f55c4", weight: 6, opacity: 0.9, lineCap: "round" });
  routeLayer.addLayer(L.polyline(drive.path, { color: "#fff", weight: 10, opacity: 0.8 })).addLayer(driveLine);
  routeLayer.addLayer(
    L.circleMarker([start.lat, start.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#2f55c4", fillOpacity: 1 })
      .bindTooltip("You", { direction: "top", permanent: true, className: "destination-label" }),
  );
  const bounds = driveLine.getBounds();
  if (walk && !walk.error) {
    const walkLine = L.polyline(walk.path, { color: "#3d4457", weight: 4, dashArray: "1 9", lineCap: "round" });
    routeLayer.addLayer(walkLine);
    bounds.extend(walkLine.getBounds());
  }
  fitBoundsAroundPanel(bounds, 18);

  // Summary + steps
  const total = drive.duration + (walk && !walk.error ? walk.duration : 0);
  const summary = $("directions-summary");
  summary.replaceChildren(
    el("span", "chip drive", `Drive ${formatDuration(drive.duration)}`),
    ...(walk && !walk.error ? [el("span", "chip walk", `Walk ${formatDuration(walk.duration)}`)] : []),
    el("span", "chip total", `About ${formatDuration(total)} total`),
  );
  summary.hidden = false;

  const parkNote = el("div", "park-note");
  parkNote.append(el("b", null, `Park at ${lot.name}`), el("span", null, ` · ${CATEGORIES[lot.category].label}`));
  if (lot.category === "limited") parkNote.append(el("small", null, lot.time_limit ? `${lot.time_limit} max · tow risk` : "Not public parking: you may be towed"));
  if (lot.category === "permit") parkNote.append(el("small", null, "Needs a UCI permit or visitor pass"));
  if (lot.category === "paid") parkNote.append(el("small", null, "One-day pass $16 · hourly $4–$5"));

  const sections = [routeSection(`Drive to ${lot.name}`, drive, "drive"), parkNote];
  if (target) {
    sections.push(
      walk.error
        ? el("p", "map-error", `Couldn't get walking directions: ${walk.error.message}`)
        : routeSection(`Walk to ${target.name}`, walk, "walk"),
    );
  }
  $("directions-steps").replaceChildren(...sections);
  directionsStatus(target ? `Via ${lot.name}` : "");
}

function closeDirections() {
  directionsRun++;
  routeLayer.clearLayers();
  map.getContainer().classList.remove("picking-start");
  showDirectionsView(false);
}

$("directions-back").addEventListener("click", closeDirections);

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
    const [user, parking, placeData] = await Promise.all([
      api.me(),
      api.parking(),
      api.places().catch(() => ({ places: [] })), // search still works for lots without these
      initReviews({ showPanelView, onChange: () => renderList() }),
    ]);
    places = placeData.places.map((place) => ({
      ...place,
      search: normalize([place.name, place.kind ?? ""].join(" ")),
    }));
    $("user-name").textContent = user.username ?? user.email;
    $("user-name").title = user.email;
    renderAvatar($("user-avatar"), user.avatar);
    permitInfo = parking.permit_info;
    renderLots(parking.lots);
    const tourActions = {
      showExample: () => {
        const studentCenter = places.find((place) => place.name === "Student Center");
        if (!studentCenter) return false;
        setDestination(studentCenter);
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
