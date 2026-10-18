"""Destinations to search for, and driving/walking routes between points.

Routes come from an OSRM server (settings.routing_url, by default the free FOSSGIS
server at routing.openstreetmap.de). The browser asks us rather than the server
directly so the provider can change without touching the frontend.
"""

import json
import ssl
from functools import cache, lru_cache
from pathlib import Path
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import certifi
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.config import settings
from app.security import get_current_user

router = APIRouter(tags=["navigation"], dependencies=[Depends(get_current_user)])

PLACES_FILE = Path(__file__).resolve().parents[2] / "data" / "places.json"
USER_AGENT = "PeterParker/0.1 (UCI parking finder)"


# ---------- Places ----------

class Place(BaseModel):
    id: str  # OpenStreetMap id, e.g. "way/123"; reviews attach to it
    name: str
    kind: str | None = None
    lat: float
    lon: float
    # Footprint of the place (or of the building it's in), rings of [lat, lon]; clicking
    # inside it on the map picks this place. Empty for big areas and unmapped buildings.
    outline: list[list[list[float]]] = []


class PlacesResponse(BaseModel):
    source: str
    places: list[Place]


@cache
def _places() -> PlacesResponse:
    return PlacesResponse.model_validate(json.loads(PLACES_FILE.read_text()))


@router.get("/places", response_model=PlacesResponse)
def places() -> PlacesResponse:
    return _places()


# ---------- Routes ----------

class Step(BaseModel):
    instruction: str
    distance: float  # meters
    duration: float  # seconds
    lat: float
    lon: float


class RouteResponse(BaseModel):
    mode: Literal["car", "foot"]
    distance: float  # meters
    duration: float  # seconds
    path: list[list[float]]  # [lat, lon] points
    steps: list[Step]


COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
ORDINALS = {1: "1st", 2: "2nd", 3: "3rd"}


def _onto(name: str) -> str:
    return f" onto {name}" if name else ""


def instruction(step: dict, mode: str) -> str:
    """Plain-English text for an OSRM step (OSRM itself only returns maneuver codes)."""
    m = step["maneuver"]
    kind, modifier, name = m["type"], m.get("modifier", ""), step.get("name", "")
    if kind == "depart":
        heading = COMPASS[round(m.get("bearing_after", 0) / 45) % 8]
        verb = "Walk" if mode == "foot" else "Head"
        return f"{verb} {heading}" + (f" on {name}" if name else "")
    if kind == "arrive":
        side = f" on the {modifier}" if modifier in ("left", "right") else ""
        return f"Arrive at your destination{side}"
    if kind in ("roundabout", "rotary", "roundabout turn"):
        exit_no = m.get("exit")
        exit_text = f"take the {ORDINALS.get(exit_no, f'{exit_no}th')} exit" if exit_no else "continue"
        return f"At the roundabout, {exit_text}" + _onto(name)
    if kind == "new name":
        return f"Continue onto {name}" if name else "Continue straight"
    if kind == "end of road":
        return f"At the end of the road, turn {modifier}" + _onto(name)
    if kind == "fork":
        return f"Keep {modifier} at the fork" + _onto(name)
    if kind in ("on ramp", "off ramp"):
        return f"Take the ramp on the {modifier}" + _onto(name) if modifier else "Take the ramp" + _onto(name)
    if kind == "merge":
        return "Merge" + (f" {modifier}" if modifier else "") + _onto(name)
    if modifier == "uturn":
        return "Make a U-turn" + _onto(name)
    if modifier == "straight" or kind == "continue":
        return "Continue straight" + _onto(name)
    if modifier:
        return f"Turn {modifier}" + _onto(name)
    return "Continue" + _onto(name)


def _fetch(url: str) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(req, timeout=20, context=ssl.create_default_context(cafile=certifi.where())) as res:
            return json.load(res)
    except HTTPError as exc:
        if exc.code == 400:
            # OSRM answers 400 for points it can't snap to a road or path.
            raise HTTPException(422, "No route found between those points") from exc
        raise HTTPException(502, "The routing service is unavailable. Try again shortly.") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(502, "The routing service is unavailable. Try again shortly.") from exc


@lru_cache(maxsize=256)
def _route(mode: str, from_lat: float, from_lon: float, to_lat: float, to_lon: float) -> RouteResponse:
    url = (
        f"{settings.routing_url.rstrip('/')}/routed-{mode}/route/v1/driving/"
        f"{from_lon},{from_lat};{to_lon},{to_lat}?overview=full&geometries=geojson&steps=true"
    )
    data = _fetch(url)
    if data.get("code") != "Ok" or not data.get("routes"):
        raise HTTPException(422, "No route found between those points")
    route = data["routes"][0]
    steps = [
        Step(
            instruction=instruction(step, mode),
            distance=step["distance"],
            duration=step["duration"],
            lat=step["maneuver"]["location"][1],
            lon=step["maneuver"]["location"][0],
        )
        for leg in route["legs"]
        for step in leg["steps"]
    ]
    return RouteResponse(
        mode=mode,
        distance=route["distance"],
        duration=route["duration"],
        path=[[lat, lon] for lon, lat in route["geometry"]["coordinates"]],
        steps=steps,
    )


@router.get("/route", response_model=RouteResponse)
def route(
    mode: Literal["car", "foot"],
    from_lat: float = Query(ge=-90, le=90),
    from_lon: float = Query(ge=-180, le=180),
    to_lat: float = Query(ge=-90, le=90),
    to_lon: float = Query(ge=-180, le=180),
) -> RouteResponse:
    # Round to ~1 m so repeated requests hit the cache.
    return _route(mode, *(round(v, 5) for v in (from_lat, from_lon, to_lat, to_lon)))
