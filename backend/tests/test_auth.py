import sqlite3
from datetime import UTC, datetime, timedelta

from app.config import settings
from app.db import init_db
from tests.conftest import TERMS

SIGNUP = {"username": "Spidey", "email": "Peter@uci.edu", "password": "Webslinger!", **TERMS}


def login(client, identifier, password=SIGNUP["password"], **extra):
    return client.post(
        "/api/auth/login", json={"identifier": identifier, "password": password, **extra}
    )


def test_signup_then_me(client):
    res = client.post("/api/auth/signup", json=SIGNUP)
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["username"] == "spidey"
    assert body["user"]["email"] == "peter@uci.edu"

    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    assert me.json()["username"] == "spidey"


def test_duplicate_username_or_email_rejected(client):
    client.post("/api/auth/signup", json=SIGNUP)
    dup_user = client.post("/api/auth/signup", json={**SIGNUP, "email": "other@uci.edu"})
    assert dup_user.status_code == 409
    assert "username" in dup_user.json()["detail"]

    dup_email = client.post("/api/auth/signup", json={**SIGNUP, "username": "other"})
    assert dup_email.status_code == 409
    assert "email" in dup_email.json()["detail"]


def test_username_allows_special_characters(client):
    for i, name in enumerate(["sp!dey#1", "peter_p$rker", "web*slinger&", "m.j.~(watson)", "ünïcødé"]):
        res = client.post(
            "/api/auth/signup",
            json={**SIGNUP, "username": name, "email": f"user{i}@uci.edu"},
        )
        assert res.status_code == 201, (name, res.json())
        assert res.json()["user"]["username"] == name.lower(), name
        assert login(client, f"user{i}@uci.edu", SIGNUP["password"]).status_code == 200, name


def test_invalid_username_rejected(client):
    for bad in ["ab", "has space", "at@sign", "tab\there", "x" * 68]:
        res = client.post("/api/auth/signup", json={**SIGNUP, "username": bad})
        assert res.status_code == 422, bad


def test_login_with_uci_email_or_username(client):
    client.post("/api/auth/signup", json=SIGNUP)
    assert login(client, "peter@uci.edu").status_code == 200
    assert login(client, "  PETER@UCI.EDU ").status_code == 200
    assert login(client, "spidey").status_code == 200
    assert login(client, " Spidey ").status_code == 200  # usernames are case-insensitive
    assert login(client, "peter@uci.edu", "wrong-password").status_code == 401
    assert login(client, "spidey", "wrong-password").status_code == 401
    assert login(client, "nobody@uci.edu").status_code == 401
    assert login(client, "nobody").status_code == 401
    assert login(client, "peter@gmail.com").status_code == 401  # any email domain, but no such account


def test_signup_requires_accepting_current_terms(client):
    from app.api.routes.auth import TERMS_VERSION

    base = {k: v for k, v in SIGNUP.items() if k not in ("accept_terms", "terms_version")}
    for extra, needle in (({}, "Terms of Service"), ({"accept_terms": False, "terms_version": TERMS_VERSION}, "Terms of Service"),
                          ({"accept_terms": True, "terms_version": "2000-01-01"}, "updated")):
        res = client.post("/api/auth/signup", json={**base, **extra})
        assert res.status_code == 422 and needle in res.json()["detail"][0]["msg"], extra
    assert client.post("/api/auth/signup", json=SIGNUP).status_code == 201
    with sqlite3.connect(settings.database_path) as db:
        version, accepted = db.execute("SELECT terms_version, terms_accepted_at FROM users").fetchone()
    assert version == TERMS_VERSION and accepted


def test_frontend_terms_version_matches_server():
    from pathlib import Path

    from app.api.routes.auth import TERMS_VERSION

    terms_js = Path(__file__).resolve().parents[2] / "frontend" / "js" / "terms.js"
    assert f'export const TERMS_VERSION = "{TERMS_VERSION}";' in terms_js.read_text()


def test_signup_accepts_any_email_and_flags_uci_accounts(client):
    cases = {"anteater@uci.edu": True, "Zot@ICS.UCI.EDU": True, "peter@gmail.com": False,
             "peter@fakeuci.edu": False, "peter@uci.edu.evil.com": False, "peter@ucla.edu": False}
    for i, (email, uci) in enumerate(cases.items()):
        res = client.post("/api/auth/signup", json={**SIGNUP, "username": f"user{i}", "email": email})
        assert res.status_code == 201, (email, res.json())
        me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {res.json()['token']}"}).json()
        assert me["is_uci"] is uci, email
    for bad in ["not-an-email", "a@b", "two words@uci.edu"]:
        res = client.post("/api/auth/signup", json={**SIGNUP, "username": "someone", "email": bad})
        assert res.status_code == 422, bad


def test_only_uci_accounts_can_choose_a_permit(client):
    res = client.post("/api/auth/signup", json={**SIGNUP, "email": "peter@gmail.com"})
    headers = {"Authorization": f"Bearer {res.json()['token']}"}
    assert client.put("/api/auth/me/permit", json={"permit": "S4"}, headers=headers).status_code == 403
    assert client.put("/api/auth/me/permit", json={"permit": None}, headers=headers).status_code == 200
    uci = client.post("/api/auth/signup", json={**SIGNUP, "username": "zot", "email": "zot@uci.edu"})
    uci_headers = {"Authorization": f"Bearer {uci.json()['token']}"}
    assert client.put("/api/auth/me/permit", json={"permit": "S4"}, headers=uci_headers).json()["permit"] == "S4"


def test_short_password_rejected(client):
    res = client.post("/api/auth/signup", json={**SIGNUP, "password": "short"})
    assert res.status_code == 422


def test_remember_me_extends_session(client):
    client.post("/api/auth/signup", json=SIGNUP)
    now = datetime.now(UTC)
    short = login(client, "peter@uci.edu").json()
    long = login(client, "peter@uci.edu", remember_me=True).json()

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


def test_delete_account_requires_explicit_yes_and_password_then_revokes_every_session(client):
    signed_up = client.post("/api/auth/signup", json=SIGNUP).json()
    user_id = signed_up["user"]["id"]
    headers = {"Authorization": f"Bearer {signed_up['token']}"}
    other_token = login(client, "peter@uci.edu").json()["token"]
    other_headers = {"Authorization": f"Bearer {other_token}"}

    with sqlite3.connect(settings.database_path) as conn:
        conn.execute("INSERT INTO items (user_id, name) VALUES (?, ?)", (user_id, "saved"))
        conn.execute(
            "INSERT INTO reviews (user_id, target_type, target_id, rating, comment, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, "lot", "way/1", 5, "Easy parking", "2026-10-17", "2026-10-17"),
        )

    path = "/api/auth/me"
    assert client.request("DELETE", path, json={"current_password": SIGNUP["password"], "confirmation": "YES"}).status_code == 401
    assert client.request("DELETE", path, headers=headers, json={"current_password": SIGNUP["password"]}).status_code == 422
    assert client.request("DELETE", path, headers=headers, json={"current_password": SIGNUP["password"], "confirmation": "NO"}).status_code == 422
    assert client.request("DELETE", path, headers=headers, json={"current_password": "wrong", "confirmation": "YES"}).status_code == 400
    assert client.get(path, headers=headers).status_code == 200

    deleted = client.request("DELETE", path, headers=headers, json={"current_password": SIGNUP["password"], "confirmation": "YES"})
    assert deleted.status_code == 204
    assert client.get(path, headers=headers).status_code == 401
    assert client.get(path, headers=other_headers).status_code == 401
    assert login(client, "peter@uci.edu").status_code == 401
    with sqlite3.connect(settings.database_path) as conn:
        for table in ("users", "sessions", "items", "reviews"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {('id' if table == 'users' else 'user_id')} = ?", (user_id,)).fetchone()[0] == 0


def test_signup_check_reports_taken_username_or_email_before_terms(client):
    check = lambda **kw: client.post("/api/auth/signup/check", json={"username": "newbie", "email": "new@uci.edu", **kw})
    assert check().status_code == 204
    client.post("/api/auth/signup", json=SIGNUP)
    res = check(email="PETER@uci.edu")
    assert res.status_code == 409 and "email" in res.json()["detail"]
    res = check(username="Spidey")
    assert res.status_code == 409 and "username" in res.json()["detail"]
    assert check(email="not-an-email").status_code == 422


def test_username_availability_and_length_limits(client):
    available = lambda name: client.get("/api/auth/username-available", params={"username": name}).json()["available"]
    assert available("spidey")
    client.post("/api/auth/signup", json=SIGNUP)
    assert not available("spidey") and not available(" SPIDEY ")
    for name, status_code in (("ab", 422), ("a" * 67, 201), ("b" * 68, 422)):
        res = client.post("/api/auth/signup", json={**SIGNUP, "username": name, "email": f"{name[:5]}{len(name)}@uci.edu"})
        assert res.status_code == status_code, name
