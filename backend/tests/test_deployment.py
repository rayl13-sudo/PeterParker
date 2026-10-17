import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.db import PostgresConnection, connect
from app.main import app


def test_vercel_rejects_ephemeral_sqlite(monkeypatch):
    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(settings, "database_url", "")
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        with TestClient(app):
            pass
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        connect()


def test_vercel_startup_does_not_run_schema_migrations(monkeypatch):
    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(settings, "database_url", "postgresql://unused")
    def unexpected_init():
        pytest.fail("PostgreSQL migrations must not run during cold starts")
    monkeypatch.setattr("app.main.init_db", unexpected_init)
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/docs").status_code == 200


def test_configured_frontend_can_preflight(client):
    response = client.options("/api/auth/login", headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_postgres_connection_context_commits_or_rolls_back_and_closes(monkeypatch):
    events = []

    class FakeConnection:
        def commit(self):
            events.append("commit")

        def rollback(self):
            events.append("rollback")

        def close(self):
            events.append("close")

    monkeypatch.setattr("app.db.psycopg.connect", lambda *args, **kwargs: FakeConnection())

    with PostgresConnection() as conn:
        assert isinstance(conn, PostgresConnection)
    assert events == ["commit", "close"]

    events.clear()
    with pytest.raises(ValueError):
        with PostgresConnection():
            raise ValueError("test failure")
    assert events == ["rollback", "close"]
