import json
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

UCI_OPERATORS = {
    "University of California, Irvine - Transportation Services",
    "University of California, Irvine",
    "UC Irvine",
}

Category = Literal["free", "permit", "paid", "limited"]


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


class ParkingResponse(BaseModel):
    source: str
    lots: list[ParkingLot]
    permit_info: PermitInfo


@cache
def _load() -> ParkingResponse:
    data = json.loads(DATA_FILE.read_text())
    uci = json.loads(PERMITS_FILE.read_text())
    for lot in data["lots"]:
        assigned = uci["lots"].get(lot["name"], {})
        on_campus = lot["category"] == "permit" and "UCI's campus" in (lot.get("inferred") or "")
        lot["uci"] = lot.get("operator") in UCI_OPERATORS or bool(assigned) or on_campus
        lot["permits"] = [{"code": code, **uci["permits"][code]} for code in assigned.get("permits", [])]
        lot["permit_note"] = assigned.get("note")
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
