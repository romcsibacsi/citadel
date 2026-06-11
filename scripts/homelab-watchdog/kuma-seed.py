#!/usr/bin/env python3
# Seed Uptime Kuma with the key-service monitors + ntfy/Telegram alerting.
# Creds + tokens come from the env (vault-env-wrapper resolves vault:* refs); NEVER printed.
#   KUMA_ADMIN_USER, KUMA_ADMIN_PASS, NTFY_TOKEN, TELEGRAM_BOT_TOKEN
# Idempotent: skips monitors/notifications that already exist by name.
import os, sys, time
from uptime_kuma_api import UptimeKumaApi, MonitorType, NotificationType

URL   = "http://192.168.1.105:8102"
NTFY  = "http://192.168.1.105:8097"
TOPIC = "homelab-alerts"
TG_CHAT = "1513162658193342617"

user = os.environ.get("KUMA_ADMIN_USER"); pw = os.environ.get("KUMA_ADMIN_PASS")
ntfy_tok = os.environ.get("NTFY_TOKEN"); tg_tok = os.environ.get("TELEGRAM_BOT_TOKEN")
if not (user and pw):
    print("ERROR: KUMA_ADMIN_USER/PASS not in env (use vault-env-wrapper)"); sys.exit(2)

MON = [
    dict(type=MonitorType.HTTP, name="CITADEL Dashboard", url="http://192.168.1.105:3420", interval=60),
    dict(type=MonitorType.HTTP, name="NPM (ingress)",     url="http://192.168.1.105:81",  interval=60),
    dict(type=MonitorType.PORT, name="AdGuard DNS",       hostname="192.168.1.105", port=53, interval=60),
    dict(type=MonitorType.HTTP, name="Prowlarr",   url="http://192.168.1.105:9696/ping", interval=60),
    dict(type=MonitorType.HTTP, name="Radarr",     url="http://192.168.1.105:7878/ping", interval=60),
    dict(type=MonitorType.HTTP, name="Sonarr",     url="http://192.168.1.105:8989/ping", interval=60),
    dict(type=MonitorType.HTTP, name="qBittorrent",url="http://192.168.1.105:8080/",     interval=60),
    dict(type=MonitorType.HTTP, name="Overseerr",  url="http://192.168.1.105:5055/api/v1/status", interval=120),
    dict(type=MonitorType.HTTP, name="Plex",       url="http://192.168.1.105:32400/identity", interval=60),
    dict(type=MonitorType.KEYWORD, name="Nextcloud", url="http://192.168.1.105:8060/status.php", keyword="installed", interval=120),
    dict(type=MonitorType.HTTP, name="Mailcow UI", url="https://192.168.1.105:8443", interval=120, ignoreTls=True),
    dict(type=MonitorType.PORT, name="Mailcow SMTP", hostname="192.168.1.105", port=25, interval=120),
    dict(type=MonitorType.HTTP, name="Vaultwarden", url="http://192.168.1.105:8091/alive", interval=120),
    dict(type=MonitorType.HTTP, name="Beszel",      url="http://192.168.1.105:8095/", interval=120),
]

api = UptimeKumaApi(URL, timeout=30)
api.login(user, pw)
try:
    # --- notifications (default, applied to all). Look up IDs by name (robust across lib vers). ---
    def notif_ids():
        return {n["name"]: n["id"] for n in api.get_notifications()}
    existing_n = notif_ids()
    if "ntfy (homelab)" not in existing_n:
        kw = dict(name="ntfy (homelab)", type=NotificationType.NTFY, isDefault=True, applyExisting=True,
                  ntfyserverurl=NTFY, ntfytopic=TOPIC, ntfyPriority=4)
        if ntfy_tok:
            kw["ntfyAuthenticationMethod"] = "accessToken"; kw["ntfyaccesstoken"] = ntfy_tok
        else:
            kw["ntfyAuthenticationMethod"] = "none"
        api.add_notification(**kw); print("notif ntfy: created")
    else:
        print("notif ntfy: exists")
    if "Telegram (homelab)" not in existing_n and tg_tok:
        api.add_notification(name="Telegram (homelab)", type=NotificationType.TELEGRAM, isDefault=True,
                             applyExisting=True, telegramBotToken=tg_tok, telegramChatID=TG_CHAT)
        print("notif telegram: created")
    elif "Telegram (homelab)" in existing_n:
        print("notif telegram: exists")
    else:
        print("notif telegram: SKIP (no token)")

    existing_n = notif_ids()
    nid = {k: existing_n[k] for k in ("ntfy (homelab)", "Telegram (homelab)") if k in existing_n}
    nlist = {v: True for v in nid.values()}
    print("active notifications:", list(nid.keys()))

    # --- monitors (idempotent by name) ---
    existing_m = {m["name"] for m in api.get_monitors()}
    created = 0
    for m in MON:
        if m["name"] in existing_m:
            print(f"monitor {m['name']}: exists, skip"); continue
        api.add_monitor(notificationIDList=nlist, maxretries=2, retryInterval=60, **m)
        created += 1; print(f"monitor {m['name']}: created")

    # --- verify ---
    time.sleep(8)
    mons = api.get_monitors()
    print(f"\nSUMMARY: {len(mons)} monitors total, {created} newly created, notifications={list(nid.keys())}")
    try:
        hb = api.get_monitor_status if hasattr(api, "get_monitor_status") else None
    except Exception:
        hb = None
    # status via heartbeats
    beats = api.get_heartbeats() if hasattr(api, "get_heartbeats") else {}
    for mo in mons:
        st = "?"
        b = beats.get(mo["id"]) if isinstance(beats, dict) else None
        if b: st = {1: "UP", 0: "DOWN", 2: "PENDING", 3: "MAINT"}.get(b[-1].get("status"), "?")
        print(f"  - {mo['name']:22s} {st}")
finally:
    api.disconnect()
