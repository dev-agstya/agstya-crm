"""Application configuration, loaded from environment / server/.env."""

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# server/ directory (this file lives at server/app/config.py)
BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"


class Settings(BaseSettings):
    """Typed access to every environment variable the backend needs.

    Field names are matched case-insensitively against the .env keys.
    """

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App ---
    app_name: str = "Agstya Associates"
    environment: str = Field(default="development")
    debug: bool = Field(default=True)

    @field_validator("debug", mode="before")
    @classmethod
    def parse_debug(cls, v: object) -> bool:
        if isinstance(v, str):
            val = v.strip().lower()
            if val in ("release", "prod", "production", "false", "0", "no", "off"):
                return False
            if val in ("debug", "dev", "development", "true", "1", "yes", "on"):
                return True
        return bool(v)
    # Comma-separated list of allowed frontend origins for CORS.
    cors_origins: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173"
    )

    # --- Security / JWT ---
    secret_value: str = Field(alias="SECRET_VALUE")
    jwt_secret: str = Field(alias="JWT_SECRET")
    jwt_expire_hours: int = Field(default=3, alias="JWT_EXPIRE_HOURS")
    jwt_algorithm: str = "HS256"
    # Refresh tokens live longer so users are not logged out every few hours.
    refresh_expire_days: int = 7

    # --- Auth policy ---
    max_failed_logins: int = 5          # lock window trigger
    lockout_minutes: int = 15           # temporary auto-lock after too many fails
    otp_length: int = 6
    otp_expire_minutes: int = 10
    otp_max_attempts: int = 5
    deactivation_cooldown_hours: int = 24

    # --- Database ---
    mongo_uri: str = Field(alias="MONGO_URI")
    mongo_db_name: str = Field(default="agastyacrm")

    # --- Email (Gmail SMTP) ---
    gmail_username: str = Field(alias="GMAIL_USERNAME")
    gmail_app_pwd: str = Field(alias="GMAIL_APP_PWD")
    mail_from: str = Field(default="", alias="MAIL_FROM")
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587

    # --- AWS S3 ---
    aws_access_key_id: str = Field(alias="AWS_ACCESS_KEY_ID")
    aws_secret_access_key: str = Field(alias="AWS_SECRET_ACCESS_KEY")
    aws_region: str = Field(alias="AWS_REGION")
    aws_bucket_name: str = Field(alias="AWS_BUCKET_NAME")
    s3_presign_expire_seconds: int = 900  # 15 minutes

    # --- Frontend links used inside emails ---
    frontend_base_url: str = Field(default="http://localhost:5173")

    # --- Reliability / hardening ---
    request_timeout_seconds: int = 30       # hard cap -> clean 504
    # How many proxies OUR infrastructure puts in front of the app. The client
    # IP is read that many entries from the RIGHT of X-Forwarded-For; anything
    # further left was supplied by the caller and is ignored (see
    # core.rate_limit.client_ip). Render alone = 1. Put a CDN in front and this
    # becomes 2 — set it too low and you rate-limit the CDN, too high and
    # callers can spoof themselves again.
    trusted_proxy_hops: int = 1
    # IP rate limits. login/refresh/global use a 60s window; forgot uses 1 hour.
    rate_limit_global_per_min: int = 120
    rate_limit_login_per_min: int = 10
    rate_limit_refresh_per_min: int = 30
    rate_limit_forgot_per_hour: int = 5
    # Submitting a reset code (the guessing step). Higher than `forgot` so a
    # genuine typo isn't punished, low enough that volume attacks are pointless
    # on top of the per-account attempt budget in services/otp.py.
    rate_limit_reset_per_hour: int = 20
    rate_limit_export_per_min: int = 10
    rate_limit_enabled: bool = True

    # --- WhatsApp (Meta Cloud API) ---
    # Sender phone-number id + long-lived access token from Meta. When either is
    # empty the WhatsApp service stays dormant (sends no-op with a logged reason).
    # The runtime on/off + per-message toggles live in SystemSettings (DB).
    whatsapp_phone_number_id: str = Field(
        default="", alias="WHATSAPP_TEST_PHONE_NUMBER_ID")
    whatsapp_business_account_id: str = Field(
        default="", alias="WHATSAPP_BUSINESS_ACCOUNT_ID")
    whatsapp_access_token: str = Field(default="", alias="WHATSAPP_ACCESS_TOKEN")
    whatsapp_api_version: str = "v21.0"
    whatsapp_default_country_code: str = "91"   # India

    # --- CAPTCHA (Cloudflare Turnstile) ---
    # When a secret is set, the login form requires a Turnstile token after
    # `captcha_after_failures` failed attempts from an IP. Empty = disabled.
    turnstile_secret_key: str = Field(default="")
    turnstile_site_key: str = Field(default="")     # informational (frontend uses its own env)
    captcha_after_failures: int = 3

    # --- Field encryption (Fernet) ---
    # base64 key; when empty, encryption is a no-op (values stored as-is). See
    # extras/guide.txt for generation + how to decrypt a DB dump.
    data_encryption_key: str = Field(default="")

    # --- Observability / alerts ---
    # Developer address alerted when an unhandled server error occurs.
    dev_alert_email: str = Field(default="work@rajanrajawat.in")
    alerts_enabled: bool = True
    # Operational DB logs (error / email outbox / api-call) auto-expire after
    # this many days via a TTL index.
    log_retention_days: int = 180
    # Retention for the user-facing audit trail and other growing collections.
    # Each has its own TTL index (owner Q-D3): audit 180d, notifications 90d,
    # lead-activity 90d.
    audit_retention_days: int = 180
    notification_retention_days: int = 90
    lead_activity_retention_days: int = 90

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def mail_from_resolved(self) -> str:
        return self.mail_from or self.gmail_username


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
