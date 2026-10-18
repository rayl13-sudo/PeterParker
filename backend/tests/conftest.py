import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "database_url", "")
    monkeypatch.setattr(settings, "vercel", False)
    monkeypatch.setattr(settings, "supabase_url", "")
    monkeypatch.setattr(settings, "supabase_publishable_key", "")
    monkeypatch.setattr(settings, "supabase_secret_key", "")
    monkeypatch.setattr(settings, "database_path", str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


from app.api.routes.auth import TERMS_VERSION  # noqa: E402

# Every sign-up must accept the current Terms of Service.
TERMS = {"accept_terms": True, "terms_version": TERMS_VERSION}


@pytest.fixture
def auth_headers(client):
    res = client.post(
        "/api/auth/signup",
        json={"username": "peter", "email": "peter@uci.edu", "password": "Webslinger!", **TERMS},
    )
    return {"Authorization": f"Bearer {res.json()['token']}"}
