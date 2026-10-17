import logging
import sqlite3
from collections.abc import Iterator

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

CREATE TABLE IF NOT EXISTS items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL
);
"""

# Applied after SCHEMA so databases created before a column existed catch up.
MIGRATIONS = [
    ("users", "supabase_id", "ALTER TABLE users ADD COLUMN supabase_id TEXT"),
    ("users", "username", "ALTER TABLE users ADD COLUMN username TEXT"),
]

INDEXES = """
CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_id ON users(supabase_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.database_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        for table, column, sql in MIGRATIONS:
            columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                conn.execute(sql)
        conn.executescript(INDEXES)


def get_db() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def seed_user() -> None:
    """Make sure the temporary account exists and its password matches settings."""
    from app.security import hash_password, verify_password  # avoid import cycle

    with connect() as conn:
        row = conn.execute(
            "SELECT id, password_hash FROM users WHERE username = ?", (settings.seed_username,)
        ).fetchone()
        if row is not None:
            if not verify_password(settings.seed_password, row["password_hash"]):
                conn.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (hash_password(settings.seed_password), row["id"]),
                )
            return
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (settings.seed_email,)).fetchone():
            logger.warning("Seed email %s belongs to another account; not creating %s",
                           settings.seed_email, settings.seed_username)
            return
        conn.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
            (settings.seed_username, settings.seed_email, hash_password(settings.seed_password)),
        )
