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
    if uci_map:
        _merge_uci_lots(data["lots"], uci_map)
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
