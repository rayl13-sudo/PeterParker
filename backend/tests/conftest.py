import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "database_path", str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth_headers(client):
    res = client.post(
        "/api/auth/signup",
        json={"username": "peter", "email": "peter@example.com", "password": "Webslinger!"},
    )
    return {"Authorization": f"Bearer {res.json()['token']}"}
