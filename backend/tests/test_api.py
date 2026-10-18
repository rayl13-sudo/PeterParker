from tests.conftest import TERMS


def test_health(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_items_require_auth(client):
    assert client.get("/api/items").status_code == 401


def test_item_lifecycle(client, auth_headers):
    res = client.post("/api/items", json={"name": "web-shooter"}, headers=auth_headers)
    assert res.status_code == 201
    item = res.json()
    assert item["name"] == "web-shooter"

    assert item in client.get("/api/items", headers=auth_headers).json()

    assert client.delete(f"/api/items/{item['id']}", headers=auth_headers).status_code == 204
    assert client.delete(f"/api/items/{item['id']}", headers=auth_headers).status_code == 404


def test_items_are_per_user(client, auth_headers):
    client.post("/api/items", json={"name": "mine"}, headers=auth_headers)
    other = client.post(
        "/api/auth/signup",
        json={"username": "maryjane", "email": "mj@uci.edu", "password": "Password123!", **TERMS},
    ).json()["token"]
    assert client.get("/api/items", headers={"Authorization": f"Bearer {other}"}).json() == []


def test_cors_allows_any_local_page(client):
    for origin in ["http://localhost:5173", "http://127.0.0.1:5500", "http://localhost:3000", "null"]:
        res = client.options(
            "/api/auth/login",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert res.status_code == 200, origin
        assert res.headers["access-control-allow-origin"] == origin


def test_cors_rejects_other_sites(client):
    res = client.options(
        "/api/auth/login",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in res.headers
