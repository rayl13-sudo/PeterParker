"""Reports stay private; only a DB-appointed admin can manage the queue."""
from tests.conftest import TERMS

import sqlite3

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


def test_initial_admin_can_delegate_access(client, auth_headers):
    assert client.get("/api/issues/admins").status_code == 401
    assert client.post("/api/issues/admins", headers=auth_headers, json={"email": "peter@uci.edu"}).status_code == 403
    result = client.post("/api/auth/signup", json={
        "username": "initialadmin", "email": "blam22@uci.edu", "password": "Webslinger!", **TERMS,
    })
    assert result.status_code == 201, result.text
    owner = {"Authorization": f"Bearer {result.json()['token']}"}
    assert client.get("/api/auth/me", headers=owner).json()["is_admin"] is True
    assert client.get("/api/issues/admin", headers=owner).status_code == 200
    assert client.get("/api/issues/admins", headers=auth_headers).status_code == 403
    added = client.post("/api/issues/admins", headers=owner, json={"email": " PETER@UCI.EDU "})
    assert added.status_code == 200, added.text
    assert client.get("/api/auth/me", headers=auth_headers).json()["is_admin"] is True
    assert client.get("/api/issues/admin", headers=auth_headers).status_code == 200
    assert client.post("/api/issues/admins", headers=auth_headers, json={"email": "blam22@uci.edu"}).status_code == 200
    assert len(client.get("/api/issues/admins", headers=owner).json()) == 2
    assert client.post("/api/issues/admins", headers=owner, json={"email": "missing@uci.edu"}).status_code == 404
    assert client.post("/api/issues/admins", headers=owner, json={"email": "invalid"}).status_code == 422
