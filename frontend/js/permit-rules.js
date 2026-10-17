// Where and when a UCI student parking permit is valid, transcribed from
// https://parking.uci.edu/permits/student (2026-2027). Times are campus time
// (America/Los_Angeles) whatever the viewer's time zone.
//
// Where UCI's wording is open to reading generously, this errs toward NOT free:
// - Students can't park overnight (except residents in their own area), so a
//   weekend "All Day" exception is treated as 7 a.m.-midnight.
// - Lots with unknown structure type don't get the resident "surface lots only" exception.

export const RULES_SOURCE = "https://parking.uci.edu/permits/student";
export const STALL_NOTE =
  "General unassigned stalls only: not Pay-by-Space, R, X, service, yellow ECPS or “Enforced 24 Hours” stalls.";

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

// Each window: which lots, which days, and minutes-after-midnight [start, end).
function rulesFor(code) {
  const kind = code[0];
  if (kind === "S" || kind === "P") {
    const zone = code.slice(1);
    return [
      { label: `Your Zone ${zone} lots`, days: "all", start: H(7), end: DAY, applies: (lot) => inZone(lot, zone) },
      { label: "Any Zone 1–6 lot", days: "weekdays", start: H(15), end: DAY, applies: inAnyZone },
      { label: "Any UCI lot, including P and AR stalls", days: "weekdays", start: H(17), end: DAY, applies: isUciLot },
      { label: "Any UCI lot, including P and AR stalls", days: "weekends", start: H(7), end: DAY, applies: isUciLot },
    ];
  }
  if (kind === "R") {
    const own = { label: "Your resident area", days: "all", start: 0, end: DAY, applies: (lot) => codesOf(lot).has(code) };
    if (code === "R-CVGRAD") return [own]; // UCI: exceptions don't apply to R-CVGRAD
    return [
      own,
      { label: "UCI surface lots only", days: "weekdays", start: H(17), end: DAY, applies: isUciSurfaceLot },
      { label: "UCI surface lots only", days: "weekends", start: H(7), end: DAY, applies: isUciSurfaceLot },
    ];
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

const onDay = (rule, day) =>
  rule.days === "all" || (rule.days === "weekdays" ? day >= 1 && day <= 5 : day === 0 || day === 6);

export function formatTime(minutes) {
  if (minutes === 0 || minutes === DAY) return "Midnight";
  const h = Math.floor(minutes / 60);
  return `${h % 12 || 12}${minutes % 60 ? `:${String(minutes % 60).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

export function describeWindow(rule) {
  const days = { all: "Every day", weekdays: "Mon–Fri", weekends: "Sat–Sun" }[rule.days];
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

// A one-line summary of where a permit works, for settings.
export function permitSummary(code) {
  return rulesFor(code).map((rule) => ({ where: rule.label, when: describeWindow(rule) }));
}
