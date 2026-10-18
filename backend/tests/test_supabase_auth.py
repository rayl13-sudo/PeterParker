from app import supabase_auth
from app.config import settings
from fastapi import HTTPException
from urllib.request import Request
from tests.conftest import TERMS


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
        "username": "peter", "email": "peter@uci.edu", "password": "Webslinger!", **TERMS,
    })
    assert response.status_code == 201
    assert response.json()["confirmation_required"]
    assert "token" not in response.json()


def test_remote_login_links_user_by_uci_email(client, monkeypatch):
    calls = enable(monkeypatch, {"user": {
        "id": "remote", "email": "peter@uci.edu", "email_confirmed_at": "2026-10-17",
        "user_metadata": {"username": "peter"},
    }})
    response = client.post("/api/auth/login", json={
        "identifier": "peter@uci.edu", "password": "Webslinger!",
    })
    assert response.status_code == 200
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    assert client.get("/api/auth/me", headers=headers).json()["username"] == "peter"
    assert calls[-1][1]["email"] == "peter@uci.edu"
    # A username signs in through its account's email.
    response = client.post("/api/auth/login", json={"identifier": "Peter", "password": "Webslinger!"})
    assert response.status_code == 200
    assert calls[-1][1]["email"] == "peter@uci.edu"
    assert client.post("/api/auth/login", json={"identifier": "nobody", "password": "x"}).status_code == 401
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
                "id": "remote", "email": "peter@uci.edu", "email_confirmed_at": "2026-10-17",
                "user_metadata": {"username": "peter"},
            }}
        return {"id": "remote"}

    monkeypatch.setattr(supabase_auth, "request", request)
    logged_in = client.post("/api/auth/login", json={
        "identifier": "peter@uci.edu", "password": "Webslinger!",
    })
    assert logged_in.status_code == 200
    headers = {"Authorization": "Bearer " + logged_in.json()["token"]}
    other = client.post("/api/auth/login", json={
        "identifier": "peter@uci.edu", "password": "Webslinger!",
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
    remote_email = "peter@uci.edu"
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
        "email": "new@uci.edu", "current_password": "Webslinger!",
    })
    assert email_change.status_code == 422
    assert all(path != "user" for path, _, _ in calls)

    remote_email = "new@uci.edu"  # Supabase now reports the confirmed address.
    again = client.post("/api/auth/login", json={
        "identifier": remote_email, "password": "Webslinger!",
    })
    assert again.status_code == 200
    new_headers = {"Authorization": "Bearer " + again.json()["token"]}
    assert client.get("/api/auth/me", headers=new_headers).json()["email"] == remote_email


def test_remote_delete_needs_secret_and_only_removes_local_data_after_auth_delete(client, monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_publishable_key", "test-key")
    deleted_remote = []

    def request(path, payload, **kwargs):
        if path.startswith("token"):
            if payload["password"] == "wrong":
                raise HTTPException(401, "Invalid credentials")
            return {"access_token": "remote-token", "user": {
                "id": "remote", "email": "peter@uci.edu", "email_confirmed_at": "2026-10-17",
                "user_metadata": {"username": "peter"},
            }}
        raise AssertionError(path)

    monkeypatch.setattr(supabase_auth, "request", request)
    signed_in = client.post("/api/auth/login", json={
        "identifier": "peter@uci.edu", "password": "Webslinger!",
    })
    headers = {"Authorization": "Bearer " + signed_in.json()["token"]}
    payload = {"current_password": "Webslinger!", "confirmation": "YES"}
    path = "/api/auth/me"

    assert client.request("DELETE", path, headers=headers, json=payload).status_code == 503
    assert client.get(path, headers=headers).status_code == 200
    monkeypatch.setattr(settings, "supabase_secret_key", "server-secret")
    monkeypatch.setattr(supabase_auth, "delete_user", lambda user_id: deleted_remote.append(user_id))
    assert client.request("DELETE", path, headers=headers, json={**payload, "current_password": "wrong"}).status_code == 400
    assert deleted_remote == []

    def fail_delete(_user_id):
        raise HTTPException(502, "Remote deletion failed")

    monkeypatch.setattr(supabase_auth, "delete_user", fail_delete)
    assert client.request("DELETE", path, headers=headers, json=payload).status_code == 502
    assert client.get(path, headers=headers).status_code == 200

    monkeypatch.setattr(supabase_auth, "delete_user", lambda user_id: deleted_remote.append(user_id))
    assert client.request("DELETE", path, headers=headers, json=payload).status_code == 204
    assert deleted_remote == ["remote"]
    assert client.get(path, headers=headers).status_code == 401


def test_admin_delete_uses_server_secret_key(monkeypatch):
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_secret_key", "server-secret")
    requests = []

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): return False

    def urlopen(req: Request, **kwargs):
        requests.append(req)
        return Response()

    monkeypatch.setattr(supabase_auth, "urlopen", urlopen)
    supabase_auth.delete_user("remote-id")
    assert len(requests) == 1
    assert requests[0].get_method() == "DELETE"
    assert requests[0].full_url == "https://example.supabase.co/auth/v1/admin/users/remote-id"
    assert requests[0].get_header("Apikey") == "server-secret"
    assert requests[0].get_header("Authorization") == "Bearer server-secret"
