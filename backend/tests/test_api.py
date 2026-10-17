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
        json={"username": "maryjane", "email": "mj@example.com", "password": "Password123!"},
    ).json()["token"]
    assert client.get("/api/items", headers={"Authorization": f"Bearer {other}"}).json() == []
