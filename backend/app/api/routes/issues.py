"""User issue reports and a small, server-authorized admin queue."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.db import get_db
from app.security import get_current_user

router = APIRouter(prefix="/issues", tags=["issues"])
Category = Literal["parking_data", "map", "account", "other"]
State = Literal["open", "resolved"]


class IssueIn(BaseModel):
    category: Category
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=10, max_length=2000)
    location: str = Field(default="", max_length=120)

    @field_validator("title", "description", "location")
    @classmethod
    def trim(cls, value: str) -> str:
        return value.strip()

    @field_validator("title")
    @classmethod
    def title_not_blank(cls, value: str) -> str:
        if len(value) < 3:
            raise ValueError("Add a short title")
        return value

    @field_validator("description")
    @classmethod
    def description_not_blank(cls, value: str) -> str:
        if len(value) < 10:
            raise ValueError("Add at least 10 characters of detail")
        return value


class IssueOut(BaseModel):
    id: int
    category: Category
    title: str
    description: str
    location: str
    status: State
    created_at: str
    updated_at: str
    reporter: str | None = None


class IssueStatusIn(BaseModel):
    status: State


class AdminIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        if value.count("@") != 1 or any(char.isspace() for char in value):
            raise ValueError("Enter a valid email address")
        local, domain = value.split("@")
        if not local or not domain or "." not in domain:
            raise ValueError("Enter a valid email address")
        return value


class AdminOut(BaseModel):
    email: str
    username: str | None


def require_admin(user=Depends(get_current_user), db=Depends(get_db)):
    row = db.execute("SELECT is_admin FROM users WHERE id = ?", (user["id"],)).fetchone()
    if not row or not row["is_admin"]:
        raise HTTPException(403, "Admin access required")
    return user


@router.get("/admins", response_model=list[AdminOut])
def list_admins(_=Depends(require_admin), db=Depends(get_db)):
    rows = db.execute("SELECT email, username FROM users WHERE is_admin = TRUE ORDER BY email").fetchall()
    return [AdminOut(**dict(row)) for row in rows]


@router.post("/admins", response_model=AdminOut)
def add_admin(payload: AdminIn, _=Depends(require_admin), db=Depends(get_db)):
    row = db.execute(
        "UPDATE users SET is_admin = TRUE WHERE LOWER(email) = ? RETURNING email, username",
        (str(payload.email).lower(),),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "No registered user with that email. Ask them to create an account first.")
    return AdminOut(**dict(row))


@router.post("", response_model=IssueOut, status_code=201)
def report_issue(payload: IssueIn, user=Depends(get_current_user), db=Depends(get_db)):
    now = datetime.now(UTC).isoformat(timespec="seconds")
    row = db.execute(
        """INSERT INTO issue_reports (user_id, category, title, description, location, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id""",
        (user["id"], payload.category, payload.title, payload.description, payload.location, now, now),
    ).fetchone()
    return IssueOut(id=row["id"], **payload.model_dump(), status="open", created_at=now, updated_at=now)


@router.get("/mine", response_model=list[IssueOut])
def my_issues(user=Depends(get_current_user), db=Depends(get_db)):
    rows = db.execute(
        """SELECT id, category, title, description, location, status, created_at, updated_at
           FROM issue_reports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100""",
        (user["id"],),
    ).fetchall()
    return [IssueOut(**dict(row)) for row in rows]


@router.get("/admin", response_model=list[IssueOut])
def admin_issues(_=Depends(require_admin), db=Depends(get_db)):
    rows = db.execute(
        """SELECT issue_reports.id, category, title, description, location, status,
                  issue_reports.created_at, issue_reports.updated_at, users.username, users.email
           FROM issue_reports JOIN users ON users.id = issue_reports.user_id
           ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                    issue_reports.created_at DESC, issue_reports.id DESC LIMIT 100"""
    ).fetchall()
    return [IssueOut(**{**dict(row), "reporter": row["username"] or row["email"]}) for row in rows]


@router.patch("/{issue_id}", response_model=IssueOut)
def update_issue(issue_id: int, payload: IssueStatusIn, _=Depends(require_admin), db=Depends(get_db)):
    now = datetime.now(UTC).isoformat(timespec="seconds")
    row = db.execute(
        """UPDATE issue_reports SET status = ?, updated_at = ? WHERE id = ?
           RETURNING id, category, title, description, location, status, created_at, updated_at, user_id""",
        (payload.status, now, issue_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Issue report not found")
    reporter = db.execute("SELECT username, email FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    return IssueOut(**dict(row), reporter=reporter["username"] or reporter["email"])
