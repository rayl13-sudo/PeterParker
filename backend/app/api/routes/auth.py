import json
import re
import sqlite3
from datetime import datetime
from functools import cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import settings
from app.db import get_db
from app import supabase_auth
from app.avatar import random_colors, validate_image
from app.security import (
    bearer,
    create_session,
    get_current_user,
    hash_password,
    hash_token,
    revoke_session,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Any characters except whitespace and "@" ("@" is how sign-in tells emails apart).
USERNAME_RE = re.compile(r"^[^\s@]{3,32}$")

# Keep in sync with PASSWORD_RULES in frontend/js/app.js.
PASSWORD_MIN_LENGTH = 8
CAPITAL_RE = re.compile(r"[A-Z]")
SPECIAL_CHAR_RE = re.compile(r"[^A-Za-z0-9\s]")


def clean_username(v: str) -> str:
    v = v.strip().lower()
    if not USERNAME_RE.match(v):
        raise ValueError("Username must be 3-32 characters with no spaces or '@'")
    return v


def clean_email(v: str) -> str:
    v = v.strip().lower()
    local, _, domain = v.partition("@")
    if not local or "." not in domain:
        raise ValueError("Enter a valid email address")
    return v


def check_password_strength(v: str) -> str:
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


class SignupIn(BaseModel):
    username: str
    email: str
    password: str = Field(max_length=128)
    remember_me: bool = False

    @field_validator("username")
    @classmethod
    def check_username(cls, v: str) -> str:
        return clean_username(v)

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return clean_email(v)

    @field_validator("password")
    @classmethod
    def check_password(cls, v: str) -> str:
        return check_password_strength(v)


class AccountUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = None
    current_password: str

    @field_validator("username")
    @classmethod
    def check_username(cls, v: str | None) -> str | None:
        return v if v is None else clean_username(v)


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(max_length=128)

    @field_validator("new_password")
    @classmethod
    def check_password(cls, v: str) -> str:
        return check_password_strength(v)


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
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?) RETURNING id",
        (payload.username, payload.email, hash_password(payload.password)),
    )
    user = User(id=cur.fetchone()["id"], username=payload.username, email=payload.email)
    return _issue(db, user, payload.remember_me)


@router.post("/login", response_model=AuthResponse)
def login(payload: LoginIn, db: sqlite3.Connection = Depends(get_db)) -> AuthResponse:
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
                "INSERT INTO users (username, email, password_hash, supabase_id) VALUES (?, ?, ?, ?) RETURNING id",
                (username, email, "supabase", remote_id),
            )
            row = db.execute("SELECT * FROM users WHERE id = ?", (cur.fetchone()["id"],)).fetchone()
    elif row["email"] != email:
        # Supabase exposes the new email only after its confirmation flow completes.
        clash = db.execute("SELECT 1 FROM users WHERE email = ? AND id != ?", (email, row["id"])).fetchone()
        if clash:
            raise HTTPException(409, "This email is already associated with another account")
        db.execute("UPDATE users SET email = ? WHERE id = ?", (email, row["id"]))
    return _issue(db, User(id=row["id"], username=row["username"], email=email), remember_me)


@router.post("/logout", status_code=204)
def logout(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    if creds is not None:
        revoke_session(db, creds.credentials)


class Avatar(BaseModel):
    bg: str
    fg: str
    image: str | None = None  # uploaded photo as a data URL; replaces the silhouette


class Me(User):
    avatar: Avatar
    permit: str | None = None  # UCI permit code the user holds, e.g. "S4" or "R-ME"
    is_admin: bool = False


def _me(db, user_id: int) -> Me:
    row = db.execute(
        "SELECT * FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    # Permit and admin migrations are applied separately on production PostgreSQL.
    # Account reads remain available while those migrations are being rolled out.
    row = dict(row)
    bg, fg = row["avatar_bg"], row["avatar_fg"]
    if not bg or not fg:
        # Accounts get their random colors the first time they're shown.
        bg, fg = random_colors()
        db.execute("UPDATE users SET avatar_bg = ?, avatar_fg = ? WHERE id = ?", (bg, fg, user_id))
    return Me(
        id=row["id"], username=row["username"], email=row["email"],
        avatar=Avatar(bg=bg, fg=fg, image=row["avatar_image"]),
        permit=row.get("permit"), is_admin=bool(row.get("is_admin", False)),
    )


@router.get("/me", response_model=Me)
def me(
    user: sqlite3.Row = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)
) -> Me:
    return _me(db, user["id"])


class AvatarImageIn(BaseModel):
    image: str

    @field_validator("image")
    @classmethod
    def check_image(cls, v: str) -> str:
        return validate_image(v)


@router.put("/me/avatar", response_model=Me)
def set_avatar_image(
    payload: AvatarImageIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> Me:
    db.execute("UPDATE users SET avatar_image = ? WHERE id = ?", (payload.image, user["id"]))
    return _me(db, user["id"])


@router.delete("/me/avatar", response_model=Me)
def remove_avatar_image(
    user: sqlite3.Row = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)
) -> Me:
    db.execute("UPDATE users SET avatar_image = NULL WHERE id = ?", (user["id"],))
    return _me(db, user["id"])


@cache
def _holdable_permits() -> set[str]:
    data = json.loads((Path(__file__).resolve().parents[2] / "data" / "uci_permits.json").read_text())
    return set(data["holdable_permits"])


class PermitIn(BaseModel):
    permit: str | None = None  # None: no permit

    @field_validator("permit")
    @classmethod
    def known_permit(cls, v: str | None) -> str | None:
        if v is not None and v not in _holdable_permits():
            raise ValueError("Choose a permit from the list")
        return v


@router.put("/me/permit", response_model=Me)
def set_permit(
    payload: PermitIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> Me:
    db.execute("UPDATE users SET permit = ? WHERE id = ?", (payload.permit, user["id"]))
    return _me(db, user["id"])


class AvatarColorsIn(BaseModel):
    bg: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    fg: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


@router.put("/me/avatar/colors", response_model=Me)
def set_avatar_colors(
    payload: AvatarColorsIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> Me:
    db.execute(
        "UPDATE users SET avatar_bg = ?, avatar_fg = ? WHERE id = ?",
        (payload.bg.lower(), payload.fg.lower(), user["id"]),
    )
    return _me(db, user["id"])


@router.post("/me/avatar/colors", response_model=Me)
def shuffle_avatar_colors(
    user: sqlite3.Row = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)
) -> Me:
    bg, fg = random_colors()
    db.execute("UPDATE users SET avatar_bg = ?, avatar_fg = ? WHERE id = ?", (bg, fg, user["id"]))
    return _me(db, user["id"])


def _editable_account(db, user, current_password: str) -> sqlite3.Row:
    """Load the signed-in account for editing, after checking its current password."""
    row = db.execute("SELECT id, password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
    if row["password_hash"] == "supabase":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This account's sign-in is managed by Supabase")
    if not verify_password(current_password, row["password_hash"]):
        # Not 401: that means "session expired" and would sign the user out.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    return row


def _supabase_access_token(db, user, current_password: str) -> str | None:
    """Reauthenticate a Supabase account before changing its credentials or details."""
    account = db.execute(
        "SELECT password_hash, supabase_id FROM users WHERE id = ?", (user["id"],)
    ).fetchone()
    if account["password_hash"] != "supabase":
        return None
    if not supabase_auth.enabled():
        raise HTTPException(503, "Supabase authentication is not configured")
    try:
        verified = supabase_auth.request("token?grant_type=password", {
            "email": user["email"], "password": current_password,
        })
    except HTTPException as exc:
        if exc.status_code == 401:
            raise HTTPException(400, "Current password is incorrect") from exc
        raise
    if verified.get("user", {}).get("id") != account["supabase_id"]:
        raise HTTPException(400, "Current password does not match this account")
    access_token = verified.get("access_token")
    if not access_token:
        raise HTTPException(502, "Authentication service did not issue a session")
    return access_token


class AccountDeleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1)
    confirmation: Literal["YES"]


@router.delete("/me", status_code=204)
def delete_me(
    payload: AccountDeleteIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    account = db.execute(
        "SELECT password_hash, supabase_id FROM users WHERE id = ?", (user["id"],)
    ).fetchone()
    if account["supabase_id"]:
        # Linked accounts must also be removed from Supabase Auth, or they can sign in again.
        if not settings.supabase_secret_key:
            raise HTTPException(503, "Account deletion is not configured on this server")
        if not supabase_auth.enabled():
            raise HTTPException(503, "Supabase authentication is not configured")
        try:
            verified = supabase_auth.request("token?grant_type=password", {
                "email": user["email"], "password": payload.current_password,
            })
        except HTTPException as exc:
            if exc.status_code == 401:
                raise HTTPException(400, "Current password is incorrect") from exc
            raise
        if verified.get("user", {}).get("id") != account["supabase_id"]:
            raise HTTPException(400, "Current password does not match this account")
        if not verified.get("access_token"):
            raise HTTPException(502, "Authentication service did not issue a session")
        supabase_auth.delete_user(account["supabase_id"])
    else:
        _editable_account(db, user, payload.current_password)

    # Sessions, reviews, and items cascade from this user in both databases.
    db.execute("DELETE FROM users WHERE id = ?", (user["id"],))


@router.patch("/me", response_model=Me)
def update_me(
    payload: AccountUpdateIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> Me:
    access_token = _supabase_access_token(db, user, payload.current_password)
    if access_token is None:
        _editable_account(db, user, payload.current_password)
    username = payload.username or user["username"]
    clash = db.execute(
        "SELECT 1 FROM users WHERE username = ? AND id != ?", (username, user["id"])
    ).fetchone()
    if clash:
        raise HTTPException(status.HTTP_409_CONFLICT, "That username is already taken")
    db.execute("UPDATE users SET username = ? WHERE id = ?", (username, user["id"]))
    return _me(db, user["id"])


@router.post("/password", status_code=204)
def change_password(
    payload: PasswordChangeIn,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    access_token = _supabase_access_token(db, user, payload.current_password)
    if access_token:
        supabase_auth.request(
            "user",
            {"password": payload.new_password, "current_password": payload.current_password},
            method="PUT",
            access_token=access_token,
        )
    else:
        _editable_account(db, user, payload.current_password)
        db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (hash_password(payload.new_password), user["id"]),
        )
    # Sign out every other device; this one stays signed in.
    db.execute(
        "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
        (user["id"], hash_token(creds.credentials)),
    )
