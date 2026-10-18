import pytest

from app.api.routes import navigation

OSRM_REPLY = {
    "code": "Ok",
    "routes": [{
        "distance": 608.4,
        "duration": 130.2,
        "geometry": {"coordinates": [[-117.8427, 33.6461], [-117.8440, 33.6480], [-117.8467, 33.6505]]},
        "legs": [{"steps": [
            {"name": "", "distance": 100, "duration": 20,
             "maneuver": {"type": "depart", "modifier": "straight", "bearing_after": 0, "location": [-117.8427, 33.6461]}},
            {"name": "Mesa Road", "distance": 400, "duration": 90,
             "maneuver": {"type": "end of road", "modifier": "right", "location": [-117.8440, 33.6480]}},
            {"name": "", "distance": 108, "duration": 20,
             "maneuver": {"type": "turn", "modifier": "left", "location": [-117.8450, 33.6490]}},
            {"name": "", "distance": 0, "duration": 0,
             "maneuver": {"type": "arrive", "modifier": "right", "location": [-117.8467, 33.6505]}},
        ]}],
    }],
}


@pytest.fixture
def fake_osrm(monkeypatch):
    calls = []

    def fetch(url):
        calls.append(url)
        return OSRM_REPLY

    navigation._route.cache_clear()
    monkeypatch.setattr(navigation, "_fetch", fetch)
    return calls


def test_places_require_auth_and_list_buildings(client, auth_headers):
    assert client.get("/api/places").status_code == 401
    places = client.get("/api/places", headers=auth_headers).json()["places"]
    names = {p["name"] for p in places}
    assert {"Langson Library", "Aldrich Park", "Bren Events Center"} <= names


def test_route_returns_path_and_readable_steps(client, auth_headers, fake_osrm):
    params = {"mode": "car", "from_lat": 33.6461, "from_lon": -117.8427, "to_lat": 33.6505, "to_lon": -117.8467}
    res = client.get("/api/route", params=params, headers=auth_headers)
    assert res.status_code == 200, res.json()
    body = res.json()
    assert body["distance"] == 608.4 and body["duration"] == 130.2
    assert body["path"][0] == [33.6461, -117.8427]  # [lat, lon], not OSRM's [lon, lat]
    assert [s["instruction"] for s in body["steps"]] == [
        "Head north",
        "At the end of the road, turn right onto Mesa Road",
        "Turn left",
        "Arrive at your destination on the right",
    ]
    assert "/routed-car/route/v1/driving/-117.8427,33.6461;-117.8467,33.6505" in fake_osrm[0]

    # Same request again is served from the cache.
    client.get("/api/route", params=params, headers=auth_headers)
    assert len(fake_osrm) == 1


def test_walking_route_uses_foot_profile(client, auth_headers, fake_osrm):
    params = {"mode": "foot", "from_lat": 33.6, "from_lon": -117.8, "to_lat": 33.7, "to_lon": -117.9}
    body = client.get("/api/route", params=params, headers=auth_headers).json()
    assert "/routed-foot/" in fake_osrm[0]
    assert body["steps"][0]["instruction"] == "Walk north"


def test_route_rejects_bad_input(client, auth_headers):
    bad = {"mode": "plane", "from_lat": 33.6, "from_lon": -117.8, "to_lat": 33.7, "to_lon": -117.9}
    assert client.get("/api/route", params=bad, headers=auth_headers).status_code == 422
    bad = {"mode": "car", "from_lat": 133.6, "from_lon": -117.8, "to_lat": 33.7, "to_lon": -117.9}
    assert client.get("/api/route", params=bad, headers=auth_headers).status_code == 422


def test_routing_outage_is_a_clear_error(client, auth_headers, monkeypatch):
    from urllib.error import URLError

    def down(*args, **kwargs):
        raise URLError("offline")

    navigation._route.cache_clear()
    monkeypatch.setattr(navigation, "urlopen", down)
    params = {"mode": "car", "from_lat": 33.61, "from_lon": -117.8, "to_lat": 33.7, "to_lon": -117.9}
    res = client.get("/api/route", params=params, headers=auth_headers)
    assert res.status_code == 502 and "unavailable" in res.json()["detail"]


def test_buildings_have_clickable_outlines(client, auth_headers):
    places = client.get("/api/places", headers=auth_headers).json()["places"]
    by_name = {place["name"]: place for place in places}
    assert by_name["Langson Library"]["outline"]
    # A cafe mapped as a point gets the outline of the building it's in.
    starbucks = [place for place in places if place["name"] == "Starbucks"]  # there are several
    assert any(place["outline"] == by_name["Student Center"]["outline"] for place in starbucks)
    assert sum(bool(place["outline"]) for place in places) > len(places) * 0.8
