from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import api_router
from app.config import settings
from app.db import init_db, seed_user


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.vercel and not settings.database_url:
        raise RuntimeError("DATABASE_URL is required on Vercel")
    # PostgreSQL schema is installed explicitly before deployment, not on cold starts.
    if not settings.database_url:
        init_db()
    if settings.seed_user:
        seed_user()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

# Auth uses bearer tokens, not cookies, so letting any local page call the API is
# safe in development. This covers other dev servers on any port and pages opened
# straight from disk (Origin: null).
LOCAL_ORIGIN_RE = r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|null)$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=LOCAL_ORIGIN_RE,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)

# Serve the frontend too, so http://localhost:8000 runs the whole app from one process.
# Mounted last so /api routes take precedence.
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"


class FreshStaticFiles(StaticFiles):
    """Make browsers revalidate every file so edits show up without a hard refresh."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


if FRONTEND_DIR.is_dir():
    app.mount("/", FreshStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
