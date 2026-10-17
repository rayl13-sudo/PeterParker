"""Refresh app/data/parking_lots.json from OpenStreetMap.

Pulls every parking area in a box around UC Irvine via the Overpass API, sorts
each into a category, keeps its outline so the map can shade it, and lists the
named places next to it (what the lot is for):

    free     fee=no and open to anyone
    permit   access=permit, run by UCI Transportation, or untagged on UCI's campus
    paid     fee=yes
    limited  might get you ticketed or towed: private, customers-only, University
             Town Center (time limits), or untagged off campus

    cd backend && .venv/bin/python scripts/fetch_parking.py

Data (c) OpenStreetMap contributors, ODbL.
"""

import json
import math
import re
import time
from pathlib import Path

import httpx  # dev dependency; bundles CA certs, unlike some stdlib Python installs

# south, west, north, east
UCI_BBOX = (33.630, -117.860, 33.660, -117.815)
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "parking_lots.json"
# Named buildings and places, searchable on the map as destinations.
PLACES_OUT = OUT.with_name("places.json")
USER_AGENT = "PeterParker/0.1 (UCI parking finder)"
UCI_OPERATORS = {
    "University of California, Irvine - Transportation Services",
    "University of California, Irvine",
    "UC Irvine",
}
UCI_CAMPUS_WAY = 35154092  # "University of California, Irvine", amenity=university
UTC_RETAIL_WAY = 171550908  # "University Center", landuse=retail (University Town Center)
NEARBY_METERS = 120
UTC_RULES = {
    "time_limit": "2 hours",
    "warning": (
        "University Town Center limits shopper parking to mostly 2 hours; some spaces allow "
        "45 minutes or 3 hours. Students who park here and walk to campus have been towed. "
        "Check the posted signs."
    ),
    "source": "https://newuniversity.org/2016/02/23/utc-implements-2-hour-parking-policy/",
}

PARKING_QUERY = """
[out:json][timeout:120];
(
  nwr["amenity"="parking"]({bbox});
  way(id:{campus},{utc});
);
out geom;
"""

# Named places that tell you what a lot is for.
PLACES_QUERY = """
[out:json][timeout:120];
(
  nwr["name"]["shop"]({bbox});
  nwr["name"]["amenity"]["amenity"!~"^(parking|parking_entrance|parking_space|bench|waste_basket|bicycle_parking|bicycle_rental|bus_station|shelter|parcel_locker|vending_machine|charging_station|drinking_water|post_box|toilets|fountain|bbq|recycling|telephone)$"]({bbox});
  nwr["name"]["office"]({bbox});
  nwr["name"]["healthcare"]({bbox});
  nwr["name"]["leisure"]({bbox});
  nwr["name"]["tourism"]({bbox});
  nwr["name"]["building"]({bbox});
  nwr["name"]["landuse"~"^(residential|retail|commercial)$"]({bbox});
);
out center tags;
"""

client = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=180)


OVERPASS_SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def overpass(query: str) -> list[dict]:
    """Run an Overpass query, retrying on busy/overloaded public servers."""
    s, w, n, e = UCI_BBOX
    q = query.format(bbox=f"{s},{w},{n},{e}", campus=UCI_CAMPUS_WAY, utc=UTC_RETAIL_WAY)
    last_error = None
    for attempt in range(6):
        url = OVERPASS_SERVERS[attempt % len(OVERPASS_SERVERS)]
        try:
            res = client.post(url, data={"data": q})
            res.raise_for_status()
            return res.json()["elements"]
        except (httpx.HTTPError, ValueError) as exc:
            last_error = exc
            print(f"Overpass attempt {attempt + 1} failed ({url}): {exc}; retrying")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("Overpass API unavailable") from last_error


# ---------- Geometry ----------

def _pts(geometry: list[dict]) -> list[list[float]]:
    return [[round(p["lat"], 6), round(p["lon"], 6)] for p in geometry]


def _stitch(ways: list[list[list[float]]]) -> list[list[list[float]]]:
    """Join multipolygon member ways that share endpoints into closed rings."""
    rings, pending = [], [w[:] for w in ways if w]
    while pending:
        ring = pending.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, w in enumerate(pending):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[-2::-1]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[:0:-1] + ring
                else:
                    continue
                pending.pop(i)
                changed = True
                break
        rings.append(ring)
    return rings


def outline(el: dict) -> list[list[list[float]]]:
    if el["type"] == "way":
        return [_pts(el.get("geometry", []))]
    if el["type"] == "relation":
        outers = [_pts(m["geometry"]) for m in el.get("members", [])
                  if m.get("role") == "outer" and m.get("geometry")]
        return _stitch(outers)
    return []  # parking mapped as a single point


def center(el: dict) -> tuple[float, float]:
    if el["type"] == "node":
        return el["lat"], el["lon"]
    if "center" in el:
        return el["center"]["lat"], el["center"]["lon"]
    b = el["bounds"]
    return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2


def inside(lat: float, lon: float, ring: list[list[float]]) -> bool:
    hit = False
    for (y1, x1), (y2, x2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    dy = (a[0] - b[0]) * 111_320
    dx = (a[1] - b[1]) * 111_320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)


# ---------- What a lot is for ----------

# Higher = better description of who a lot serves.
PLACE_KINDS = [
    ("shop", 5), ("healthcare", 5), ("office", 4), ("tourism", 4),
    ("amenity", 4), ("leisure", 3), ("landuse", 2), ("building", 1),
]


def place_label(tags: dict) -> tuple[str, int] | None:
    if tags.get("building") == "parking" or "parking" in tags.get("amenity", ""):
        return None  # another parking lot isn't what a lot is "for"
    for key, rank in PLACE_KINDS:
        if key in tags:
            kind = tags[key]
            if kind in ("yes", "retail", "commercial", "university"):
                return tags["name"], rank
            if key == "landuse" and kind == "residential":
                return f"{tags['name']} (residential)", rank
            return f"{tags['name']} ({kind.replace('_', ' ')})", rank
    return None


def nearby_places(pos: tuple[float, float], places: list[dict], limit: int = 3) -> list[str]:
    scored = []
    for p in places:
        d = meters(pos, p["pos"])
        if d <= NEARBY_METERS:
            scored.append((-p["rank"], d, p["label"]))
    seen, out = set(), []
    for _, _, label in sorted(scored):
        if label not in seen:
            seen.add(label)
            out.append(label)
        if len(out) == limit:
            break
    return out


# ---------- Categories ----------

def classify(tags: dict, on_campus: bool, at_utc: bool) -> dict:
    access, fee = tags.get("access"), tags.get("fee")
    if at_utc:
        return {"category": "limited", "restriction": "Shopping center customers only", **UTC_RULES, "utc": True}
    if access == "private":
        return {"category": "limited", "restriction": "Private: residents, tenants or staff only"}
    if fee == "yes":
        return {"category": "paid"}
    if access == "permit":
        return {"category": "permit"}
    if access in ("customers", "destination"):
        return {"category": "limited", "restriction": "Customers/visitors only"}
    if tags.get("maxstay"):
        return {"category": "limited", "restriction": "Time-limited", "time_limit": tags["maxstay"]}
    if fee == "no":
        return {"category": "free"}
    if tags.get("operator") in UCI_OPERATORS:
        return {"category": "permit", "inferred": "Run by UCI Transportation; permit assumed; not tagged in OpenStreetMap"}
    if on_campus:
        return {"category": "permit", "inferred": "On UCI's campus, where lots require a permit; not tagged in OpenStreetMap"}
    return {"category": "limited", "restriction": "Restrictions not posted in OpenStreetMap; may be private"}


def describe_address(lat: float, lon: float) -> tuple[str | None, str | None]:
    """(place the lot belongs to, street) from Nominatim, for lots with no named neighbor."""
    res = client.get(
        "https://nominatim.openstreetmap.org/reverse",
        params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18, "addressdetails": 1},
    )
    res.raise_for_status()
    addr = res.json().get("address", {})
    place = next((addr[k] for k in ("amenity", "shop", "building", "leisure", "office", "residential",
                                     "neighbourhood", "quarter") if addr.get(k)), None)
    street = " ".join(filter(None, [addr.get("house_number"), addr.get("road")])) or None
    time.sleep(1)  # Nominatim usage policy: max 1 request/second
    return place, street


FALLBACK_NAMES = {"permit": "Permit parking", "paid": "Paid parking", "free": "Free parking", "limited": "Parking"}


def main() -> None:
    elements = overpass(PARKING_QUERY)
    campus = next(_pts(e["geometry"]) for e in elements if e["type"] == "way" and e["id"] == UCI_CAMPUS_WAY)
    utc = next(_pts(e["geometry"]) for e in elements if e["type"] == "way" and e["id"] == UTC_RETAIL_WAY)

    places = []
    destinations = {}  # (name, ~50 m cell) -> place, so one building isn't listed twice
    for el in overpass(PLACES_QUERY):
        tags = el.get("tags", {})
        label = place_label(tags)
        if not label:
            continue
        pos = center(el)
        places.append({"label": label[0], "rank": label[1], "pos": pos})
        kind = label[0][len(tags["name"]):].strip(" ()") or None
        key = (tags["name"].lower(), round(pos[0] * 2000), round(pos[1] * 2000))
        destinations.setdefault(key, {
            "id": f"{el['type']}/{el['id']}",  # stable OpenStreetMap id (reviews attach to it)
            "name": re.sub(r"\s+\([a-z][a-z ]*\)$", "", tags["name"]), "kind": kind, "lat": round(pos[0], 6), "lon": round(pos[1], 6),
        })

    lots = []
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("amenity") != "parking":
            continue
        lat, lon = center(el)
        info = classify(tags, inside(lat, lon, campus), inside(lat, lon, utc))
        serves = nearby_places((lat, lon), places)
        street = None
        if not serves:
            place, street = describe_address(lat, lon)
            if place:
                serves = [place]
        name = tags.get("name")
        serves = [place for place in serves if place.split(" (")[0] != name]
        if not name:
            base = FALLBACK_NAMES[info["category"]]
            if serves:
                name = f"{base} by {serves[0].split(' (')[0]}"
            elif street:
                name = f"{base} on {street}"
            else:
                name = base
        capacity = tags.get("capacity", "").replace(",", "")
        lots.append(
            {
                "id": f"{el['type']}/{el['id']}",
                "name": name,
                "category": info["category"],
                "inferred": info.get("inferred"),
                "permit_accepted": info["category"] == "paid" and tags.get("access") == "permit",
                "restriction": info.get("restriction"),
                "time_limit": info.get("time_limit"),
                "warning": info.get("warning"),
                "warning_source": info.get("source"),
                "utc": info.get("utc", False),
                "serves": [re.sub(r"\s+\([a-z][a-z ]*\)$", "", place) for place in serves],
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "outline": outline(el),
                "access": tags.get("access"),
                "capacity": int(capacity) if capacity.isdigit() else None,
                "parking": tags.get("parking"),
                "operator": tags.get("operator"),
                "opening_hours": tags.get("opening_hours"),
            }
        )
    lots.sort(key=lambda lot: (lot["category"], lot["name"]))
    OUT.write_text(
        json.dumps({"source": "OpenStreetMap contributors (ODbL)", "lots": lots}, separators=(",", ":")) + "\n"
    )
    place_list = sorted(destinations.values(), key=lambda p: p["name"].lower())
    PLACES_OUT.write_text(
        json.dumps({"source": "OpenStreetMap contributors (ODbL)", "places": place_list}, separators=(",", ":")) + "\n"
    )
    print(f"Wrote {len(place_list)} places to {PLACES_OUT}")
    counts = {k: sum(lot["category"] == k for lot in lots) for k in ("free", "permit", "paid", "limited")}
    print(f"Wrote {len(lots)} lots to {OUT}: {counts}, {sum(lot['utc'] for lot in lots)} at UTC")


if __name__ == "__main__":
    main()
