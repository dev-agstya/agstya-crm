"""CAPTCHA gate: disabled by default; failure counter drives the requirement."""

import app.services.captcha as captcha


def test_disabled_when_no_keys(monkeypatch):
    # No keys configured -> CAPTCHA never required, verify short-circuits True.
    from app.config import settings
    monkeypatch.setattr(settings, "turnstile_secret_key", "", raising=False)
    monkeypatch.setattr(settings, "turnstile_site_key", "", raising=False)
    assert captcha.enabled() is False
    assert captcha.required("1.1.1.1") is False


def test_secret_without_site_key_stays_disabled(monkeypatch):
    # Half-configured (secret set, site key missing) must NOT enable CAPTCHA,
    # otherwise users who trip the threshold can never produce a token.
    from app.config import settings
    monkeypatch.setattr(settings, "turnstile_secret_key", "test-secret",
                        raising=False)
    monkeypatch.setattr(settings, "turnstile_site_key", "", raising=False)
    assert captcha.enabled() is False
    assert captcha.required("2.2.2.2") is False


def test_required_after_threshold(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "turnstile_secret_key", "test-secret",
                        raising=False)
    monkeypatch.setattr(settings, "turnstile_site_key", "test-site",
                        raising=False)
    monkeypatch.setattr(settings, "captcha_after_failures", 3, raising=False)
    ip = "9.9.9.9"
    captcha.reset(ip)
    assert captcha.required(ip) is False
    captcha.record_failure(ip)
    captcha.record_failure(ip)
    assert captcha.required(ip) is False        # 2 < 3
    captcha.record_failure(ip)
    assert captcha.required(ip) is True          # 3 >= 3
    captcha.reset(ip)
    assert captcha.required(ip) is False
