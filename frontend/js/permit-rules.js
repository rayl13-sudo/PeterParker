// Where and when a UCI student parking permit is valid, transcribed from
// https://parking.uci.edu/permits/student (2026-2027). Times are campus time
// (America/Los_Angeles) whatever the viewer's time zone.
//
// Where UCI's wording is open to reading generously, this errs toward NOT free:
// - Students can't park overnight (except residents in their own area), so a
//   weekend "All Day" exception is treated as 7 a.m.-midnight.
// - Lots with unknown structure type don't get the resident "surface lots only" exception.

export const RULES_SOURCE = "https://parking.uci.edu/permits/student";
export const STAFF_RULES_SOURCE = "https://parking.uci.edu/permits/faculty-staff/";
export const rulesSourceFor = (code) => (["C", "AR", "X"].includes(code) ? STAFF_RULES_SOURCE : RULES_SOURCE);
export const STALL_NOTE =
  "General unassigned stalls only: not Pay-by-Space, R, X, service, yellow ECPS or “Enforced 24 Hours” stalls.";

// Each permit's own parking area, word for word from UCI's permit tables.
const ZONE_AREAS = {
  1: ["Mesa Parking Structure (MPS)", "Lot 14", "Lot 14A", "Lot 90", "Lot ARC", "White stalls of East Campus Parking Structure (ECPS)"],
  2: ["Level 5 of Health Sciences Parking Structure (HSPS)", "Lot 90", "Lot ARC", "White stalls of East Campus Parking Structure (ECPS)"],
  3: ["Lot 16H", "Lot 70", "Lot 90", "Lot ARC", "White stalls of East Campus Parking Structure (ECPS)"],
  4: ["Anteater Parking Structure (APS)", "Lot 90", "Lot ARC", "White stalls of East Campus Parking Structure (ECPS)"],
  5: ["Social Science Parking Structure (SSPS)", "Lot 90", "Lot ARC", "White stalls of East Campus Parking Structure (ECPS)"],
  6: ["Student Center Parking Structure (SCPS)", "Lot 5", "Lot 90", "Lot ARC", "White stalls of East Campus Parking Structure (ECPS)"],
};
const RESIDENT_AREAS = {
  "R-MC": ["Lot 5", "Lot 14", "Lot 14A"],
  "R-ME": ["Levels 3–7 of Anteater Parking Structure (APS)", "Lot 18R"],
  "R-AV": ["Lot AV2", "Lot AV3"],
  "R-CVGRAD": ["Lot 16AE", "Lot 16AW", "Lot 16B", "Lot 70", "“R” resident-assigned stalls in Lot 13", "Lot ARC"],
  "R-OC": ["White stalls of East Campus Parking Structure (ECPS)"],
};

// What the permit is assigned to: { title, places } for S/P zone and R permits, else null.
export function assignedArea(code) {
  if (!code) return null;
  const zone = /^[SP]([1-6])$/.exec(code)?.[1];
  if (zone) return { title: `Your Zone ${zone}`, places: ZONE_AREAS[zone] };
  if (RESIDENT_AREAS[code]) return { title: `Your ${code} area`, places: RESIDENT_AREAS[code] };
  return null;
}

// Where the permit is never valid, from UCI's "NOT VALID" lists.
const NOT_VALID_COMMON = [
  "“X” reserved/executive stalls",
  "Exclusively reserved stalls",
  "Service / E-Plate stalls",
  "Disabled stalls without a DP placard or plate",
  "Pay-by-Space stalls",
  "Yellow stalls in ECPS",
];
export function notValidFor(code) {
  if (!code) return [];
  if (/^S[1-6]$/.test(code)) return ["Overnight", "“P” preferred stalls (before 5 pm weekdays)", "“AR” reserved stalls (before 5 pm weekdays)", "“R” resident stalls", ...NOT_VALID_COMMON];
  if (/^P[1-6]$/.test(code)) return ["Overnight", "“AR” reserved stalls (before 5 pm weekdays)", "“R” resident stalls", ...NOT_VALID_COMMON];
  if (code.startsWith("R-")) return ["“P” and “AR” stalls outside the exception hours", ...NOT_VALID_COMMON];
  return [];
}

// Anteater Recreation Center hours (campusrec.uci.edu/arc/hours.html), for the R-MC /
// R-ME exception. The ARC changes these over breaks; check before relying on them.
export const ARC_HOURS_SOURCE = "https://www.campusrec.uci.edu/arc/hours.html";
const ARC_HOURS = [
  { days: "weekdays", start: 6, end: 24 },
  { days: "sat", start: 8, end: 21 },
  { days: "sun", start: 8, end: 24 },
];

const DAY = 24 * 60;
const H = (h) => h * 60;

// Lots by the permit codes UCI assigns them (from /api/parking: lot.permits).
const codesOf = (lot) => new Set(lot.permits.map((p) => p.code));
const ZONE_CODE = /^[SP][1-6]$/;
const inZone = (lot, zone) => {
  const codes = codesOf(lot);
  return codes.has(`S${zone}`) || codes.has(`P${zone}`) || codes.has("S-ANY"); // ECPS white stalls are in every zone
};
const inAnyZone = (lot) => [...codesOf(lot)].some((c) => ZONE_CODE.test(c) || c === "S-ANY");
const isUciLot = (lot) => lot.uci;
const isUciSurfaceLot = (lot) => lot.uci && lot.parking === "surface";
const isEcps = (lot) => codesOf(lot).has("S-ANY");

// Each window: which lots, which days, and minutes-after-midnight [start, end).
// `home` marks the permit's own assigned area (see assignedArea).
function rulesFor(code) {
  const kind = code[0];
  if (kind === "S" || kind === "P") {
    const zone = code.slice(1);
    const own = kind === "P" ? "“P” preferred and general stalls" : "General unassigned stalls";
    const anyLot =
      kind === "P"
        ? "Any UCI lot, incl. faculty/staff lots: general and non-24-hour “AR” stalls"
        : "Any UCI lot, incl. faculty/staff lots: general, “P” and non-24-hour “AR” stalls";
    return [
      { label: `Your Zone ${zone}: ${own}`, home: true, days: "all", start: H(7), end: DAY, applies: (lot) => inZone(lot, zone) },
      { label: "Any Zone 1–6 lot: general stalls", days: "weekdays", start: H(15), end: DAY, applies: inAnyZone },
      { label: anyLot, days: "weekdays", start: H(17), end: DAY, applies: isUciLot },
      { label: anyLot, days: "weekends", start: H(7), end: DAY, applies: isUciLot },
    ];
  }
  if (kind === "R") {
    const own = { label: "Your resident area", home: true, days: "all", start: 0, end: DAY, applies: (lot) => codesOf(lot).has(code) };
    if (code === "R-CVGRAD") return [own]; // UCI: exceptions don't apply to R-CVGRAD
    const surface = "UCI surface lots (not structures): general, “P” and non-24-hour “AR” stalls";
    const rules = [
      own,
      { label: surface, days: "weekdays", start: H(17), end: DAY, applies: isUciSurfaceLot },
      { label: surface, days: "weekends", start: H(7), end: DAY, applies: isUciSurfaceLot },
    ];
    if (code === "R-MC" || code === "R-ME") {
      const atArc = (lot) => lot.name === "Lot ARC" || isEcps(lot);
      for (const { days, start, end } of ARC_HOURS) {
        rules.push({ label: "Lot ARC and ECPS white stalls, while the ARC is open", days, start: H(start), end: H(end), applies: atArc });
      }
    }
    return rules;
  }
  // Faculty/staff permits (https://parking.uci.edu/permits/faculty-staff/). UCI states no
  // daytime hours, but "Overnight parking is not permitted with a faculty/staff permit",
  // so like student permits they count from 7 am to midnight.
  if (code === "C") {
    return [
      { label: "Any UCI lot's general stalls (not Lot 1C)", days: "all", start: H(7), end: DAY, applies: (lot) => isUciLot(lot) && lot.name !== "Lot 1C" },
      { label: "Also P and AR stalls", days: "weekdays", start: H(17), end: DAY, applies: (lot) => isUciLot(lot) && lot.name !== "Lot 1C" },
      { label: "Also P and AR stalls", days: "weekends", start: H(7), end: DAY, applies: (lot) => isUciLot(lot) && lot.name !== "Lot 1C" },
    ];
  }
  if (code === "AR") {
    return [
      { label: "Any UCI lot's AR, P and general stalls (not Lots 1C or 80)", days: "all", start: H(7), end: DAY,
        applies: (lot) => isUciLot(lot) && lot.name !== "Lot 1C" && lot.name !== "Lot 80" },
    ];
  }
  if (code === "X") {
    return [{ label: "Any UCI lot or stall (not department, patient, E-plate or disabled stalls)", days: "all", start: H(7), end: DAY, applies: isUciLot }];
  }
  if (code === "E") {
    return [
      { label: "Any UCI lot", days: "weekdays", start: H(17), end: DAY, applies: isUciLot },
      { label: "Any UCI lot", days: "weekends", start: H(7), end: DAY, applies: isUciLot },
    ];
  }
  return [];
}

// Campus-local day of week (0 = Sunday) and minutes after midnight.
export function campusTime(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const DAY_SETS = { all: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6], sat: [6], sun: [0] };
const onDay = (rule, day) => DAY_SETS[rule.days].includes(day);

export function formatTime(minutes) {
  if (minutes === 0 || minutes === DAY) return "Midnight";
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}${minutes % 60 ? `:${String(minutes % 60).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

export function describeWindow(rule) {
  const days = { all: "Every day", weekdays: "Mon–Fri", weekends: "Sat–Sun", sat: "Sat", sun: "Sun" }[rule.days];
  const hours = rule.start === 0 && rule.end === DAY ? "24 hours" : `${formatTime(rule.start)}–${formatTime(rule.end)}`;
  return `${days}, ${hours}`;
}

// For one lot and permit: the windows that apply here, and whether one is open now.
// { windows: [...], active: rule | null, until: "midnight" | "any time" | null }
export function permitStatus(lot, code, now = new Date()) {
  if (!code) return null;
  const windows = rulesFor(code).filter((rule) => rule.applies(lot));
  if (!windows.length) return null;
  const { day, minutes } = campusTime(now);
  const open = windows.filter((r) => onDay(r, day) && minutes >= r.start && minutes < r.end);
  // If several windows are open, report the one that lasts longest.
  const active = open.sort((a, b) => b.end - a.end)[0] ?? null;
  const until = !active ? null : active.start === 0 && active.end === DAY ? "any time" : `until ${formatTime(active.end)}`;
  return { windows, active, until };
}

// Is this lot part of the permit's own assigned area (whatever the time)?
export function isHomeLot(lot, code) {
  return !!code && rulesFor(code).some((rule) => rule.home && rule.applies(lot));
}

// A one-line summary of where a permit works, for settings.
export function permitSummary(code) {
  return rulesFor(code).map((rule) => ({ where: rule.label, when: describeWindow(rule) }));
}
