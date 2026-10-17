from app import supabase_auth
from app.config import settings


def enable(monkeypatch, result):
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_publishable_key", "test-key")
    calls = []
    def request(path, payload):
        calls.append((path, payload))
        return result
    monkeypatch.setattr(supabase_auth, "request", request)
    return calls


def test_confirmation_does_not_issue_session(client, monkeypatch):
    enable(monkeypatch, {"id": "remote"})
    response = client.post("/api/auth/signup", json={
        "username": "peter", "email": "peter@example.com", "password": "Webslinger!",
    })
    assert response.status_code == 201
    assert response.json()["confirmation_required"]
    assert "token" not in response.json()


def test_remote_login_links_user_and_supports_username(client, monkeypatch):
    calls = enable(monkeypatch, {"user": {
        "id": "remote", "email": "peter@example.com", "email_confirmed_at": "2026-10-17",
        "user_metadata": {"username": "peter"},
    }})
    response = client.post("/api/auth/login", json={
        "identifier": "peter@example.com", "password": "Webslinger!",
    })
    assert response.status_code == 200
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    assert client.get("/api/auth/me", headers=headers).json()["username"] == "peter"
    response = client.post("/api/auth/login", json={"identifier": "peter", "password": "Webslinger!"})
    assert response.status_code == 200
    assert calls[-1][1]["email"] == "peter@example.com"
    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/auth/me", headers=headers).status_code == 401
