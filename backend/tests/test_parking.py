

def test_parking_requires_auth(client):
    assert client.get("/api/parking").status_code == 401


def test_red_lot_source_labels_are_clean():
    import json
    import re
    from app.api.routes.parking import DATA_FILE

    lots = json.loads(DATA_FILE.read_text())["lots"]
    red = [lot for lot in lots if lot["category"] == "limited"]
    assert red
    assert all(not re.search(r"\s+\([a-z][a-z ]*\)$", name) for lot in red for name in lot["serves"])
    for lot in red:
        if lot.get("utc"):
            assert "(" not in lot["warning"]
            assert all(text in lot["warning"] for text in ("2 hours", "45 minutes", "3 hours", "towed"))


def test_served_place_labels_are_cleaned_without_losing_abbreviations(client, auth_headers):
    import re

    lots = client.get("/api/parking", headers=auth_headers).json()["lots"]
    by_name = {lot["name"]: lot for lot in lots}
    assert "Anteater Recreation Center" in by_name["Permit parking by Anteater Recreation Center"]["serves"]
    assert "Laundry Room" in by_name["Lot 13"]["serves"]
    assert "Starbucks" in by_name["Lot 13"]["serves"]
    assert "Anteater Instruction and Research Building (AIRB)" in by_name["Anteater Parking Structure"]["serves"]
    assert all(not re.search(r"\s+\([a-z][a-z ]*\)$", name) for lot in lots for name in lot["serves"])


def test_parking_returns_categorized_lots(client, auth_headers):
    res = client.get("/api/parking", headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert "OpenStreetMap" in body["source"]
    categories = {lot["category"] for lot in body["lots"]}
    assert categories == {"free", "permit", "paid", "limited", "staff"}
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
    from app.api.routes.parking import PERMITS_FILE, _load

    names = {lot.name for lot in _load().lots}  # includes lots added from UCI's own map
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


def test_only_confirmed_uci_lots_follow_uci_permit_rules(client, auth_headers):
    lots = {lot["name"]: lot for lot in client.get("/api/parking", headers=auth_headers).json()["lots"]}
    assert lots["Lot 15A"]["uci"]  # a numbered UCI lot inside campus
    assert {p["code"] for p in lots["Lot 70"]["permits"]} == {"S3", "P3", "R-CVGRAD"}
    housing = [l for l in lots.values() if l["category"] == "permit" and "housing" in (l.get("inferred") or "")]
    assert housing and not any(l["uci"] for l in housing)


def test_housing_structures_are_not_commuter_lots(client, auth_headers):
    lots = {lot["name"]: lot for lot in client.get("/api/parking", headers=auth_headers).json()["lots"]}
    verano = lots["Verano Parking Structure"]
    assert not verano["uci"] and "housing" in verano["inferred"].lower()



def test_uci_space_counts_and_staff_lots(client, auth_headers):
    lots = {lot["name"]: lot for lot in client.get("/api/parking", headers=auth_headers).json()["lots"]}
    aps = lots["Anteater Parking Structure"]["spaces"]
    assert aps["source"] == "uci" and aps["regular"] == 1586 and aps["accessible"] == 34
    assert aps["ev_ports"] == {"level1": 10, "level2": 12} and aps["tesla_chargers"] == 0
    # UCI's own Lot 16 table, not inflated by neighbouring Lots 16AE/16AW
    assert lots["Lot 16"]["spaces"]["total"] == 619 and lots["Lot 16"]["category"] == "staff"
    assert lots["Lot 16A"]["spaces"]["source"] == "uci"  # 16AE + 16AW combined
    assert lots["Lot EHS"]["category"] == "staff"
    # Student zone lots stay student lots even though staff park there too
    assert lots["Lot 90"]["category"] == "permit"
    # Non-UCI lots get a labelled estimate and the ADA minimum for that size
    tj = lots["Parking by Trader Joe's"]["spaces"]
    assert tj["source"] == "estimate" and tj["accessible"] >= 1


def test_ada_minimum_table():
    from app.api.routes.parking import ada_minimum

    assert [ada_minimum(n) for n in (10, 26, 100, 101, 450, 800, 1200)] == [1, 2, 4, 5, 9, 16, 22]



def test_accessible_parking_counts_and_locations(client, auth_headers):
    lots = {lot["name"]: lot for lot in client.get("/api/parking", headers=auth_headers).json()["lots"]}
    aps = lots["Anteater Parking Structure"]["spaces"]
    assert (aps["accessible"], aps["accessible_standard"], aps["accessible_van"]) == (34, 31, 3)
    assert aps["accessible_is_minimum"] is False
    assert any("level 1" in note for note in aps["accessible_where"])
    hsps = lots["Health Sciences Parking Structure"]["spaces"]
    assert hsps["accessible_ev"] == 7 and hsps["accessible"] == 33 + 7
    # Lots without published counts show the ADA minimum, flagged as such
    tj = lots["Parking by Trader Joe's"]["spaces"]
    assert tj["accessible_is_minimum"] and tj["accessible"] >= 1
