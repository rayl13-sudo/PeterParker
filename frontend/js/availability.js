// Typical open spaces right now, by lot type and campus time.
//
// UCI doesn't publish live or historical occupancy, so this is an estimate of a
// *typical* day, not a live count:
// - Commuter lots/structures follow UCI's own guidance that "during peak times
//   (9:30 a.m. - 2:00 p.m.), parking may be full in core locations"
//   (https://parking.uci.edu/permits/student), with Lot ARC / Lot 90 / ECPS as
//   the overflow UCI points people to.
// - Shape and evening/weekend levels follow typical campus parking studies (e.g.
//   UC Riverside's occupancy counts, peaking near 73% campus-wide) and typical
//   retail/residential demand.
import { campusTime } from "./permit-rules.js";

// [hour, share of spaces occupied] points; linearly interpolated.
const PROFILES = {
  commuter: {
    weekday: [[0, 0.05], [6, 0.08], [7, 0.25], [8, 0.55], [9, 0.8], [9.5, 0.95], [14, 0.95], [15, 0.8], [16, 0.62], [17, 0.45], [18, 0.32], [20, 0.2], [22, 0.1], [24, 0.05]],
    weekend: [[0, 0.03], [8, 0.06], [11, 0.15], [14, 0.18], [17, 0.12], [20, 0.08], [24, 0.03]],
  },
  overflow: {
    weekday: [[0, 0.05], [7, 0.15], [8, 0.35], [9.5, 0.6], [12, 0.72], [14, 0.7], [16, 0.5], [18, 0.25], [21, 0.12], [24, 0.05]],
    weekend: [[0, 0.03], [9, 0.08], [12, 0.15], [16, 0.15], [20, 0.06], [24, 0.03]],
  },
  staff: {
    weekday: [[0, 0.03], [6, 0.1], [7, 0.35], [8, 0.7], [9, 0.88], [12, 0.9], [15, 0.82], [16, 0.65], [17, 0.35], [18, 0.18], [20, 0.08], [24, 0.03]],
    weekend: [[0, 0.02], [9, 0.06], [13, 0.1], [17, 0.06], [24, 0.02]],
  },
  campus: {
    weekday: [[0, 0.04], [7, 0.3], [9, 0.75], [12, 0.82], [15, 0.75], [17, 0.4], [19, 0.15], [24, 0.04]],
    weekend: [[0, 0.03], [10, 0.1], [14, 0.12], [18, 0.06], [24, 0.03]],
  },
  resident: {
    weekday: [[0, 0.92], [6, 0.9], [8, 0.75], [10, 0.6], [14, 0.58], [17, 0.7], [20, 0.85], [22, 0.9], [24, 0.92]],
    weekend: [[0, 0.92], [10, 0.78], [14, 0.66], [18, 0.75], [22, 0.9], [24, 0.92]],
  },
  retail: {
    weekday: [[0, 0.03], [7, 0.08], [9, 0.2], [11, 0.45], [12.5, 0.7], [14, 0.5], [17, 0.55], [18.5, 0.72], [21, 0.4], [22, 0.15], [24, 0.03]],
    weekend: [[0, 0.03], [9, 0.2], [11, 0.55], [13, 0.8], [16, 0.65], [18.5, 0.75], [21, 0.4], [24, 0.03]],
  },
  public: {
    weekday: [[0, 0.02], [7, 0.1], [9, 0.2], [12, 0.3], [17, 0.35], [20, 0.15], [24, 0.02]],
    weekend: [[0, 0.02], [8, 0.25], [10, 0.55], [14, 0.5], [18, 0.3], [21, 0.08], [24, 0.02]],
  },
};

const RETAIL_HINT = /supermarket|restaurant|cafe|fast food|clinic|pharmacy|shop|store|gift|clothes|hairdresser|bakery|pastry|bank|cinema|copyshop|toys|optometrist/i;
const OVERFLOW = new Set(["Lot ARC", "Lot 90", "East Campus Parking Structure"]);

function profileFor(lot) {
  const type = lot.baseCategory ?? lot.category;
  const codes = new Set(lot.permits.map((p) => p.code));
  if (lot.utc || /customers/i.test(lot.restriction ?? "")) return "retail";
  if (type === "limited") return lot.serves.some((s) => RETAIL_HINT.test(s)) ? "retail" : "resident";
  if (type === "free") return "public";
  if (type === "staff") return "staff";
  if (OVERFLOW.has(lot.name)) return "overflow";
  if ([...codes].some((c) => /^[SP]\d$/.test(c))) return "commuter";
  if ([...codes].some((c) => c.startsWith("R-")) || /housing/i.test(lot.inferred ?? "")) return "resident";
  return "campus";
}

function occupancyAt(points, hour) {
  for (let i = 1; i < points.length; i++) {
    const [h1, o1] = points[i - 1];
    const [h2, o2] = points[i];
    if (hour <= h2) return o1 + ((o2 - o1) * (hour - h1)) / (h2 - h1);
  }
  return points.at(-1)[1];
}

// { open, total, occupancy, profile } for a typical day at this time, or null if
// the lot's size isn't known.
export function openNow(lot, now = new Date()) {
  const total = lot.spaces?.total;
  if (!total) return null;
  const { day, minutes } = campusTime(now);
  const profile = profileFor(lot);
  const weekend = day === 0 || day === 6;
  const occupancy = occupancyAt(PROFILES[profile][weekend ? "weekend" : "weekday"], minutes / 60);
  return { open: Math.max(0, Math.round(total * (1 - occupancy))), total, occupancy, profile };
}

export const AVAILABILITY_NOTE =
  "Typical for this time of day, estimated from UCI's peak-hour guidance and common campus/retail patterns. UCI doesn't publish live availability, so check signs on arrival.";
