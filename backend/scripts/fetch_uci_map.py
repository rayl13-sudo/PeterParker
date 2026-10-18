"""Refresh app/data/uci_lots.json from UCI's official campus map (map.uci.edu).

UCI's interactive map (concept3d, map 463) publishes, for every UCI parking lot
and structure, a stall table ("Qty / Parking Stall Type": General, ADA (Standard),
ADA (Van), "AR" Reserved, "P" Preferred, Electric Vehicle, ...), the number of
levels, and separate layers for EV charging ports and Faculty & Staff parking.

    cd backend && .venv/bin/python scripts/fetch_uci_map.py

The key below is the public key UCI's map page itself uses to load this data.
"""

import html
import json
import re
from datetime import date
from pathlib import Path

import httpx

API = "https://api.concept3d.com"
MAP_ID = 463
PUBLIC_KEY = "0001085cc708b9cef47080f064612ca5"
OUT = Path(__file__).resolve().parent.parent / "app" / "data" / "uci_lots.json"

# Layers on UCI's map ("Parking and Transportation" -> ...)
PARKING = 8403  # every lot and structure, with its stall table
EV_CHARGING = 36405  # charging ports per location
FACULTY_STAFF = 36952  # "Faculty, Staff & Visitor Parking"
ACCESSIBLE = 36871  # "Accessible Parking Stalls"; one sub-layer per lot, describing where its ADA stalls are
DISPENSERS = 35849  # "Parking Permit Dispensers": "MPS Dispenser", "Lot 16 Pay-by-Space Dispenser", ...
PARKBYPLATE = 55161  # "ParkbyPlate(TM) Areas": pay by license plate, one location per lot

client = httpx.Client(headers={"User-Agent": "PeterParker/0.1 (UCI parking finder)"}, timeout=60)


def get(path: str, **params) -> object:
    res = client.get(f"{API}/{path}", params={"map": MAP_ID, "key": PUBLIC_KEY, **params})
    res.raise_for_status()
    return res.json()


def clean_name(name: str) -> str:
    """'Lot  1' -> 'Lot 1'; 'Faculty & Staff- Lot 6A' -> 'Lot 6A'."""
    name = re.sub(r"^Faculty & Staff-\s*", "", name)
    return re.sub(r"\s+", " ", name).strip()


def text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def stall_table(description: str) -> dict[str, int]:
    """Rows of (qty, stall type) from the lot's 'Qty | Parking Stall Type' tables."""
    stalls: dict[str, int] = {}
    for row in re.findall(r"<tr>(.*?)</tr>", description, re.S):
        cells = [text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if len(cells) == 2 and re.fullmatch(r"[\d,]+", cells[0]):
            kind = cells[1].replace('"', "").strip()
            stalls[kind] = stalls.get(kind, 0) + int(cells[0].replace(",", ""))
    return stalls


def ev_ports(description: str) -> dict[str, int]:
    """'One Level 2 Charging Port', '10 Level 1 Ports 12 Level 2 Ports' -> {'level1': .., 'level2': ..}."""
    t = text(description).replace("One ", "1 ")
    ports = {"level1": 0, "level2": 0}
    for qty, level in re.findall(r"(\d+)\s+Level\s+([12])", t):
        ports[f"level{level}"] += int(qty)
    return ports


def main() -> None:
    everything = get("locations")  # the API returns all of the map's locations
    by_layer = lambda layer: [loc for loc in everything if loc["catId"] == layer]

    staff = sorted({clean_name(loc["name"]) for loc in by_layer(FACULTY_STAFF)})

    ev = {}
    for loc in by_layer(EV_CHARGING):
        detail = get(f"locations/{loc['id']}")
        ev[clean_name(re.sub(r"\s*\([A-Z]+\)\s*$", "", detail["name"]))] = ev_ports(detail.get("description") or "")

    # Where each lot's accessible stalls are: sub-layers of "Accessible Parking Stalls" are
    # named after the lot ("Lot 6", "Anteater Parking Structure").
    accessible: dict[str, list[str]] = {}
    for layer_id in sorted({loc["catId"] for loc in everything}):
        try:
            layer = get(f"categories/{layer_id}")
        except httpx.HTTPStatusError:
            continue  # private/retired layers aren't public
        if layer.get("parent") != ACCESSIBLE:
            continue
        lot_name = clean_name(layer["name"])
        for loc in by_layer(layer_id):
            note = text(get(f"locations/{loc['id']}").get("description") or "")
            if note and note not in accessible.setdefault(lot_name, []):
                accessible[lot_name].append(note)

    # Where visitors can pay: each dispenser / ParkbyPlate area, named after its lot.
    pay = []
    for loc in by_layer(DISPENSERS):
        name = re.sub(r"\s+", " ", loc["name"]).strip()
        kind = "pay_by_space" if re.search(r"pay-by-space", name, re.I) else "dispenser"
        place = re.sub(r"\s*(Pay-by-Space\s*)?Dispenser$", "", name, flags=re.I)
        pay.append({"lot": place, "kind": kind, "lat": round(loc["lat"], 6), "lon": round(loc["lng"], 6)})
    for loc in by_layer(PARKBYPLATE):
        pay.append({"lot": clean_name(loc["name"]), "kind": "parkbyplate", "lat": round(loc["lat"], 6), "lon": round(loc["lng"], 6)})

    lots = {}
    for loc in by_layer(PARKING):
        detail = get(f"locations/{loc['id']}")
        desc = detail.get("description") or ""
        name = clean_name(detail["name"])
        levels = re.search(r"No\. of Levels\s*(\d+)", text(desc))
        lots[name] = {
            "name": name,
            "lat": round(detail["lat"], 6),
            "lon": round(detail["lng"], 6),
            "levels": int(levels.group(1)) if levels else None,
            "stalls": stall_table(desc),
            "uci_map_id": loc["id"],
        }

    OUT.write_text(json.dumps({
        "source": "UCI campus map (map.uci.edu), Parking and Electric Vehicle Charging layers",
        "source_url": "https://map.uci.edu/?id=463",
        "retrieved": date.today().isoformat(),
        "faculty_staff_lots": staff,
        "ev_charging": ev,
        "accessible_locations": accessible,
        "pay_stations": pay,
        "lots": lots,
    }, indent=1) + "\n")
    print(f"Wrote {len(lots)} lots, {len(ev)} EV locations, {len(staff)} faculty/staff lots to {OUT}")


if __name__ == "__main__":
    main()
