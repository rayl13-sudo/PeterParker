"""Add building footprints to app/data/places.json, so a place can be picked by clicking it.

Places that are OpenStreetMap areas (a hall, a park) get their own outline; places mapped as a
point (a cafe, an office) get the outline of the building they're inside. Huge areas such as
whole neighborhoods are left without one, so they don't swallow every click.

    cd backend && .venv/bin/python scripts/fetch_place_outlines.py
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_parking import PLACES_OUT, inside, outline, overpass  # noqa: E402

MAX_AREA_M2 = 80_000  # bigger than the ARC or Langson Library, smaller than a neighborhood

BUILDINGS_QUERY = """
[out:json][timeout:180];
way["building"]({bbox});
out geom;
"""


def area_m2(rings: list) -> float:
    total = 0.0
    for ring in rings:
        lat0 = math.radians(ring[0][0])
        pts = [(lon * 111_320 * math.cos(lat0), lat * 111_320) for lat, lon in ring]
        total += abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2
    return total


def rounded(rings: list) -> list:
    return [[[round(lat, 6), round(lon, 6)] for lat, lon in ring] for ring in rings]


def main() -> None:
    data = json.loads(PLACES_OUT.read_text())
    places = data["places"]

    ids = {"way": [], "relation": []}
    for place in places:
        kind, num = place["id"].split("/")
        if kind in ids:
            ids[kind].append(num)
    query = "[out:json][timeout:180];(" + "".join(
        f"{kind}(id:{','.join(nums)});" for kind, nums in ids.items() if nums
    ) + ");out geom;"
    own = {f"{el['type']}/{el['id']}": outline(el) for el in overpass(query)}

    buildings = []
    for el in overpass(BUILDINGS_QUERY):
        rings = outline(el)
        if rings and rings[0]:
            buildings.append((area_m2(rings), rings))
    buildings.sort(key=lambda b: b[0])  # smallest first: the building actually around a point

    with_outline = 0
    for place in places:
        rings = own.get(place["id"])
        if not rings:
            rings = next((r for _, r in buildings if any(inside(place["lat"], place["lon"], ring) for ring in r)), None)
        if rings and area_m2(rings) <= MAX_AREA_M2:
            place["outline"] = rounded(rings)
            with_outline += 1
        else:
            place.pop("outline", None)

    PLACES_OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n")
    print(f"{with_outline} of {len(places)} places now have a clickable outline ({len(buildings)} buildings checked)")


if __name__ == "__main__":
    main()
