from app import supabase_auth
from app.config import settings
from fastapi import HTTPException


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


def test_remote_password_change_verifies_identity_and_updates_supabase(client, monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_publishable_key", "test-key")
    calls = []

    def request(path, payload, **kwargs):
        calls.append((path, payload, kwargs))
        if path.startswith("token"):
            if payload["password"] == "wrong":
                raise HTTPException(401, "Invalid credentials")
            return {"access_token": "supabase-token", "user": {
                "id": "remote", "email": "peter@example.com", "email_confirmed_at": "2026-10-17",
                "user_metadata": {"username": "peter"},
            }}
        return {"id": "remote"}

    monkeypatch.setattr(supabase_auth, "request", request)
    logged_in = client.post("/api/auth/login", json={
        "identifier": "peter@example.com", "password": "Webslinger!",
    })
    assert logged_in.status_code == 200
    headers = {"Authorization": "Bearer " + logged_in.json()["token"]}
    other = client.post("/api/auth/login", json={
        "identifier": "peter@example.com", "password": "Webslinger!",
    })
    other_headers = {"Authorization": "Bearer " + other.json()["token"]}

    bad = client.post("/api/auth/password", headers=headers, json={
        "current_password": "wrong", "new_password": "Brand-New1",
    })
    assert bad.status_code == 400
    assert all(path != "user" for path, _, _ in calls)

    changed = client.post("/api/auth/password", headers=headers, json={
        "current_password": "Webslinger!", "new_password": "Brand-New1",
    })
    assert changed.status_code == 204
    assert calls[-1] == ("user", {
        "password": "Brand-New1", "current_password": "Webslinger!",
    }, {"method": "PUT", "access_token": "supabase-token"})
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=other_headers).status_code == 401


def test_remote_username_update_rejects_email_changes(client, monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_publishable_key", "test-key")
    remote_email = "peter@example.com"
    calls = []

    def request(path, payload, **kwargs):
        calls.append((path, payload, kwargs))
        if path.startswith("token"):
            if payload["password"] == "wrong":
                raise HTTPException(401, "Invalid credentials")
            return {"access_token": "supabase-token", "user": {
                "id": "remote", "email": remote_email, "email_confirmed_at": "2026-10-17",
                "user_metadata": {"username": "peter"},
            }}
        return {"id": "remote"}

    monkeypatch.setattr(supabase_auth, "request", request)
    logged_in = client.post("/api/auth/login", json={
        "identifier": remote_email, "password": "Webslinger!",
    })
    assert logged_in.status_code == 200
    headers = {"Authorization": "Bearer " + logged_in.json()["token"]}

    wrong = client.patch("/api/auth/me", headers=headers, json={
        "username": "newpeter", "current_password": "wrong",
    })
    assert wrong.status_code == 400
    assert client.get("/api/auth/me", headers=headers).json()["username"] == "peter"

    changed = client.patch("/api/auth/me", headers=headers, json={
        "username": "newpeter", "current_password": "Webslinger!",
    })
    assert changed.status_code == 200
    assert changed.json()["username"] == "newpeter"
    assert changed.json()["email"] == remote_email
    assert all(path != "user" for path, _, _ in calls)

    email_change = client.patch("/api/auth/me", headers=headers, json={
        "email": "new@example.com", "current_password": "Webslinger!",
    })
    assert email_change.status_code == 422
    assert all(path != "user" for path, _, _ in calls)

    remote_email = "new@example.com"  # Supabase now reports the confirmed address.
    again = client.post("/api/auth/login", json={
        "identifier": remote_email, "password": "Webslinger!",
    })
    assert again.status_code == 200
    new_headers = {"Authorization": "Bearer " + again.json()["token"]}
    assert client.get("/api/auth/me", headers=new_headers).json()["email"] == remote_email
