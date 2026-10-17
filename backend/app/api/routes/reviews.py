"""Star ratings (1-5) and written reviews for parking lots and places."""

import sqlite3
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app.api.routes.auth import Avatar
from app.api.routes.navigation import _places
from app.api.routes.parking import _load as _parking
from app.avatar import random_colors
from app.db import get_db
from app.security import get_current_user

router = APIRouter(prefix="/reviews", tags=["reviews"])

TargetType = Literal["lot", "place"]
MAX_COMMENT = 1000
PAGE = 50  # newest reviews returned per target


def _check_target(target_type: str, target_id: str) -> None:
    ids = (
        {lot.id for lot in _parking().lots}
        if target_type == "lot"
        else {place.id for place in _places().places}
    )
    if target_id not in ids:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"That {target_type} isn't on the map")


class Author(BaseModel):
    username: str | None
    avatar: Avatar


class Review(BaseModel):
    id: int
    rating: int
    comment: str
    created_at: str
    updated_at: str
    author: Author
    mine: bool


class ReviewList(BaseModel):
    target_type: TargetType
    target_id: str
    average: float | None
    count: int
    reviews: list[Review]


class ReviewIn(BaseModel):
    target_type: TargetType
    target_id: str = Field(min_length=1, max_length=64)
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=MAX_COMMENT)

    @field_validator("comment")
    @classmethod
    def tidy(cls, v: str) -> str:
        return v.strip()


class Summary(BaseModel):
    average: float
    count: int


@router.get("/summary", response_model=dict[str, Summary])
def summary(
    _: sqlite3.Row = Depends(get_current_user), db: sqlite3.Connection = Depends(get_db)
) -> dict[str, Summary]:
    """Average and count for every reviewed target, keyed "lot:way/123" / "place:node/456"."""
    rows = db.execute(
        "SELECT target_type, target_id, AVG(rating) AS average, COUNT(*) AS count "
        "FROM reviews GROUP BY target_type, target_id"
    ).fetchall()
    return {
        f"{r['target_type']}:{r['target_id']}": Summary(average=round(float(r["average"]), 2), count=r["count"])
        for r in rows
    }


@router.get("", response_model=ReviewList)
def list_reviews(
    target_type: TargetType,
    target_id: str = Query(min_length=1, max_length=64),
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> ReviewList:
    _check_target(target_type, target_id)
    stats = db.execute(
        "SELECT AVG(rating) AS average, COUNT(*) AS count FROM reviews WHERE target_type = ? AND target_id = ?",
        (target_type, target_id),
    ).fetchone()
    rows = db.execute(
        """
        SELECT reviews.id, reviews.user_id, reviews.rating, reviews.comment,
               reviews.created_at, reviews.updated_at,
               users.username, users.avatar_bg, users.avatar_fg, users.avatar_image
        FROM reviews JOIN users ON users.id = reviews.user_id
        WHERE reviews.target_type = ? AND reviews.target_id = ?
        ORDER BY reviews.user_id = ? DESC, reviews.updated_at DESC
        LIMIT ?
        """,
        (target_type, target_id, user["id"], PAGE),
    ).fetchall()
    reviews = []
    for r in rows:
        bg, fg = (r["avatar_bg"], r["avatar_fg"]) if r["avatar_bg"] and r["avatar_fg"] else random_colors()
        reviews.append(
            Review(
                id=r["id"], rating=r["rating"], comment=r["comment"],
                created_at=r["created_at"], updated_at=r["updated_at"],
                author=Author(username=r["username"], avatar=Avatar(bg=bg, fg=fg, image=r["avatar_image"])),
                mine=r["user_id"] == user["id"],
            )
        )
    return ReviewList(
        target_type=target_type,
        target_id=target_id,
        average=round(float(stats["average"]), 2) if stats["count"] else None,
        count=stats["count"],
        reviews=reviews,
    )


@router.put("", response_model=ReviewList)
def save_review(
    payload: ReviewIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> ReviewList:
    """Create the signed-in user's review of a target, or update it if they already wrote one."""
    _check_target(payload.target_type, payload.target_id)
    now = datetime.now(UTC).isoformat(timespec="seconds")
    db.execute(
        """
        INSERT INTO reviews (user_id, target_type, target_id, rating, comment, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, target_type, target_id)
        DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = excluded.updated_at
        """,
        (user["id"], payload.target_type, payload.target_id, payload.rating, payload.comment, now, now),
    )
    return list_reviews(payload.target_type, payload.target_id, user, db)


@router.delete("/{review_id}", status_code=204)
def delete_review(
    review_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    cur = db.execute("DELETE FROM reviews WHERE id = ? AND user_id = ?", (review_id, user["id"]))
    if cur.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Review not found")
