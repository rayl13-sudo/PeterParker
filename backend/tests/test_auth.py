import sqlite3
from datetime import UTC, datetime, timedelta

from app.config import settings
from app.db import init_db

SIGNUP = {"username": "Spidey", "email": "Peter@Example.com", "password": "Webslinger!"}


def login(client, identifier, password=SIGNUP["password"], **extra):
    return client.post(
        "/api/auth/login", json={"identifier": identifier, "password": password, **extra}
    )


def test_signup_then_me(client):
    res = client.post("/api/auth/signup", json=SIGNUP)
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["username"] == "spidey"
    assert body["user"]["email"] == "peter@example.com"

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["username"] == "spidey"


def test_duplicate_username_or_email_rejected(client):
    client.post("/api/auth/signup", json=SIGNUP)
    dup_user = client.post("/api/auth/signup", json={**SIGNUP, "email": "other@example.com"})
    assert dup_user.status_code == 409
    assert "username" in dup_user.json()["detail"]

    dup_email = client.post("/api/auth/signup", json={**SIGNUP, "username": "other"})
    assert dup_email.status_code == 409
    assert "email" in dup_email.json()["detail"]


def test_username_allows_special_characters(client):
    for i, name in enumerate(["sp!dey#1", "peter_p$rker", "web*slinger&", "m.j.~(watson)", "ünïcødé"]):
        res = client.post(
            "/api/auth/signup",
            json={**SIGNUP, "username": name, "email": f"user{i}@example.com"},
        )
        assert res.status_code == 201, (name, res.json())
        assert login(client, name.upper() if name.isascii() else name, SIGNUP["password"]).status_code == 200, name


def test_invalid_username_rejected(client):
    for bad in ["ab", "has space", "at@sign", "tab\there", "x" * 33]:
        res = client.post("/api/auth/signup", json={**SIGNUP, "username": bad})
        assert res.status_code == 422, bad


def test_login_with_username_or_email(client):
    client.post("/api/auth/signup", json=SIGNUP)
    assert login(client, "spidey").status_code == 200
    assert login(client, "SPIDEY").status_code == 200
    assert login(client, "peter@example.com").status_code == 200
    assert login(client, "spidey", "wrong-password").status_code == 401
    assert login(client, "nobody").status_code == 401


def test_short_password_rejected(client):
    res = client.post("/api/auth/signup", json={**SIGNUP, "password": "short"})
    assert res.status_code == 422


def test_remember_me_extends_session(client):
    client.post("/api/auth/signup", json=SIGNUP)
    now = datetime.now(UTC)
    short = login(client, "spidey").json()
    long = login(client, "spidey", remember_me=True).json()

    assert datetime.fromisoformat(short["expires_at"]) < now + timedelta(days=1)
    assert datetime.fromisoformat(long["expires_at"]) > now + timedelta(days=29)


def test_logout_revokes_token(client):
    token = client.post("/api/auth/signup", json=SIGNUP).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/api/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_migrates_database_without_username(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
        )
    monkeypatch.setattr(settings, "database_path", str(path))
    init_db()
    with sqlite3.connect(path) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
    assert "username" in columns


def test_password_requirements(client):
    for bad in ["Short!1", "nocapital!", "NoSpecial1"]:
        res = client.post("/api/auth/signup", json={**SIGNUP, "password": bad})
        assert res.status_code == 422, bad
    res = client.post("/api/auth/signup", json={**SIGNUP, "password": "nocapsorspecial"})
    msg = res.json()["detail"][0]["msg"]
    assert "capital letter" in msg and "special character" in msg
