"""Refresh app/data/parking_lots.json from OpenStreetMap.

Pulls every parking area in a box around UC Irvine via the Overpass API, sorts
each into a category from its tags, and keeps its outline so the map can shade it:

    free       fee=no, open to anyone
    customers  fee=no, access=customers
    paid       fee=yes (may also accept permits)
    permit     access=permit, or run by UCI Transportation with no access tag

Private lots (apartments etc.) and lots with no useful tags are skipped.
Unnamed free lots are labelled by reverse-geocoding with Nominatim (1 req/s).

    cd backend && .venv/bin/python scripts/fetch_parking.py

Data (c) OpenStreetMap contributors, ODbL.
"""

import json
import time
from pathlib import Path

import httpx  # dev dependency; bundles CA certs, unlike some stdlib Python installs

# south, west, north, east
UCI_BBOX = (33.630, -117.860, 33.660, -117.815)
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "parking_lots.json"
USER_AGENT = "PeterParker/0.1 (UCI parking finder)"
UCI_OPERATOR = "University of California, Irvine - Transportation Services"

OVERPASS_QUERY = """
[out:json][timeout:90];
nwr["amenity"="parking"]({s},{w},{n},{e});
out geom;
"""

client = httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=90)


def fetch_elements() -> list[dict]:
    s, w, n, e = UCI_BBOX
    res = client.post(
        "https://overpass-api.de/api/interpreter",
        data={"data": OVERPASS_QUERY.format(s=s, w=w, n=n, e=e)},
    )
    res.raise_for_status()
    return res.json()["elements"]


def classify(tags: dict) -> tuple[str | None, bool]:
    """Return (category, inferred)."""
    access, fee = tags.get("access"), tags.get("fee")
    if access == "private":
        return None, False
    if fee == "no":
        return ("customers" if access == "customers" else "free"), False
    if fee == "yes":
        return "paid", False
    if access == "permit":
        return "permit", False
    if tags.get("operator") == UCI_OPERATOR:
        return "permit", True
    return None, False


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


def _pts(geometry: list[dict]) -> list[list[float]]:
    return [[round(p["lat"], 6), round(p["lon"], 6)] for p in geometry]


def outline(el: dict) -> list[list[list[float]]]:
    if el["type"] == "way":
        return [_pts(el.get("geometry", []))]
    if el["type"] == "relation":
        outers = [_pts(m["geometry"]) for m in el.get("members", [])
                  if m.get("role") == "outer" and m.get("geometry")]
        return _stitch(outers)
    return []


def center(el: dict, rings: list) -> dict:
    if el["type"] == "node":
        return {"lat": round(el["lat"], 6), "lon": round(el["lon"], 6)}
    b = el["bounds"]
    return {"lat": round((b["minlat"] + b["maxlat"]) / 2, 6),
            "lon": round((b["minlon"] + b["maxlon"]) / 2, 6)}


def describe_location(lat: float, lon: float) -> str:
    res = client.get(
        "https://nominatim.openstreetmap.org/reverse",
        params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18, "addressdetails": 1},
    )
    res.raise_for_status()
    addr = res.json().get("address", {})
    for key in ("amenity", "shop", "building", "leisure", "retail", "commercial"):
        if addr.get(key):
            return f"Near {addr[key]}"
    street = " ".join(filter(None, [addr.get("house_number"), addr.get("road")]))
    return f"Near {street}" if street else "Parking area"


FALLBACK_NAMES = {"permit": "Permit parking", "paid": "Paid parking"}


def main() -> None:
    lots = []
    for el in fetch_elements():
        tags = el.get("tags", {})
        category, inferred = classify(tags)
        if category is None:
            continue
        rings = outline(el)
        c = center(el, rings)
        name = tags.get("name")
        if not name and category in FALLBACK_NAMES:
            name = FALLBACK_NAMES[category]
        if not name:
            name = describe_location(c["lat"], c["lon"])
            time.sleep(1)
        capacity = tags.get("capacity", "").replace(",", "")
        lots.append(
            {
                "id": f"{el['type']}/{el['id']}",
                "name": name,
                "category": category,
                "inferred": inferred,
                "permit_accepted": category == "paid" and tags.get("access") == "permit",
                "lat": c["lat"],
                "lon": c["lon"],
                "outline": rings,
                "access": tags.get("access"),
                "capacity": int(capacity) if capacity.isdigit() else None,
                "parking": tags.get("parking"),
                "operator": tags.get("operator"),
                "opening_hours": tags.get("opening_hours"),
            }
        )
    lots.sort(key=lambda lot: (lot["category"], lot["name"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"source": "OpenStreetMap contributors (ODbL)", "lots": lots}, separators=(",", ":"))
        + "\n"
    )
    counts = {k: sum(lot["category"] == k for lot in lots) for k in ("free", "customers", "permit", "paid")}
    print(f"Wrote {len(lots)} lots to {OUT}: {counts}")


if __name__ == "__main__":
    main()
