import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.db import get_db
from app.security import get_current_user

router = APIRouter(prefix="/items", tags=["items"])


class ItemIn(BaseModel):
    name: str


class Item(ItemIn):
    id: int


@router.get("", response_model=list[Item])
def list_items(
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> list[Item]:
    rows = db.execute(
        "SELECT id, name FROM items WHERE user_id = ? ORDER BY id", (user["id"],)
    ).fetchall()
    return [Item(id=r["id"], name=r["name"]) for r in rows]


@router.post("", response_model=Item, status_code=201)
def create_item(
    payload: ItemIn,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> Item:
    cur = db.execute(
        "INSERT INTO items (user_id, name) VALUES (?, ?)", (user["id"], payload.name)
    )
    return Item(id=cur.lastrowid, name=payload.name)


@router.delete("/{item_id}", status_code=204)
def delete_item(
    item_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    db: sqlite3.Connection = Depends(get_db),
) -> None:
    cur = db.execute(
        "DELETE FROM items WHERE id = ? AND user_id = ?", (item_id, user["id"])
    )
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="Item not found")
