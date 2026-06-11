# Uptime Kuma — monitor-lista + riasztás (RELAY, 2026-06-11, #3f232c7e)

Hub: http://192.168.1.105:8102 · admin **már beállítva** (operátor) · 0 monitor jelenleg.

> **Blokkoló:** az Uptime Kuma v1.23-nak **nincs REST monitor-CRUD** API-ja (a `/api/*` SPA-fallback;
> a vault `Api` kulcs csak a `/metrics`-hez jó). Monitort felvenni socket.io + **admin jelszó** kell —
> az az operátoré, NEM kérem logba / nem tippelem (secret-no-echo). Ezért két út (lent). Minden cél-végpont
> **élőben verifikálva** (HTTP 200 / port nyitva).

## Monitor-lista (kész, verifikált célok)

| # | Szolgáltatás | Típus | Cél | Intervallum |
|---|---|---|---|---|
| 1 | CITADEL Dashboard | HTTP | http://192.168.1.105:3420 | 60s |
| 2 | NPM (ingress admin) | HTTP | http://192.168.1.105:81 | 60s |
| 3 | AdGuard (DNS) | TCP Port | 192.168.1.105:53 | 60s |
| 4 | Prowlarr | HTTP | http://192.168.1.105:9696/ping | 60s |
| 5 | Radarr | HTTP | http://192.168.1.105:7878/ping | 60s |
| 6 | Sonarr | HTTP | http://192.168.1.105:8989/ping | 60s |
| 7 | qBittorrent | HTTP | http://192.168.1.105:8080/ | 60s |
| 8 | Overseerr | HTTP | http://192.168.1.105:5055/api/v1/status | 120s |
| 9 | Plex | HTTP | http://192.168.1.105:32400/identity | 60s |
| 10 | Nextcloud | HTTP-keyword `installed` | http://192.168.1.105:8060/status.php | 120s |
| 11 | Mailcow (UI) | HTTP (TLS-ignore) | https://192.168.1.105:8443 | 120s |
| 12 | Mailcow (SMTP) | TCP Port | 192.168.1.105:25 | 120s |
| 13 | Vaultwarden | HTTP | http://192.168.1.105:8091/alive | 120s |
| 14 | Beszel | HTTP | http://192.168.1.105:8095/ | 120s |

## Riasztás (értesítők) — titok a vaultból, NEM ide írva
- **ntfy**: típus `ntfy`, szerver `http://192.168.1.105:8097`, topic pl. `homelab-alerts`, token = `vault:NTFY_TOKEN`.
- **Telegram**: típus `telegram`, bot token = `vault:TELEGRAM_BOT_TOKEN`, chat_id `1513162658193342617`.
- Mindkettő „default" értesítő → minden monitorhoz kötve; leesésnél azonnal szól.

## Felvétel — két út (operátori döntés)

**(A) Operátor a Kuma UI-ban** (zéró kockázat, ~10 perc): a fenti táblát kattintja be (Add Monitor),
+ Settings → Notifications: ntfy és Telegram a vault-tokenekkel, „Default enabled".

**(B) RELAY DB-seed — GO-ra** (én csinálom, reverzibilis): a `kuma.db` `monitor`/`notification`/
`monitor_notification` tábláiba seedelem a fentieket. Feasibility OK: a `monitor` 77 oszlopából **0**
a NOT-NULL-default-nélküli → minimális INSERT biztonságos (a többi default). Eljárás: Kuma stop →
INSERT (a 14 monitor + 1 ntfy + 1 telegram értesítő, vault-tokennel) → start → verify (mind zöld).
Reverzibilis: a monitorok törölhetők. *Élő tool DB-jét érinti → ezért kell GO.*

> (C) Operátor megadja a Kuma admin kredet → socket.io-val scriptelem. Legkevésbé preferált (jelszó-kitettség).

**Ajánlás:** (B) — ezt kérted („állítsd be"), feasible és reverzibilis; csak egy GO kell, mert a futó
Kuma DB-jét érinti.
