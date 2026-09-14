"""Render every email template to HTML files you can open in a browser.

    cd server
    python preview_emails.py            # writes to server/.email_preview/
    python preview_emails.py --open     # ...and opens the index

Nothing is sent and nothing touches the database — it just runs the Jinja
templates with representative sample data, so you can check the black/white/grey
theme, the hosted logo and the footer without waiting for a real trigger.

The output directory is git-ignored; delete it whenever you like.
"""

from __future__ import annotations

import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.services.email import render  # noqa: E402

OUT = Path(__file__).resolve().parent / ".email_preview"

# One representative context per template. Values are deliberately realistic —
# a preview with "foo"/"bar" in it does not tell you whether the layout holds.
SAMPLES: dict[str, dict] = {
    "otp.html": {"name": "Rajan", "code": "418302", "minutes": 10},
    "delete_otp.html": {"name": "Rajan", "code": "550194", "minutes": 10,
                        "target_name": "Test Employee",
                        "target_code": "EMP-AA00007"},
    "account_created.html": {
        "name": "Kavita Reddy", "role": "employee",
        "email": "kavita@example.com", "temp_password": "Xy7#kQp2",
        "login_url": "https://agatya--test.vercel.app/login"},
    "login_alert.html": {"name": "Rajan", "attempts": 5, "ip": "49.36.180.22",
                         "when": "26 Jul 2026, 11:42 IST"},
    "renewal_reminder.html": {
        "name": "Suresh Patel", "policy_code": "AG-POL-000123",
        "category": "Private Car", "expiry": "14 Aug 2026", "days_left": 19},
    "document_request.html": {
        "name": "Suresh Patel",
        "upload_url": "https://agatya--test.vercel.app/upload/abc123",
        "docs": ["PAN card", "Aadhaar (front & back)", "Previous policy copy"],
        "message": "Please send the previous policy copy as well so we can "
                   "carry your no-claim bonus forward."},
    "partner_statement.html": {
        "name": "Kavita Reddy", "period_label": "July 2026",
        "download_url": "https://agatya--test.vercel.app/statements/xyz"},
    "policy_approval.html": {
        "name": "Kavita Reddy", "policy_code": "AG-POL-000123",
        "status_label": "approved", "approved": True,
        "policy_number": "MH12-2026-778812", "reward_amount": "1,940.17",
        "policies_url": "https://agatya--test.vercel.app/policies",
        "reason": None},
    "withdrawal_requested.html": {
        "name": "Rajan", "partner_name": "Kavita Reddy",
        "partner_code": "CP-AA00003", "amount": "12,500.00",
        "code": "WDR-000045",
        "review_url": "https://agatya--test.vercel.app/wallet"},
    "withdrawal_update.html": {
        "name": "Kavita Reddy", "code": "WDR-000045", "amount": "12,500.00",
        "status_label": "paid", "reference": "UTR8891203344",
        "wallet_url": "https://agatya--test.vercel.app/wallet", "reason": None},
}


def main() -> None:
    OUT.mkdir(exist_ok=True)
    links = []
    for template, context in SAMPLES.items():
        html = render(template, **context)
        (OUT / template).write_text(html, encoding="utf-8")
        links.append(f'<li><a href="{template}">{template}</a></li>')
        print(f"  {template}")

    index = (
        "<!doctype html><meta charset='utf-8'>"
        "<title>Email previews</title>"
        "<body style=\"font-family:system-ui;padding:40px;background:#f4f4f4\">"
        "<h1 style='font-size:20px'>Email previews</h1>"
        "<p style='color:#666;font-size:14px'>Sample renders — nothing was "
        "sent.</p><ul style='line-height:2'>" + "".join(links) + "</ul></body>"
    )
    (OUT / "index.html").write_text(index, encoding="utf-8")
    print(f"\nWrote {len(SAMPLES)} previews to {OUT}")
    if "--open" in sys.argv:
        webbrowser.open((OUT / "index.html").as_uri())


if __name__ == "__main__":
    main()
