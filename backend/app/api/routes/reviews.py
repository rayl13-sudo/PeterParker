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
MAX_REPLY = 500
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


class Reply(BaseModel):
    id: int
    comment: str
    created_at: str
    author: Author
    mine: bool


class Review(BaseModel):
    id: int
    rating: int
    comment: str
    created_at: str
    updated_at: str
    author: Author
    mine: bool
    replies: list[Reply] = []  # oldest first
    like_count: int = 0
    liked: bool = False


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


class ReplyIn(BaseModel):
    comment: str = Field(max_length=MAX_REPLY)

    @field_validator("comment")
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Write something to reply")
        return v


def _author(row) -> Author:
    bg, fg = (row["avatar_bg"], row["avatar_fg"]) if row["avatar_bg"] and row["avatar_fg"] else random_colors()
    return Author(username=row["username"], avatar=Avatar(bg=bg, fg=fg, image=row["avatar_image"]))


def _replies(db, review_ids: list[int], user_id: int) -> dict[int, list[Reply]]:
    if not review_ids:
        return {}
    marks = ",".join("?" * len(review_ids))
    rows = db.execute(
        f"""
        SELECT review_replies.id, review_replies.review_id, review_replies.user_id,
               review_replies.comment, review_replies.created_at,
               users.username, users.avatar_bg, users.avatar_fg, users.avatar_image
        FROM review_replies JOIN users ON users.id = review_replies.user_id
        WHERE review_replies.review_id IN ({marks})
        ORDER BY review_replies.created_at, review_replies.id
        """,
        tuple(review_ids),
    ).fetchall()
    out: dict[int, list[Reply]] = {}
    for r in rows:
        out.setdefault(r["review_id"], []).append(
            Reply(id=r["id"], comment=r["comment"], created_at=r["created_at"],
                  author=_author(r), mine=r["user_id"] == user_id)
        )
    return out


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
        WITH counted AS (
            SELECT reviews.*,
                   (SELECT COUNT(*) FROM review_likes WHERE review_id = reviews.id) AS like_count
            FROM reviews WHERE target_type = ? AND target_id = ?
        ), ranked AS (
            SELECT counted.*, ROW_NUMBER() OVER (
                ORDER BY like_count DESC, updated_at DESC, id DESC
            ) AS like_rank FROM counted
        )
        SELECT reviews.id, reviews.user_id, reviews.rating, reviews.comment,
               reviews.created_at, reviews.updated_at,
               reviews.like_count,
               EXISTS(SELECT 1 FROM review_likes WHERE review_id = reviews.id AND user_id = ?) AS liked,
               users.username, users.avatar_bg, users.avatar_fg, users.avatar_image
        FROM ranked AS reviews JOIN users ON users.id = reviews.user_id
        ORDER BY CASE WHEN like_count > 0 AND like_rank <= 3 THEN 0 ELSE 1 END,
                 CASE WHEN like_count > 0 AND like_rank <= 3 THEN like_rank ELSE 4 END,
                 reviews.user_id = ? DESC, reviews.updated_at DESC, reviews.id DESC
        LIMIT ?
        """,
        (target_type, target_id, user["id"], user["id"], PAGE),
    ).fetchall()
    replies = _replies(db, [r["id"] for r in rows], user["id"])
    reviews = [
        Review(
            id=r["id"], rating=r["rating"], comment=r["comment"],
            created_at=r["created_at"], updated_at=r["updated_at"],
            author=_author(r), mine=r["user_id"] == user["id"],
            replies=replies.get(r["id"], []),
            like_count=r["like_count"], liked=bool(r["liked"]),
        )
        for r in rows
    ]
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


def _target_of(db, review_id: int):
    row = db.execute("SELECT target_type, target_id FROM reviews WHERE id = ?", (review_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Review not found")
    return row


class LikeState(BaseModel):
    like_count: int
    liked: bool


@router.put("/{review_id}/like", response_model=LikeState)
def like_review(
    review_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> LikeState:
    _target_of(db, review_id)
    db.execute(
        "INSERT INTO review_likes (review_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
        (review_id, user["id"]),
    )
    count = db.execute("SELECT COUNT(*) AS count FROM review_likes WHERE review_id = ?", (review_id,)).fetchone()
    return LikeState(like_count=count["count"], liked=True)


@router.delete("/{review_id}/like", response_model=LikeState)
def unlike_review(
    review_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> LikeState:
    _target_of(db, review_id)
    db.execute("DELETE FROM review_likes WHERE review_id = ? AND user_id = ?", (review_id, user["id"]))
    count = db.execute("SELECT COUNT(*) AS count FROM review_likes WHERE review_id = ?", (review_id,)).fetchone()
    return LikeState(like_count=count["count"], liked=False)


@router.post("/{review_id}/replies", response_model=ReviewList, status_code=201)
def reply(
    review_id: int,
    payload: ReplyIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> ReviewList:
    """Reply to a review; returns the target's reviews with the new reply in place."""
    target = _target_of(db, review_id)
    db.execute(
        "INSERT INTO review_replies (review_id, user_id, comment, created_at) VALUES (?, ?, ?, ?)",
        (review_id, user["id"], payload.comment, datetime.now(UTC).isoformat(timespec="seconds")),
    )
    return list_reviews(target["target_type"], target["target_id"], user, db)


@router.delete("/replies/{reply_id}", status_code=204)
def delete_reply(
    reply_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    cur = db.execute("DELETE FROM review_replies WHERE id = ? AND user_id = ?", (reply_id, user["id"]))
    if cur.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reply not found")
