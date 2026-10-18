import json
import math
import re
from functools import cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.security import get_current_user

router = APIRouter(prefix="/parking", tags=["parking"])

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
# Snapshot of OpenStreetMap parking around UCI, sorted into categories.
# Refresh with: .venv/bin/python scripts/fetch_parking.py
DATA_FILE = DATA_DIR / "parking_lots.json"
# Which UCI permits each lot accepts and visitor prices, transcribed by hand from
# parking.uci.edu (see "sources" in the file). Update it when UCI publishes new rates.
PERMITS_FILE = DATA_DIR / "uci_permits.json"

LOT_NUMBER = re.compile(r"^Lot \w+$")  # UCI's own lot names: "Lot 5", "Lot 16H", "Lot BP"
# Housing communities with their own resident parking (housing.uci.edu/grad/parking).
HOUSING_NAMES = re.compile(
    r"Verano|Palo Verde|Campus Village|Plaza Verde|Vista del Campo|Camino del Sol|Puerta del Sol"
    r"|University Hills|Mesa Court|Middle Earth|Arroyo Vista",
    re.I,
)

UCI_OPERATORS = {
    "University of California, Irvine - Transportation Services",
    "University of California, Irvine",
    "UC Irvine",
}

Category = Literal["free", "permit", "paid", "limited", "staff"]

# UCI's official per-lot data (stall tables, EV ports, faculty/staff lots); refresh with
# .venv/bin/python scripts/fetch_uci_map.py
UCI_LOTS_FILE = DATA_DIR / "uci_lots.json"
# Hospital/medical-center structures follow UCI Health's own rules, not campus permits.
SKIP_UCI_LOTS = re.compile(r"UCI Health", re.I)


class Permit(BaseModel):
    code: str
    name: str
    who: str
    price: str


class VisitorRate(BaseModel):
    name: str
    price: str
    where: str


class PermitInfo(BaseModel):
    academic_year: str
    retrieved: str
    sources: list[str]
    permits: dict[str, Permit]  # every permit by code, for naming the user's own
    holdable_permits: list[str]
    permit_rules_source: str
    visitor_rates: list[VisitorRate]
    visitor_hours: dict[str, str]


class EvPorts(BaseModel):
    level1: int = 0
    level2: int = 0


class Spaces(BaseModel):
    """How many spaces a lot has, and where the numbers come from."""

    source: Literal["uci", "osm", "estimate"]
    total: int | None = None
    regular: int | None = None  # general stalls anyone with the right permit/pass can use
    accessible: int | None = None  # ADA stalls (standard + van + accessible EV)
    accessible_standard: int | None = None
    accessible_van: int | None = None
    accessible_ev: int | None = None
    accessible_where: list[str] = []  # where the ADA stalls are (UCI's accessible-parking layer)
    accessible_is_minimum: bool = False  # True when `accessible` is the ADA minimum, not a count
    ev_stalls: int | None = None  # EV-designated stalls
    ev_ports: EvPorts | None = None  # charging ports (UCI's EV charging layer)
    tesla_chargers: int = 0  # Tesla-specific chargers (none are published at UCI)
    levels: int | None = None
    breakdown: dict[str, int] = {}  # every stall type UCI lists, e.g. {"AR Reserved (7am-5pm)": 189}


class ParkingLot(BaseModel):
    id: str
    name: str
    category: Category
    inferred: str | None = None  # why the category was guessed, if it was
    permit_accepted: bool = False  # paid lots that also take UCI permits
    # Ways to pay here, whatever the lot's main category (a staff lot can also sell
    # visitor permits): "dispenser", "pay_by_space", "parkbyplate" (UCI's map) or
    # "fee" (OpenStreetMap fee=yes).
    pay: list[str] = []
    merged_from: int = 1  # number of mapped pieces combined into this lot
    # "limited" lots: who may park, any time limit, and a tow/ticket warning
    restriction: str | None = None
    time_limit: str | None = None
    warning: str | None = None
    warning_source: str | None = None
    utc: bool = False  # University Town Center
    serves: list[str] = []  # named places next to the lot: what it's for
    lat: float
    lon: float
    outline: list[list[list[float]]]  # rings of [lat, lon]; empty for lots mapped as a point
    access: str | None = None
    capacity: int | None = None
    parking: str | None = None
    operator: str | None = None
    opening_hours: str | None = None
    uci: bool = False  # run by UCI Transportation, so UCI permit/visitor rules apply
    permits: list[Permit] = []  # permits UCI lists for this lot; empty if not published
    permit_note: str | None = None
    spaces: Spaces | None = None
    uci_map_id: int | None = None  # this lot on map.uci.edu


class ParkingResponse(BaseModel):
    source: str
    uci_source: str | None = None
    lots: list[ParkingLot]
    permit_info: PermitInfo


def _key(name: str) -> str:
    """'Student Center Parking Structure (SCPS)' -> 'student center parking structure'."""
    return re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", "", name)).strip().lower()


def _meters_apart(a: dict, b: dict) -> float:
    dy = (a["lat"] - b["lat"]) * 111_320
    dx = (a["lon"] - b["lon"]) * 111_320 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, dy)


def _area_m2(outline: list) -> float:
    total = 0.0
    for ring in outline:
        lat0 = math.radians(ring[0][0])
        pts = [(lon * 111_320 * math.cos(lat0), lat * 111_320) for lat, lon in ring]
        total += abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2
    return total


def ada_minimum(total: int) -> int:
    """Accessible spaces required for a lot of `total` spaces (2010 ADA Standards, 208.2)."""
    for limit, required in ((25, 1), (50, 2), (75, 3), (100, 4), (150, 5), (200, 6), (300, 7), (400, 8), (500, 9)):
        if total <= limit:
            return required
    return math.ceil(total * 0.02) if total <= 1000 else 20 + math.ceil((total - 1000) / 100)


SQ_M_PER_SPACE = 30  # a stall plus its share of aisles, typical for surface lots


def _uci_spaces(uci_lot: dict, ev: dict | None) -> Spaces:
    stalls = uci_lot["stalls"]
    ada = stalls.get("ADA (Standard)", 0) + stalls.get("ADA (Van)", 0) + stalls.get("Electric Veh. (ADA)", 0)
    return Spaces(
        source="uci",
        total=sum(stalls.values()) or None,
        regular=stalls.get("General", 0) + stalls.get("Visitor", 0),
        accessible=ada,
        accessible_standard=stalls.get("ADA (Standard)", 0),
        accessible_van=stalls.get("ADA (Van)", 0),
        accessible_ev=stalls.get("Electric Veh. (ADA)", 0),
        ev_stalls=stalls.get("Electric Vehicle", 0) + stalls.get("Electric Veh. (ADA)", 0),
        ev_ports=EvPorts(**ev) if ev else None,
        levels=uci_lot.get("levels"),
        breakdown=dict(sorted(stalls.items(), key=lambda kv: -kv[1])),
    )


def _other_spaces(lot: dict) -> Spaces | None:
    if lot.get("capacity"):
        return Spaces(source="osm", total=lot["capacity"], accessible=ada_minimum(lot["capacity"]), accessible_is_minimum=True)
    if lot.get("outline") and lot.get("parking") != "multi-storey":
        estimate = round(_area_m2(lot["outline"]) / SQ_M_PER_SPACE)
        if estimate >= 3:
            return Spaces(source="estimate", total=estimate, accessible=ada_minimum(estimate), accessible_is_minimum=True)
    return None


PAY_ALIASES = {"arc": "lot arc"}
MERGE_GAP_M = 12  # pieces of one lot: same name and rules, outlines this close


def _abbr(name: str) -> str | None:
    """'Mesa Parking Structure (MPS)' -> 'mps'; 'Anteater Parking Structure' -> 'aps'."""
    if m := re.search(r"\(([A-Z]{2,5})\)$", name):
        return m.group(1).lower()
    if name.endswith("Parking Structure"):
        return "".join(w[0] for w in name.split()[:-2]).lower() + "ps"
    return None


def _attach_pay_stations(lots: list[dict], stations: list[dict]) -> None:
    """Mark lots that have a UCI permit dispenser, Pay-by-Space machine or ParkbyPlate area."""
    by_key = {}
    for lot in lots:
        by_key.setdefault(_key(lot["name"]), lot)
        if abbr := _abbr(lot["name"]):
            by_key.setdefault(abbr, lot)
    for station in stations:
        key = _key(station["lot"])
        lot = by_key.get(PAY_ALIASES.get(key, key))
        if lot is None or _meters_apart(lot, station) > 400:
            continue  # e.g. "EP": no lot by that name, and we don't guess
        if station["kind"] not in lot.setdefault("pay", []):
            lot["pay"].append(station["kind"])


def _gap_m(a: list, b: list) -> float:
    """Smallest distance between two outlines' vertices and edges (m); rings of [lat, lon]."""
    lat0 = math.radians(a[0][0][0])
    xy = lambda ring: [(lon * 111_320 * math.cos(lat0), lat * 111_320) for lat, lon in ring]

    def point_seg(p, s1, s2):
        dx, dy = s2[0] - s1[0], s2[1] - s1[1]
        t = 0 if dx == dy == 0 else max(0, min(1, ((p[0] - s1[0]) * dx + (p[1] - s1[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - s1[0] - t * dx, p[1] - s1[1] - t * dy)

    best = math.inf
    for ra in map(xy, a):
        for rb in map(xy, b):
            for pts, ring in ((ra, rb), (rb, ra)):
                for p in pts:
                    for s1, s2 in zip(ring, ring[1:] + ring[:1]):
                        best = min(best, point_seg(p, s1, s2))
    return best


def _merge_pieces(lots: list[dict]) -> list[dict]:
    """OSM often maps one lot as several touching areas ("Free parking by Sepulveda Vista
    Point" x3). Combine free/limited pieces with the same name and rules that touch."""
    groups: dict[tuple, list[dict]] = {}
    for lot in lots:
        if lot["category"] in ("free", "limited") and lot.get("outline"):
            groups.setdefault((lot["name"], lot["category"], lot.get("restriction"), lot.get("time_limit")), []).append(lot)
    drop = set()
    for pieces in groups.values():
        if len(pieces) < 2:
            continue
        parent = list(range(len(pieces)))
        find = lambda i: i if parent[i] == i else find(parent[i])
        for i in range(len(pieces)):
            for j in range(i + 1, len(pieces)):
                if _meters_apart(pieces[i], pieces[j]) < 400 and _gap_m(pieces[i]["outline"], pieces[j]["outline"]) <= MERGE_GAP_M:
                    parent[find(j)] = find(i)
        clusters: dict[int, list[dict]] = {}
        for i, lot in enumerate(pieces):
            clusters.setdefault(find(i), []).append(lot)
        for cluster in clusters.values():
            if len(cluster) < 2:
                continue
            cluster.sort(key=lambda lot: lot["id"])  # keep the first id, so its reviews stay
            keep = cluster[0]
            weights = [max(_area_m2(lot["outline"]), 1) for lot in cluster]
            keep["lat"] = round(sum(l["lat"] * w for l, w in zip(cluster, weights)) / sum(weights), 6)
            keep["lon"] = round(sum(l["lon"] * w for l, w in zip(cluster, weights)) / sum(weights), 6)
            keep["outline"] = [ring for lot in cluster for ring in lot["outline"]]
            caps = [lot.get("capacity") for lot in cluster]
            keep["capacity"] = sum(caps) if all(caps) else None
            keep["serves"] = list(dict.fromkeys(s for lot in cluster for s in lot.get("serves", [])))
            keep["merged_from"] = len(cluster)
            drop.update(lot["id"] for lot in cluster[1:])
    return [lot for lot in lots if lot["id"] not in drop]


def _merge_uci_lots(lots: list[dict], uci_lots: dict) -> None:
    """Attach UCI's stall tables to our lots; add UCI lots we don't have as map points."""
    by_key = {_key(lot["name"]): lot for lot in lots}
    for name, uci_lot in uci_lots["lots"].items():
        if SKIP_UCI_LOTS.search(name):
            continue
        lot = by_key.get(_key(name))
        if lot is None:
            # UCI splits some lots (16AE/16AW) that the map has as one ("Lot 16A").
            # Most specific name wins: "Lot 16AE" belongs to "Lot 16A", not "Lot 16".
            candidates = [
                (k, l) for k, l in by_key.items()
                if k.startswith("lot ") and _key(name).startswith(k) and _meters_apart(l, uci_lot) < 250
            ]
            parent = max(candidates, key=lambda kl: len(kl[0]))[1] if candidates else None
            if parent is not None:
                parent.setdefault("_uci_parts", []).append(uci_lot)
                continue
            lot = {
                "id": f"uci/{uci_lot['uci_map_id']}",
                "name": name,
                "category": "permit",
                "lat": uci_lot["lat"],
                "lon": uci_lot["lon"],
                "outline": [],
                "serves": [],
                "operator": "University of California, Irvine - Transportation Services",
                "inferred": None,
                "parking": "multi-storey" if "structure" in name.lower() else "surface",
            }
            lots.append(lot)
            by_key[_key(name)] = lot
        lot.setdefault("_uci_parts", []).append(uci_lot)


@cache
def _load() -> ParkingResponse:
    data = json.loads(DATA_FILE.read_text())
    uci = json.loads(PERMITS_FILE.read_text())
    uci_map = json.loads(UCI_LOTS_FILE.read_text()) if UCI_LOTS_FILE.exists() else None
    staff_lots = set()
    data["lots"] = _merge_pieces(data["lots"])
    for lot in data["lots"]:
        lot["pay"] = ["fee"] if lot["category"] == "paid" else []
    if uci_map:
        _merge_uci_lots(data["lots"], uci_map)
        _attach_pay_stations(data["lots"], uci_map.get("pay_stations", []))
        # UCI's staff layer sometimes drops the "Lot" prefix ("EHS" vs "Lot EHS").
        staff_lots = {_key(n) for n in uci_map["faculty_staff_lots"]} | {
            _key(f"Lot {n}") for n in uci_map["faculty_staff_lots"] if not n.lower().startswith("lot ")
        }
        ev_by_key = {_key(n): ports for n, ports in uci_map["ev_charging"].items()}
        accessible_by_key = {_key(n): notes for n, notes in uci_map.get("accessible_locations", {}).items()}
        data["uci_source"] = uci_map["source_url"]
    for lot in data["lots"]:
        parts = lot.pop("_uci_parts", None)
        if parts:
            stalls: dict[str, int] = {}
            for part in parts:
                for kind, qty in part["stalls"].items():
                    stalls[kind] = stalls.get(kind, 0) + qty
            merged = {"stalls": stalls, "levels": parts[0].get("levels")}
            lot["spaces"] = _uci_spaces(merged, ev_by_key.get(_key(lot["name"])))
            notes = []
            for name in [lot["name"], *(part["name"] for part in parts)]:
                for note in accessible_by_key.get(_key(name), []):
                    if note not in notes:
                        notes.append(note)
            lot["spaces"].accessible_where = notes
            lot["uci_map_id"] = parts[0]["uci_map_id"]
            lot["operator"] = lot.get("operator") or "University of California, Irvine - Transportation Services"
            if lot.get("inferred") and "UCI's campus" in lot["inferred"]:
                lot["inferred"] = None  # confirmed by UCI's own map
        else:
            lot["spaces"] = _other_spaces(lot)
        # Remove generated OSM type labels, preserving name qualifiers such as (AIRB).
        lot["serves"] = [re.sub(r"\s+\([a-z][a-z ]*\)$", "", name) for name in lot.get("serves", [])]
        assigned = uci["lots"].get(lot["name"], {})
        on_campus = lot["category"] == "permit" and "UCI's campus" in (lot.get("inferred") or "")
        # "uci" = a UCI Transportation lot, where UCI's permit and visitor rules apply.
        # Untagged lots inside the campus boundary only count if they carry a UCI lot
        # number ("Lot 15A"); the rest are mostly housing (UCI: housing permission "is
        # valid only in your housing community") or department parking.
        numbered = bool(LOT_NUMBER.match(lot["name"]))
        housing = not assigned and bool(HOUSING_NAMES.search(lot["name"]))
        lot["uci"] = not housing and (lot.get("operator") in UCI_OPERATORS or bool(assigned) or (on_campus and numbered))
        if housing:
            lot["inferred"] = (
                "Housing community parking: UCI says housing parking is valid only for that "
                "community's residents, so commuter permits don't apply here."
            )
        elif on_campus and not numbered:
            lot["inferred"] = (
                "Inside UCI's campus but not a numbered UCI lot: likely housing or department "
                "parking. UCI commuter permits aren't valid here; residents and visitors follow "
                "that community's rules."
            )
        lot["permits"] = [{"code": code, **uci["permits"][code]} for code in assigned.get("permits", [])]
        lot["permit_note"] = assigned.get("note")
        # Faculty & staff lots (UCI's map), unless student zone permits are assigned there too.
        student_zone = any(p["code"][0] in "SP" for p in lot["permits"])
        if _key(lot["name"]) in staff_lots and lot["uci"] and not student_zone:
            lot["category"] = "staff"
    data["permit_info"] = {
        key: uci[key]
        for key in ("academic_year", "retrieved", "sources", "visitor_rates", "visitor_hours",
                    "holdable_permits", "permit_rules_source")
    }
    data["permit_info"]["permits"] = {code: {"code": code, **info} for code, info in uci["permits"].items()}
    return ParkingResponse.model_validate(data)


@router.get("", response_model=ParkingResponse, dependencies=[Depends(get_current_user)])
def parking_lots() -> ParkingResponse:
    return _load()


@router.get("/permits", response_model=PermitInfo, dependencies=[Depends(get_current_user)])
def permit_catalogue() -> PermitInfo:
    """Just the UCI permit catalogue (names, prices, which ones a person can hold), for settings."""
    return _load().permit_info
