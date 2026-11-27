"""Outgoing email (verification codes) over SMTP configured by environment variables.

QNB_SMTP_HOST, QNB_SMTP_PORT (587), QNB_SMTP_USER, QNB_SMTP_PASSWORD,
QNB_SMTP_FROM, QNB_SMTP_SECURITY (starttls | ssl | none).
Without QNB_SMTP_HOST the message is written to the server log instead, so a
self-hosted instance can still verify accounts (read the code from `docker logs`).
"""

import logging
import os
import smtplib
import ssl
import threading
from email.message import EmailMessage
from email.utils import formataddr

log = logging.getLogger("qnb.mailer")


def configured():
    return bool(os.environ.get("QNB_SMTP_HOST"))


def _send(message):
    host = os.environ["QNB_SMTP_HOST"]
    security = os.environ.get("QNB_SMTP_SECURITY", "starttls").lower()
    port = int(os.environ.get("QNB_SMTP_PORT") or (465 if security == "ssl" else 587))
    user = os.environ.get("QNB_SMTP_USER")
    password = os.environ.get("QNB_SMTP_PASSWORD")
    context = ssl.create_default_context()
    if security == "ssl":
        client = smtplib.SMTP_SSL(host, port, timeout=20, context=context)
    else:
        client = smtplib.SMTP(host, port, timeout=20)
    with client:
        if security == "starttls":
            client.starttls(context=context)
        if user:
            client.login(user, password or "")
        client.send_message(message)


def send(to, subject, text, html=None):
    sender = os.environ.get("QNB_SMTP_FROM") or os.environ.get("QNB_SMTP_USER") or "no-reply@localhost"
    message = EmailMessage()
    message["From"] = formataddr(("QNB", sender))
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    if not configured():
        log.warning("SMTP is not configured (QNB_SMTP_HOST); email to %s was not sent:\n%s", to, text)
        return False

    def worker():
        try:
            _send(message)
        except (OSError, smtplib.SMTPException):
            log.exception("Failed to send email to %s", to)

    threading.Thread(target=worker, daemon=True).start()
    return True


def verification_email(to, nickname, code, link):
    text = (
        f"{nickname}님, QNB 가입을 환영합니다.\n\n"
        f"이메일 인증 코드: {code}\n\n"
        f"또는 아래 링크를 열어 바로 인증할 수 있습니다 (30분 동안 유효):\n{link}\n\n"
        "본인이 요청하지 않았다면 이 메일을 무시하세요."
    )
    html = (
        f"<p>{_escape(nickname)}님, QNB 가입을 환영합니다.</p>"
        f"<p>이메일 인증 코드</p><p style=\"font:700 28px monospace;letter-spacing:6px\">{code}</p>"
        f"<p><a href=\"{_escape(link)}\">이메일 인증하기</a> (30분 동안 유효)</p>"
        "<p style=\"color:#888\">본인이 요청하지 않았다면 이 메일을 무시하세요.</p>"
    )
    return send(to, "[QNB] 이메일 인증 코드", text, html)


def _escape(text):
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))
