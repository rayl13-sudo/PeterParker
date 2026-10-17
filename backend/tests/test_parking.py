

def test_parking_requires_auth(client):
    assert client.get("/api/parking").status_code == 401


def test_parking_returns_categorized_lots(client, auth_headers):
    res = client.get("/api/parking", headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert "OpenStreetMap" in body["source"]
    categories = {lot["category"] for lot in body["lots"]}
    assert categories == {"free", "permit", "paid", "limited"}
    for lot in body["lots"]:
        # Everything should be in the UCI area, with a closed outline.
        assert 33.62 < lot["lat"] < 33.67
        assert -117.87 < lot["lon"] < -117.81
        for ring in lot["outline"]:
            assert ring[0] == ring[-1]


def test_parking_includes_uci_permits_and_prices(client, auth_headers):
    body = client.get("/api/parking", headers=auth_headers).json()
    lots = {lot["name"]: lot for lot in body["lots"]}

    mps = lots["Mesa Parking Structure (MPS)"]
    assert mps["category"] == "paid" and mps["uci"]
    assert {p["code"] for p in mps["permits"]} == {"S1", "P1", "GNA"}

    assert [p["code"] for p in lots["Lot 18R"]["permits"]] == ["R-ME"]
    # A UCI lot whose permit isn't on UCI's public pages: still UCI, no guessed permits.
    assert lots["Lot 80"]["uci"] and lots["Lot 80"]["permits"] == []

    info = body["permit_info"]
    assert info["academic_year"] == "2026-2027"
    assert {"name": "One-day General", "price": "$16/day"}.items() <= info["visitor_rates"][0].items()
    assert all(src.startswith("https://parking.uci.edu/") for src in info["sources"])


def test_limited_lots_warn_and_say_what_they_serve(client, auth_headers):
    lots = client.get("/api/parking", headers=auth_headers).json()["lots"]
    limited = [lot for lot in lots if lot["category"] == "limited"]
    assert limited and all(lot["restriction"] for lot in limited)

    utc = [lot for lot in lots if lot["utc"]]
    assert utc, "University Town Center lots should be on the map"
    for lot in utc:
        assert lot["category"] == "limited"
        assert lot["time_limit"] == "2 hours"
        assert "tow" in lot["warning"]
        assert lot["warning_source"].startswith("https://")
        assert lot["serves"], f"{lot['name']} should list the stores it serves"


def test_every_permit_assignment_matches_a_lot():
    import json
    from app.api.routes.parking import DATA_FILE, PERMITS_FILE

    names = {lot["name"] for lot in json.loads(DATA_FILE.read_text())["lots"]}
    permits = json.loads(PERMITS_FILE.read_text())
    for name, assigned in permits["lots"].items():
        assert name in names, f"{name} isn't in parking_lots.json (renamed in OpenStreetMap?)"
        for code in assigned["permits"]:
            assert code in permits["permits"], code


def test_permit_catalogue(client, auth_headers):
    assert client.get("/api/parking/permits").status_code == 401
    body = client.get("/api/parking/permits", headers=auth_headers).json()
    assert "S4" in body["holdable_permits"] and "GNA" not in body["holdable_permits"]
    assert body["permits"]["E"]["price"] == "$48/month"
    assert body["permit_rules_source"] == "https://parking.uci.edu/permits/student"
