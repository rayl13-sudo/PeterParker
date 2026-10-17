"""Supabase verifies credentials; the app retains its own revocable sessions."""

import json
import ssl
import certifi
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from fastapi import HTTPException

from app.config import settings


def enabled() -> bool:
    if bool(settings.supabase_url) != bool(settings.supabase_publishable_key):
        raise HTTPException(503, "Supabase authentication is not fully configured")
    return bool(settings.supabase_url)


def request(path: str, payload: dict, *, method: str = "POST", access_token: str | None = None) -> dict:
    headers = {"apikey": settings.supabase_publishable_key, "Content-Type": "application/json"}
    if access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    req = Request(
        settings.supabase_url.rstrip("/") + "/auth/v1/" + path,
        data=json.dumps(payload).encode(),
        headers=headers,
        method=method,
    )
    try:
        with urlopen(req, timeout=15, context=ssl.create_default_context(cafile=certifi.where())) as response:
            return json.load(response)
    except HTTPError as exc:
        if exc.code == 429:
            raise HTTPException(429, "Too many attempts. Please try again later.") from exc
        if path.startswith("token") and exc.code in (400, 401, 403, 422):
            raise HTTPException(401, "Incorrect username/email or password, or email not confirmed") from exc
        if path == "user" and exc.code in (400, 401, 403, 422):
            raise HTTPException(400, "Supabase could not update the password. Check its password rules and try again.") from exc
        if exc.code in (400, 401, 403, 422):
            raise HTTPException(400, "Unable to create account. Check your details or try signing in.") from exc
        raise HTTPException(502, "Authentication service unavailable. Please try again.") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(502, "Authentication service unavailable. Please try again.") from exc


def delete_user(user_id: str) -> None:
    """Permanently remove a Supabase Auth user with a server-only admin key."""
    secret = settings.supabase_secret_key
    if not secret:
        raise HTTPException(503, "Account deletion is not configured on this server")
    req = Request(
        settings.supabase_url.rstrip("/") + "/auth/v1/admin/users/" + quote(user_id, safe=""),
        headers={"apikey": secret, "Authorization": f"Bearer {secret}"},
        method="DELETE",
    )
    try:
        with urlopen(req, timeout=15, context=ssl.create_default_context(cafile=certifi.where())):
            pass
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise HTTPException(503, "Account deletion is not configured correctly on this server") from exc
        raise HTTPException(502, "Authentication service could not delete the account. Try again later.") from exc
    except (URLError, TimeoutError) as exc:
        raise HTTPException(502, "Authentication service unavailable. Please try again.") from exc
