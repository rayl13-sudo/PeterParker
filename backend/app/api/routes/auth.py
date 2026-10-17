import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator

from app.config import settings
from app.db import get_db
from app import supabase_auth
from app.security import (
    bearer,
    create_session,
    get_current_user,
    hash_password,
    revoke_session,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# No "@" allowed, so a login identifier is unambiguously a username or an email.
USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,32}$")

# Keep in sync with PASSWORD_RULES in frontend/js/app.js.
PASSWORD_MIN_LENGTH = 8
CAPITAL_RE = re.compile(r"[A-Z]")
SPECIAL_CHAR_RE = re.compile(r"[^A-Za-z0-9\s]")


class SignupIn(BaseModel):
    username: str
    email: str
    password: str = Field(max_length=128)
    remember_me: bool = False

    @field_validator("username")
    @classmethod
    def normalize_username(cls, v: str) -> str:
        v = v.strip().lower()
        if not USERNAME_RE.match(v):
            raise ValueError(
                "Username must be 3-32 characters: letters, numbers, '.', '_' or '-'"
            )
        return v

    @field_validator("password")
    @classmethod
    def check_password_strength(cls, v: str) -> str:
        missing = []
        if len(v) < PASSWORD_MIN_LENGTH:
            missing.append(f"at least {PASSWORD_MIN_LENGTH} characters")
        if not CAPITAL_RE.search(v):
            missing.append("one capital letter")
        if not SPECIAL_CHAR_RE.search(v):
            missing.append("one special character")
        if missing:
            raise ValueError("Password needs " + ", ".join(missing))
        return v

    @field_validator("email")
    @classmethod
    def normalize_email(cls, v: str) -> str:
        v = v.strip().lower()
        local, _, domain = v.partition("@")
        if not local or "." not in domain:
            raise ValueError("Enter a valid email address")
        return v


class LoginIn(BaseModel):
    identifier: str = Field(min_length=1, description="Username or email")
    password: str
    remember_me: bool = False

    @field_validator("identifier")
    @classmethod
    def normalize_identifier(cls, v: str) -> str:
        return v.strip().lower()


class User(BaseModel):
    id: int
    username: str | None
    email: str


class AuthResponse(BaseModel):
    token: str
    expires_at: datetime
    user: User


class ConfirmationResponse(BaseModel):
    confirmation_required: bool = True
    message: str = "Check your email to confirm your account, then sign in."


def _issue(db: sqlite3.Connection, user: User, remember_me: bool) -> AuthResponse:
    token, expires_at = create_session(db, user.id, remember_me)
    return AuthResponse(token=token, expires_at=expires_at, user=user)


@router.post("/signup", response_model=AuthResponse | ConfirmationResponse, status_code=201)
def signup(payload: SignupIn, db: sqlite3.Connection = Depends(get_db)) -> AuthResponse | ConfirmationResponse:
    taken = db.execute(
        "SELECT username = ? AS username_taken FROM users WHERE username = ? OR email = ?",
        (payload.username, payload.username, payload.email),
    ).fetchone()
    if taken is not None:
        field = "username" if taken["username_taken"] else "email"
        raise HTTPException(status.HTTP_409_CONFLICT, f"That {field} is already taken")

    if supabase_auth.enabled():
        result = supabase_auth.request("signup", {
            "email": payload.email, "password": payload.password,
            "data": {"username": payload.username},
        })
        # Confirmation-required accounts are linked only after a verified login.
        if not result.get("access_token"):
            return ConfirmationResponse()
        return _supabase_session(db, result["user"], payload.remember_me)

    cur = db.execute(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        (payload.username, payload.email, hash_password(payload.password)),
    )
    user = User(id=cur.lastrowid, username=payload.username, email=payload.email)
    return _issue(db, user, payload.remember_me)


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginIn, db: sqlite3.Connection = Depends(get_db)) -> AuthResponse:
    seeded = _seed_login(db, payload)
    if seeded is not None:
        return seeded

    if supabase_auth.enabled():
        email = payload.identifier
        if "@" not in email:
            account = db.execute("SELECT email FROM users WHERE username = ?", (email,)).fetchone()
            if account is None:
                raise HTTPException(401, "Use your email for your first sign-in after confirming your account")
            email = account["email"]
        result = supabase_auth.request("token?grant_type=password", {
            "email": email, "password": payload.password,
        })
        return _supabase_session(db, result["user"], payload.remember_me)

    column = "email" if "@" in payload.identifier else "username"
    row = db.execute(
        f"SELECT id, username, email, password_hash FROM users WHERE {column} = ?",
        (payload.identifier,),
    ).fetchone()
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username/email or password")
    user = User(id=row["id"], username=row["username"], email=row["email"])
    return _issue(db, user, payload.remember_me)


def _seed_login(db: sqlite3.Connection, payload: LoginIn) -> AuthResponse | None:
    """The temporary shared account always signs in locally, even with Supabase on."""
    if not settings.seed_user or payload.identifier not in (
        settings.seed_username.lower(),
        settings.seed_email.lower(),
    ):
        return None
    row = db.execute(
        "SELECT id, username, email, password_hash FROM users WHERE username = ?",
        (settings.seed_username,),
    ).fetchone()
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username/email or password")
    user = User(id=row["id"], username=row["username"], email=row["email"])
    return _issue(db, user, payload.remember_me)


def _supabase_session(db: sqlite3.Connection, remote: dict, remember_me: bool) -> AuthResponse:
    remote_id, email = remote["id"], remote["email"].strip().lower()
    row = db.execute("SELECT * FROM users WHERE supabase_id = ?", (remote_id,)).fetchone()
    if row is None:
        existing = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if existing is not None:
            # Never link an unverified external identity to an existing account.
            if existing["supabase_id"] or not remote.get("email_confirmed_at"):
                raise HTTPException(409, "This email is already associated with an account")
            db.execute("UPDATE users SET supabase_id = ? WHERE id = ?", (remote_id, existing["id"]))
            row = existing
        else:
            username = (remote.get("user_metadata") or {}).get("username")
            if not isinstance(username, str) or not USERNAME_RE.fullmatch(username):
                username = None
            if username and db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                username = None
            cur = db.execute(
                "INSERT INTO users (username, email, password_hash, supabase_id) VALUES (?, ?, ?, ?)",
                (username, email, "supabase", remote_id),
            )
            row = db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _issue(db, User(id=row["id"], username=row["username"], email=row["email"]), remember_me)


@router.post("/logout", status_code=204)
def logout(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    if creds is not None:
        revoke_session(db, creds.credentials)


@router.get("/me", response_model=User)
def me(user: sqlite3.Row = Depends(get_current_user)) -> User:
    return User(id=user["id"], username=user["username"], email=user["email"])
