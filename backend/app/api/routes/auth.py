import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, field_validator

from app.db import get_db
from app.moderation import is_username_allowed
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
        if not is_username_allowed(v):
            raise ValueError("That username isn't allowed. Please choose another.")
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


def _issue(db: sqlite3.Connection, user: User, remember_me: bool) -> AuthResponse:
    token, expires_at = create_session(db, user.id, remember_me)
    return AuthResponse(token=token, expires_at=expires_at, user=user)


@router.post("/signup", response_model=AuthResponse, status_code=201)
def signup(payload: SignupIn, db: sqlite3.Connection = Depends(get_db)) -> AuthResponse:
    taken = db.execute(
        "SELECT username = ? AS username_taken FROM users WHERE username = ? OR email = ?",
        (payload.username, payload.username, payload.email),
    ).fetchone()
    if taken is not None:
        field = "username" if taken["username_taken"] else "email"
        raise HTTPException(status.HTTP_409_CONFLICT, f"That {field} is already taken")

    cur = db.execute(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
        (payload.username, payload.email, hash_password(payload.password)),
    )
    user = User(id=cur.lastrowid, username=payload.username, email=payload.email)
    return _issue(db, user, payload.remember_me)


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginIn, db: sqlite3.Connection = Depends(get_db)) -> AuthResponse:
    column = "email" if "@" in payload.identifier else "username"
    row = db.execute(
        f"SELECT id, username, email, password_hash FROM users WHERE {column} = ?",
        (payload.identifier,),
    ).fetchone()
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect username/email or password")
    user = User(id=row["id"], username=row["username"], email=row["email"])
    return _issue(db, user, payload.remember_me)


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
