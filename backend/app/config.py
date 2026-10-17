from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "PeterParker API"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    database_path: str = "app.db"
    database_url: str = ""
    vercel: bool = False

    # Session lifetimes: a normal sign-in vs. "Remember Me".
    session_hours: int = 12
    remember_me_days: int = 30

    # OSRM-compatible routing server with car and foot profiles (/routed-car, /routed-foot).
    routing_url: str = "https://routing.openstreetmap.de"
    supabase_url: str = ""
    supabase_publishable_key: str = ""


settings = Settings()
