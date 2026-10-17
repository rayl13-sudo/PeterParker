from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_item_lifecycle():
    res = client.post("/api/items", json={"name": "web-shooter"})
    assert res.status_code == 201
    item = res.json()
    assert item["name"] == "web-shooter"

    assert item in client.get("/api/items").json()

    assert client.delete(f"/api/items/{item['id']}").status_code == 204
    assert client.delete(f"/api/items/{item['id']}").status_code == 404
