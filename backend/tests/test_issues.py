"""Reports stay private; only authorized admins can manage the queue."""
from tests.conftest import TERMS

import sqlite3
import pytest

from app import supabase_auth
from app.config import settings


def test_issue_report_and_admin_queue(client, auth_headers):
    issue = {
        "category": "parking_data",
        "title": "  Wrong permit rules  ",
        "description": "  Lot 5 requires a permit after 5 p.m.  ",
        "location": "  Lot 5  ",
    }
    unauth = client.post("/api/issues", json=issue)
    assert unauth.status_code == 401

    created = client.post("/api/issues", headers=auth_headers, json=issue)
    assert created.status_code == 201
    report_id = created.json()["id"]
    assert created.json()["title"] == "Wrong permit rules"
    assert created.json()["status"] == "open"
    assert created.json()["location"] == "Lot 5"
    assert len(client.get("/api/issues/mine", headers=auth_headers).json()) == 1
    assert client.get("/api/issues/admin", headers=auth_headers).status_code == 403
    assert client.patch(f"/api/issues/{report_id}", headers=auth_headers, json={"status": "resolved"}).status_code == 403

    second = client.post("/api/auth/signup", json={
        "username": "other", "email": "other@uci.edu", "password": "Webslinger!", **TERMS,
    })
    second_headers = {"Authorization": f"Bearer {second.json()['token']}"}
    assert client.get("/api/issues/mine", headers=second_headers).json() == []
    assert client.get("/api/auth/me", headers=second_headers).json()["is_admin"] is False

    with sqlite3.connect(settings.database_path) as db:
        db.execute("UPDATE users SET is_admin = 1 WHERE email = ?", ("other@uci.edu",))

    assert client.get("/api/auth/me", headers=second_headers).json()["is_admin"] is True
    queue = client.get("/api/issues/admin", headers=second_headers)
    assert queue.status_code == 200
    assert queue.json()[0]["reporter"] == "peter"
    resolved = client.patch(f"/api/issues/{report_id}", headers=second_headers, json={"status": "resolved"})
    assert resolved.status_code == 200
    assert resolved.json()["status"] == "resolved"
    assert client.get("/api/issues/mine", headers=auth_headers).json()[0]["status"] == "resolved"


def test_issue_validation_and_missing_report(client, auth_headers):
    bad = client.post("/api/issues", headers=auth_headers, json={
        "category": "map", "title": "   ", "description": "          ",
    })
    assert bad.status_code == 422
    with sqlite3.connect(settings.database_path) as db:
        db.execute("UPDATE users SET is_admin = 1 WHERE email = ?", ("peter@uci.edu",))
    assert client.patch("/api/issues/999", headers=auth_headers, json={"status": "unknown"}).status_code == 422
    assert client.patch("/api/issues/999", headers=auth_headers, json={"status": "resolved"}).status_code == 404


@pytest.mark.parametrize("email", [
    "blam22@uci.edu", "jessd10@uci.edu", "sstanik@uci.edu", "rayl13@uci.edu",
])
def test_confirmed_team_email_is_admin(client, monkeypatch, email):
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_publishable_key", "test-key")
    remote = {
        "id": "remote-id", "email": email, "email_confirmed_at": "2026-10-17T12:00:00Z",
        "user_metadata": {"username": email.split("@")[0]},
    }
    monkeypatch.setattr(supabase_auth, "request", lambda *args, **kwargs: {
        "access_token": "confirmed-token", "user": remote,
    })

    signed_up = client.post("/api/auth/signup", json={
        "username": email.split("@")[0], "email": email, "password": "Webslinger!", **TERMS,
    })
    assert signed_up.status_code == 201
    headers = {"Authorization": f"Bearer {signed_up.json()['token']}"}
    assert client.get("/api/auth/me", headers=headers).json()["is_admin"] is True
    assert client.get("/api/issues/admin", headers=headers).status_code == 200


def test_team_email_needs_confirmation_and_regains_admin_after_deletion(client, monkeypatch):
    email = "rayl13@uci.edu"
    monkeypatch.setattr(settings, "supabase_url", "https://example.supabase.co")
    monkeypatch.setattr(settings, "supabase_publishable_key", "test-key")
    monkeypatch.setattr(settings, "supabase_secret_key", "test-secret")
    remote = {
        "id": "first-remote-id", "email": email, "email_confirmed_at": None,
        "user_metadata": {"username": "rayl13"},
    }
    monkeypatch.setattr(supabase_auth, "request", lambda *args, **kwargs: {
        "access_token": "supabase-token", "user": remote,
    })
    deleted = []
    monkeypatch.setattr(supabase_auth, "delete_user", deleted.append)

    first = client.post("/api/auth/signup", json={
        "username": "rayl13", "email": email, "password": "Webslinger!", **TERMS,
    })
    first_headers = {"Authorization": f"Bearer {first.json()['token']}"}
    assert client.get("/api/auth/me", headers=first_headers).json()["is_admin"] is False
    assert client.get("/api/issues/admin", headers=first_headers).status_code == 403

    remote["email_confirmed_at"] = "2026-10-17T12:00:00Z"
    logged_in = client.post("/api/auth/login", json={"identifier": email, "password": "Webslinger!"})
    admin_headers = {"Authorization": f"Bearer {logged_in.json()['token']}"}
    assert client.get("/api/auth/me", headers=admin_headers).json()["is_admin"] is True

    response = client.request("DELETE", "/api/auth/me", headers=admin_headers, json={
        "current_password": "Webslinger!", "confirmation": "YES",
    })
    assert response.status_code == 204
    assert deleted == ["first-remote-id"]

    remote["id"] = "second-remote-id"
    again = client.post("/api/auth/signup", json={
        "username": "rayl13", "email": email, "password": "Webslinger!", **TERMS,
    })
    assert again.status_code == 201
    again_headers = {"Authorization": f"Bearer {again.json()['token']}"}
    assert client.get("/api/auth/me", headers=again_headers).json()["is_admin"] is True
    assert client.get("/api/issues/admin", headers=again_headers).status_code == 200
