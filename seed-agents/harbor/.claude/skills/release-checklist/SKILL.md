---
name: release-checklist
description: Reprodukálható build + release-folyamat előkészítése DRAFTként (verzió, changelog, artefakt, rollback-terv) egy gyártott termékhez. Akkor használd, amikor CI/CD, build/csomagolás vagy release/deploy a feladat. KULCS: a valódi éles deploy/publish visszafordíthatatlan -> OPERÁTORI jóváhagyás kell, sosem magadtól.
---
# Release checklist (CI/CD + deploy, draft + deploy-gate)

## Mikor használd
- Gyártott termék build/csomagolás, CI/CD pipeline, verziózás, release vagy deploy.
- Az előkészítés DRAFT (reprodukálható, rollback-bel); az éles kiadás OPERÁTORI döntés.
- NEM homelab-ops (az a RELAY) -- te a gyártott termék release/deployját viszed.

## Eljárás
1. **Build (reprodukálható).** Tiszta környezetből build; rögzítsd a pontos verziót, függőségeket, artefaktot. Zöld teszt (PROBE/CI) előfeltétel.
2. **Verzió + changelog.** Semver-döntés (major/minor/patch) indokkal; changelog a változásokról és a migrációs lépésekről.
3. **Rollback-terv.** MINDEN release-hez: hogyan állítható vissza (előző artefakt, DB-migráció visszavonása, feature-flag). Ha nincs tiszta rollback, az blokkoló kockázat.
4. **Kockázat + blast radius.** Mi a hatás kifelé, ki/mi érintett, mi a downtime. Ezt írd a kártyára.
5. **DEPLOY-GATE.** Reverzibilis/belső lépés (staging build, dry-run) elvégezhető és láthatóvá tett. A valódi prod-deploy/publish (visszafordíthatatlan/külső hatás) → ELŐBB operátori jóváhagyás (OC #3/#4); addig DRAFT marad.
6. **Kiadás után.** Verifikáció (smoke-check), majd jelentés NEXUS-nak/operátornak; ha gond van, rollback a terv szerint.

## Buktatók
- SOHA ne deployolj/publikálj élesre magadtól -- az operátor jóváhagyása kell (deploy-gate).
- Ne keverd a homelab-ops-szal: a házi infra a RELAY dolga.
- Rollback-terv nélkül nincs release. A „majd megoldjuk" nem rollback.

## Ellenőrzés
- A build reprodukálható, és zöld teszten alapul?
- Van-e konkrét, kipróbált rollback-út?
- Az éles deploy operátori jóváhagyáshoz van-e kötve (nem ment ki magától)?
