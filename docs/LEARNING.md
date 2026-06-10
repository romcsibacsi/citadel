# CITADEL tanuló-kör (memória + skillek + dream)

Hogyan tanul a flotta: a napi munkából memória és skillek képződnek, éjjel a rendszer
konszolidál és javasol, a javaslatokból valódi skillek/ötletek lesznek, reggel pedig az
operátor elé kerül a lényeg. Ez a dokumentum a teljes hurok komponenseit írja le.

## A hurok

```
napi munka (ügynökök)
   │
   ├─(*/15) memoria-heartbeat ──► /api/memories (hot/warm/cold/shared)  +  skill-reflexió ──► ágens-lokális .claude/skills/
   ├─(PreCompact hook) ─────────► memória + skill + task-state  (kontextus-tömörítéskor)
   │
   ├─(23:50) team-sync ─────────► shared memória (ki mit csinált / miben jó)
   │
   ▼
(02:07) dream-engine ──► store/DREAM.md  (konszolidálás + skill-javaslatok + top-3 + heti websearch)
   │
   ▼
(02:30) dream-consumer ──► a javaslatokból: skill-méltó → ágens-lokális skills (globálisra NEXUS-jóváhagyással) ;  operátor-ügy → /api/ideas
   │
   ▼
(07:30) reggeli-napindito ──► Dream-kivonat + naptár + AI hírek  →  élő csatorna (Discord)
```

## Komponensek

| Komponens | Mikor | Mit csinál | Hol |
|---|---|---|---|
| **memoria-heartbeat** | `*/15` (bypassTriage) | memóriát ír + skill-reflexió | `~/.claude/scheduled-tasks/memoria-heartbeat` |
| **PreCompact hook** | kontextus-tömörítéskor | memória + skill + task-state mentés | `templates/settings.json.template` |
| **team-sync** | `50 23` | cross-agent megfigyelések → `shared` memória | `scheduled-tasks/team-sync` |
| **dream-engine** | `7 2` | éjszakai konszolidálás → `store/DREAM.md` | `scheduled-tasks/dream-engine` |
| **dream-consumer** | `30 2` | DREAM.md javaslatai → skillek + ötletláda | `scheduled-tasks/dream-consumer` |
| **reggeli-napindito** | `30 7` | napindító (Dream + naptár + hírek) a csatornára | `scheduled-tasks/reggeli-napindito` |
| **kanban-audit** | `0 8,12,16,20` (bypassTriage) | beakadt/lejárt kártyák auditja | `scheduled-tasks/kanban-audit` |
| **bumblebee-hygiene-scan** | `0 9 * * 1` (bypassTriage) | heti supply-chain szken (Bumblebee), riasztás csak találatra | `seed-scheduled-tasks/bumblebee-hygiene-scan` |

## Memória

SQLite (`store/citadel.db` → `memories`), 3+1 réteg: **hot** (épp aktív), **warm** (preferencia/konfig),
**cold** (archív tanulság), **shared** (minden ügynöknek látható). Embeddingek (ollama `nomic-embed-text`)
+ FTS5 keresés. A `shared` réteget a kereső uniózza, így bármelyik ügynök látja. Salience-decay viszi
hátrébb a régieket (sosem töröl). A napi-digest (`runDailyDigest`) episodic összefoglalót képez a napból.

## Skillek — két szintű modell (#7d64eea2)

Két tárolási szint, a hatókör szerint — hogy ne gyűljön fel minden a közös névtérben, és ne legyen
NEXUS-szűk-keresztmetszet minden apró skillnél:

- **Globális / flotta-szintű:** `~/.claude/skills/` — MINDEN ügynök látja és betölti. Mivel mindenkit
  érint, globális skill **létrehozása/patch-elése csak NEXUS-jóváhagyással** történhet (a ratifikált
  governance 3. döntése). Verziókövetett forrás: `seed-skills/` (+ `skills/skill-factory/`), innen
  seedeli az installer a `~/.claude/skills/`-be. Truly közös skillek: `handoff`, `retrospective`,
  `skill-management`, `skill-factory`, `nexus-delegate-task`, `ai-fleet-project-execution`.
- **Ágens-lokális:** `agents/<név>/.claude/skills/` — CSAK az adott ügynök látja (a saját
  munkakönyvtárából töltődik). Mivel csak őt érinti, az ügynök **szabadon, jóváhagyás nélkül** hozhat
  létre/patchelhet itt. Verziókövetett forrás: `seed-agents/<név>/.claude/skills/` (a `.gitignore`
  kivételszabállyal követi; a `copySeedDir` seedeli a live `agents/<név>/.claude/skills/`-be). Példák:
  `argus-youtube-watch`→argus, `github-pr-rebase-merge`→forge, `channel-plugin-duplicate-socket`→relay.

**Mikor melyik?** Ha a skill egyetlen ügynök tárgyköréhez/eszközeihez tartozik → lokális. Ha a flotta
egészének hasznos közös konvenció/mechanizmus → globális (NEXUS-jóváhagyással). Más ügynök lokális
skilljéhez nem nyúlsz.

**Index (két szintre):** `scripts/skill-index.sh` generálja (a) a globális indexet
(`~/.claude/skills/.skill-index.md`, egyben NEXUS indexe) és (b) ágensenként a
`agents/<név>/.claude/skills/.skill-index.md`-t = a globális skillek + AZ ADOTT ügynök lokális skilljei
(más ügynök lokálisát NEM). A skillek 3 szinten töltődnek (név+leírás → teljes SKILL.md → segédfájlok).

**Generálás/karbantartás:** a **memoria-heartbeat** reflexiója (folyamatosan) + a **PreCompact hook**
(tömörítéskor) + a **dream-consumer** (éjszakai javaslatokból). Dedup a `skill-management` skillel;
védett skillekhez (`pinned: true`, gyári/plugin) nem nyúl semmi.

## Proaktivitás (idea_box)

Ami az operátor figyelmét érdemli (ötlet, kockázat, javaslat) → `POST /api/ideas` → a dashboard
Ötletláda oldalán látszik, kanbanra emelhető. Feltöltik: NEXUS (a root CLAUDE.md proaktivitás-szabálya
szerint), a dream-consumer és (shared memóriába) a team-sync. Operátor-felé eszkaláció csak autonómia-szint ≥2-nél.

## bypassTriage

A `heartbeat`-típusú konszolidációs feladatok (memoria-heartbeat, kanban-audit) `bypassTriage: true`-val
kihagyják a triage-kaput, így csendes napokon is futnak — de `type=heartbeat` marad (csendes prefix +
keep-alive). Részletek: [heartbeat-autonomy.md](./heartbeat-autonomy.md).

## bumblebee-hygiene-scan (heti supply-chain szken) — TELEPÍTVE 2026-06-09

A **Perplexity Bumblebee** (`github.com/perplexityai/bumblebee`, Apache 2.0) read-only szkenner: leltárba
veszi a telepített csomagokat / MCP-szervereket / kiterjesztéseket (npm/pypi/go/mcp/editor-extension/...),
és ismert supply-chain támadás-katalógusokhoz illeszti **pontos (ecosystem, normalized_name, version)**
egyezéssel. Hétfő 09:00, és **csak találatra** (findings > 0) riaszt a csatornára; 0 találat = csend.

**Telepített állapot (live host, repón kívül):**
- Go: `~/.local/go` (go1.25.11, tarball SHA256 ellenőrizve a go.dev ellen).
- Bináris: `~/.local/bin/bumblebee` (v0.1.1, `./cmd/bumblebee`-ből buildelve).
- Feladat: `~/.claude/scheduled-tasks/bumblebee-hygiene-scan/` (SKILL.md + task-config.json, `type=heartbeat`,
  `bypassTriage:true`, `agent:nexus`, cron `0 9 * * 1`).
- Katalógusok: `~/.claude/tools/bumblebee-threat-intel/` — 6 db (antv-mini-shai-hulud, gemstuffer,
  mini-shai-hulud, node-ipc-credential-stealer, nx-console-vscode-2026-05-18, shopsprint-decimal-typosquat).

**Verifikálva (2026-06-09):** `selftest OK`; tiszta host-szken → 928 csomag, 0 találat, `status=complete`
(csendes ág); szintetikus egyező katalógus → `record_type=finding` rekord, amit a SKILL.md `grep` elkap
(riasztó ág); mind a 4 független adversarial verifier `pass`. A 6 vendored katalógus megegyezik az upstream
v0.1.1 `threat_intel/` tartalmával.

**Gotcha:** a katalógus `schema_version` MEZŐ értéke kötelezően `"0.1.0"` (a bináris csak ezt fogadja el;
bármi más → exit 2). A találat-rekordok és a katalógusok is `"0.1.0"`-t használnak. A futási JSON tömör
(nincs szóköz a kettőspont után), így a `grep '"record_type":"finding"'` byte-pontosan illeszkedik.

**Újraépítés (sudo nélkül, ha a host elveszik):**
```bash
# 1) Go >= 1.25 (no-sudo: tarball a home-ba; a friss 1.25.x a go.dev/dl?mode=json-ből)
cd /tmp && curl -fLO https://go.dev/dl/go1.25.11.linux-amd64.tar.gz
mkdir -p ~/.local ~/.local/bin && rm -rf ~/.local/go && tar -C ~/.local -xzf go1.25.11.linux-amd64.tar.gz
# 2) bumblebee build (PIN v0.1.1)
cd /tmp && git clone https://github.com/perplexityai/bumblebee && cd bumblebee && git checkout v0.1.1
~/.local/go/bin/go build -o ~/.local/bin/bumblebee ./cmd/bumblebee && ~/.local/bin/bumblebee version
# 3) feladat telepítése (placeholder-feloldás + bypassTriage:true a task-configban):
D=~/.claude/scheduled-tasks/bumblebee-hygiene-scan; mkdir -p "$D"
sed -e 's|{{INSTALL_DIR}}|/home/uplinkfather/CITADEL/citadel|g' -e 's/{{MAIN_AGENT_ID}}/nexus/g' \
  seed-scheduled-tasks/bumblebee-hygiene-scan/SKILL.md > "$D/SKILL.md"
# task-config.json: {schedule:"0 9 * * 1",agent:"nexus",enabled:true,type:"heartbeat",skipIfBusy:true,bypassTriage:true}
# 4) katalógusok seedelése (a SKILL.md első futáskor is bemásolja, de előre is megtehető):
C=~/.claude/tools/bumblebee-threat-intel; mkdir -p "$C"
cp seed-scheduled-tasks/bumblebee-hygiene-scan/threat-intel/*.json "$C/"
```
A SKILL.md hibamentesen **kihagyja** a szkent, amíg a bináris nincs meg (info-log, nem hiba) — így a feladat
bináris nélkül is biztonságosan ott állhat. Havi katalógus-frissítés: a SKILL.md 30 naponta `git clone`-ozza
az upstream `threat_intel/`-t (a dir neve aláhúzásos: `threat_intel`).

## Megjegyzések / hátralévő

- A `runDailyDigest` chat-kulcsú (ALLOWED_CHAT_ID) — a heartbeat-memóriák ehhez a chathez taggelve íródnak,
  így a digest látja őket. (A küszöb 1 emlékre csökkentve, hogy csendes napon is fusson.)
