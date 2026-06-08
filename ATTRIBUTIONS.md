# Attribúciók / Köszönet

A **CITADEL** egy egyszemélyes AI-ügynök orchestration rendszer, amely egy nyílt forrású,
MIT-licencelt upstream agent-framework **hardened forkja**, és több külső projektre, illetve
koncepcióra épít. Ez a dokumentum azokat a forrásokat krediteli, amelyek beépültek a kódbázisba
vagy érdemi hatással voltak a tervezésre.

A CITADEL saját licensze: [LICENSE](./LICENSE) (MIT).

## Upstream alap (a fork forrása)

- **Projekt**: a CITADEL alapját adó nyílt forrású agent-framework
- **Szerző**: Szotasz
- **Licensz**: MIT (lásd [LICENSE](./LICENSE) — az eredeti szerzői jogi sor megtartva)
- **Forrás**: https://github.com/Szotasz/marveen
- **Mit vettünk át**: a CITADEL ennek a frameworknek a forkja; a mag-architektúra (Claude Code
  headless tmux-session-ök, memory tiers, kanban, channel-plugin, autonómia-config, multi-agent
  inter-agent messaging) innen származik, majd CITADEL-re átnevezve és hardening-elve.

## Becsomagolt vagy adaptált kód

### Bumblebee (ellátási-lánc biztonsági scanner)
- **Forrás**: https://github.com/perplexityai/bumblebee
- **Szerző**: Perplexity AI
- **Licensz**: Apache 2.0
- **Hol a CITADEL-ben**: `seed-scheduled-tasks/bumblebee-hygiene-scan/` (a bináris, a scan profil és a
  beépített threat-intel katalógusok az integráció időpontjában aktuális verziójukkal)
- **Mit csinál nálunk**: heti hétfő 09:00-kor read-only leltár a telepített csomagokról, MCP
  konfigurációkról és kiterjesztésekről, összeillesztve a beépített ellátási-lánc fenyegetés-
  katalógusokkal. Csak találat esetén szól.

### Zhutov skill csomag (handoff / retrospective / skill-management)
- **Forrás**: https://artemxtech.substack.com/p/3-claude-code-skills-that-make-claude
- **Szerző**: Artem Zhutov
- **Hol a CITADEL-ben**: `seed-skills/handoff/`, `seed-skills/retrospective/`, `seed-skills/skill-management/`
- **Mit csinál nálunk**: a skill-csontváz a CITADEL flotta-architektúrájára adaptálva. Az 5-szekciós
  handoff struktúra (Goal, Current Progress, What Worked, What Didn't Work, Next Steps), a sub-agent
  retrospective minta, és a skill-rot életciklus-kezelés koncepció mind Zhutov csomagjából származik.

### printing-press (agent-CLI generátor)
- **Forrás**: https://github.com/mvanhorn/cli-printing-press
- **Szerző**: Mike Van Horn
- **Hol a CITADEL-ben**: generátor eszközként használjuk (nem becsomagolva) — ezzel készülnek a
  CLI-csomagok, amelyek külső API-kat csomagolnak, plusz a hozzájuk tartozó Claude Code skill fájlok.

## Koncepcionális hatás (nem becsomagolt kód)

### Mark Kashef — Claude Code-alapú AI-asszisztens architektúra
- **Forrás**: https://youtube.com/@mark_kashef
- **Hol a CITADEL-ben**: az alapkoncepció (Claude Code mint folyamatosan futó AI-asszisztens, saját
  csatornával, tmux-session-alapú headless működéssel, scheduled-task-okkal).

### Karpathy CLAUDE.md alapelvek
- **Forrás**: Andrej Karpathy CLAUDE.md útmutatása (publikus)
- **Hol a CITADEL-ben**: a gyökér `CLAUDE.md` mintareferenciája. Nem másoltunk kódot; a felépítés és a
  szabály-stílus Karpathy mintájából inspirálódott.

### Matt Pocock — "/handoff is my new favourite skill"
- **Forrás**: https://youtu.be/dtAJ2dOd3ko
- **Hol a CITADEL-ben**: a "purpose" argumentum mint kötelező paraméter a `/handoff`-on, és a
  cross-agent portable design (hogy egy HANDOFF.md működjön Claude Code, Codex, Copilot CLI közt).

---

Ha hiányzó attribúciót észlelsz vagy korrekciót szeretnél, nyiss egy issue-t: https://github.com/romcsibacsi/citadel
