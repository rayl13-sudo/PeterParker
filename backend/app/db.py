import logging
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from app.config import settings

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL,  -- 'lot' or 'place'
    target_id   TEXT NOT NULL,  -- OpenStreetMap id, e.g. 'way/171169301'
    rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS reviews_target ON reviews(target_type, target_id);

CREATE TABLE IF NOT EXISTS review_replies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    comment    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_replies_review ON review_replies(review_id);

CREATE TABLE IF NOT EXISTS items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category    TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    location    TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_reports_status ON issue_reports(status, created_at);
"""

# Applied after SCHEMA so databases created before a column existed catch up.
MIGRATIONS = [
    ("users", "supabase_id", "ALTER TABLE users ADD COLUMN supabase_id TEXT"),
    ("users", "username", "ALTER TABLE users ADD COLUMN username TEXT"),
    ("users", "avatar_bg", "ALTER TABLE users ADD COLUMN avatar_bg TEXT"),
    ("users", "avatar_fg", "ALTER TABLE users ADD COLUMN avatar_fg TEXT"),
    ("users", "avatar_image", "ALTER TABLE users ADD COLUMN avatar_image TEXT"),
<<<<<<< Updated upstream
    ("users", "permit", "ALTER TABLE users ADD COLUMN permit TEXT"),
=======
    ("users", "is_admin", "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0"),
>>>>>>> Stashed changes
]

INDEXES = """
CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_id ON users(supabase_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username);
"""


class PostgresConnection:
    """Expose the small query interface shared with local SQLite."""

    def __init__(self):
        self.connection = psycopg.connect(
            settings.database_url, row_factory=dict_row,
            prepare_threshold=None, connect_timeout=10,
        )

    def execute(self, sql, params=()):
        if params:
            return self.connection.execute(sql.replace("?", "%s"), params)
        return self.connection.execute(sql)

    def commit(self):
        self.connection.commit()

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            if exc_type is None:
                self.connection.commit()
            else:
                self.connection.rollback()
        finally:
            self.connection.close()


def connect() -> sqlite3.Connection | PostgresConnection:
    if settings.database_url:
        return PostgresConnection()
    if settings.vercel:
        raise RuntimeError("Set DATABASE_URL to a PostgreSQL connection URL on Vercel; SQLite is local-only")
    conn = sqlite3.connect(settings.database_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    if settings.database_url:
        conn = connect()
        try:
            # Every migration is idempotent (IF NOT EXISTS), so run them all in order.
            for migration in sorted((Path(__file__).parent.parent / "migrations").glob("*.sql")):
                conn.execute(migration.read_text())
            conn.commit()
        finally:
            conn.close()
        return
    with connect() as conn:
        conn.executescript(SCHEMA)
        for table, column, sql in MIGRATIONS:
            columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                conn.execute(sql)
        conn.executescript(INDEXES)


def get_db() -> Iterator[sqlite3.Connection | PostgresConnection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
