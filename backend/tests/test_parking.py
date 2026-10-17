from fastapi.testclient import TestClient

from app import supabase_auth
from app.config import settings
from app.main import app


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


def seeded_client(tmp_path, monkeypatch, **overrides):
    monkeypatch.setattr(settings, "database_path", str(tmp_path / "seed.db"))
    monkeypatch.setattr(settings, "seed_user", True)
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_publishable_key", "")
    for key, value in overrides.items():
        monkeypatch.setattr(settings, key, value)
    return TestClient(app)


def login(client, identifier, password="parking"):
    return client.post("/api/auth/login", json={"identifier": identifier, "password": password})


def test_seeded_user_can_sign_in(tmp_path, monkeypatch):
    with seeded_client(tmp_path, monkeypatch) as client:
        for identifier in ["peter", "PETER", "peter@example.com"]:
            assert login(client, identifier).status_code == 200, identifier
        assert login(client, "peter", "wrong").status_code == 401
    # Restarting doesn't duplicate or fail.
    with seeded_client(tmp_path, monkeypatch):
        pass


def test_seeded_password_is_restored_on_startup(tmp_path, monkeypatch):
    with seeded_client(tmp_path, monkeypatch) as client:
        pass
    with seeded_client(tmp_path, monkeypatch, seed_password="changed") as client:
        assert login(client, "peter", "changed").status_code == 200
    with seeded_client(tmp_path, monkeypatch, seed_password="parking") as client:
        assert login(client, "peter", "parking").status_code == 200
        assert login(client, "peter", "changed").status_code == 401


def test_seeded_user_bypasses_supabase(tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("Supabase should not be called for the seed account")

    with seeded_client(
        tmp_path, monkeypatch,
        supabase_url="https://example.supabase.co", supabase_publishable_key="test-key",
    ) as client:
        monkeypatch.setattr(supabase_auth, "request", fail)
        assert login(client, "peter").status_code == 200


def test_seed_account_is_created_on_first_sign_in_if_missing(tmp_path, monkeypatch):
    # e.g. a PostgreSQL deployment, where startup doesn't seed.
    with seeded_client(tmp_path, monkeypatch, seed_user=False) as client:
        monkeypatch.setattr(settings, "seed_user", True)
        assert login(client, "peter", "wrong").status_code == 401
        assert login(client, "peter").status_code == 200
        assert login(client, "peter").status_code == 200
