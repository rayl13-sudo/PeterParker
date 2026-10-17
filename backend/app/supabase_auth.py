"""Supabase verifies credentials; the app retains its own revocable sessions."""

import json
import ssl
import certifi
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import HTTPException

from app.config import settings


def enabled() -> bool:
    if bool(settings.supabase_url) != bool(settings.supabase_publishable_key):
        raise HTTPException(503, "Supabase authentication is not fully configured")
    return bool(settings.supabase_url)


def request(path: str, payload: dict) -> dict:
    req = Request(
        settings.supabase_url.rstrip("/") + "/auth/v1/" + path,
        data=json.dumps(payload).encode(),
        headers={"apikey": settings.supabase_publishable_key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=15, context=ssl.create_default_context(cafile=certifi.where())) as response:
            return json.load(response)
    except HTTPError as exc:
        if exc.code == 429:
            raise HTTPException(429, "Too many attempts. Please try again later.") from exc
        if path.startswith("token") and exc.code in (400, 401, 403, 422):
            raise HTTPException(401, "Incorrect username/email or password, or email not confirmed") from exc
        if exc.code in (400, 401, 403, 422):
            raise HTTPException(400, "Unable to create account. Check your details or try signing in.") from exc
        raise HTTPException(502, "Authentication service unavailable. Please try again.") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(502, "Authentication service unavailable. Please try again.") from exc
