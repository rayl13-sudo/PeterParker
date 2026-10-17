import hashlib
import hmac
import secrets
import sqlite3
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings
from app.db import get_db

_PBKDF2_ITERATIONS = 600_000

bearer = HTTPBearer(auto_error=False)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if stored == "supabase":
        return False
    _, iterations, salt_hex, digest_hex = stored.split("$")
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
    )
    return hmac.compare_digest(digest.hex(), digest_hex)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: sqlite3.Connection, user_id: int, remember_me: bool) -> tuple[str, datetime]:
    """Issue an opaque token. Only its hash is stored, so a DB leak can't be replayed."""
    token = secrets.token_urlsafe(32)
    lifetime = (
        timedelta(days=settings.remember_me_days)
        if remember_me
        else timedelta(hours=settings.session_hours)
    )
    expires_at = datetime.now(UTC) + lifetime
    db.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
        (hash_token(token), user_id, expires_at.isoformat()),
    )
    return token, expires_at


def revoke_session(db: sqlite3.Connection, token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),))


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: sqlite3.Connection = Depends(get_db),
) -> sqlite3.Row:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if creds is None:
        raise unauthorized

    row = db.execute(
        """
        SELECT users.id, users.username, users.email, sessions.expires_at
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
        """,
        (hash_token(creds.credentials),),
    ).fetchone()
    if row is None:
        raise unauthorized
    if datetime.fromisoformat(row["expires_at"]) <= datetime.now(UTC):
        revoke_session(db, creds.credentials)
        db.commit()
        raise unauthorized
    return row
