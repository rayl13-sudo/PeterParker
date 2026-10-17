from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "PeterParker API"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    database_path: str = "app.db"

    # Session lifetimes: a normal sign-in vs. "Remember Me".
    session_hours: int = 12
    remember_me_days: int = 30

    # Temporary shared account, created on startup if it doesn't exist.
    # It bypasses the sign-up password rules. Set SEED_USER=false to disable.
    seed_user: bool = True
    seed_username: str = "peter"
    seed_email: str = "peter@example.com"
    seed_password: str = "parking"
    supabase_url: str = ""
    supabase_publishable_key: str = ""


settings = Settings()
