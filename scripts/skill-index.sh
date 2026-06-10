#!/bin/bash
# Skill Index Generator (két szint: globális + ágens-lokális)
# Level 0 index (csak név + leírás), hogy a token-használat alacsony maradjon, minden
# skill mégis felfedezhető legyen.
#
#   - Globális index:  ~/.claude/skills/.skill-index.md
#                      a flotta-szintű skillek; ez egyben NEXUS indexe is.
#   - Ágens-lokális:   <repo>/agents/<név>/.claude/skills/.skill-index.md
#                      = a GLOBÁLIS skillek + AZ ADOTT ágens lokális skilljei.
#                      Soha nem tartalmazza más ágens lokális skilljeit.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GLOBAL_SKILLS_DIR="$HOME/.claude/skills"
AGENTS_DIR="$REPO_ROOT/agents"

# Egy Markdown táblasort ad ki (| `név` | leírás |) egy skill-könyvtárból.
# A SKILL.md frontmatteréből szedi a name/description mezőt (best-effort).
emit_skill_row() {
  local skill_dir="$1"
  local skill_md="$skill_dir/SKILL.md"
  [ -f "$skill_md" ] || return 1
  local name desc
  name=$(grep -m1 "^name:" "$skill_md" 2>/dev/null | sed 's/^name: *//' | tr -d '"' | tr -d "'")
  [ -z "$name" ] && name=$(basename "$skill_dir")
  desc=$(grep -m1 "^description:" "$skill_md" 2>/dev/null | sed 's/^description: *//' | tr -d '"' | tr -d "'" | cut -c1-120)
  [ -z "$desc" ] && desc="(nincs leírás)"
  echo "| \`$name\` | $desc |"
  return 0
}

# A $1 könyvtár összes skilljét a $2 fájlba fűzi; a stdoutra a darabszámot adja.
emit_skill_table() {
  local dir="$1" out="$2" count=0
  if [ -d "$dir" ]; then
    for skill_dir in "$dir"/*/; do
      [ -d "$skill_dir" ] || continue
      if emit_skill_row "$skill_dir" >> "$out"; then
        count=$((count + 1))
      fi
    done
  fi
  echo "$count"
}

# --- 1) Globális index (flotta-szintű; egyben NEXUS indexe) ---
if [ -d "$GLOBAL_SKILLS_DIR" ]; then
  OUT="$GLOBAL_SKILLS_DIR/.skill-index.md"
  {
    echo "# Skill Index — Globális (Level 0)"
    echo ""
    echo "A flotta-szintű (mindenki által elérhető) skillek indexe. Csak név + leírás (Level 0)."
    echo "Globális skill létrehozása/patch-elése NEXUS-jóváhagyáshoz kötött (mindenkit érint)."
    echo "Ha egy skill releváns, olvasd be a teljes SKILL.md-t (Level 1); segédfájlok: scripts/, references/ (Level 2)."
    echo ""
    echo "| Skill | Leírás |"
    echo "|-------|--------|"
  } > "$OUT"
  GCOUNT=$(emit_skill_table "$GLOBAL_SKILLS_DIR" "$OUT")
  {
    echo ""
    echo "_${GCOUNT} globális skill indexelve. Generálva: $(date '+%Y-%m-%d %H:%M')_"
  } >> "$OUT"
  echo "Global skill index: $OUT ($GCOUNT skills)"
fi

# --- 2) Ágensenkénti index = globális + az adott ágens lokális skilljei ---
if [ -d "$AGENTS_DIR" ]; then
  for agent_skills in "$AGENTS_DIR"/*/.claude/skills; do
    [ -d "$agent_skills" ] || continue
    agent_name=$(basename "$(dirname "$(dirname "$agent_skills")")")
    OUT="$agent_skills/.skill-index.md"
    {
      echo "# Skill Index — ${agent_name} (Level 0)"
      echo ""
      echo "Az elérhető skilljeid: a GLOBÁLIS (flotta-szintű) skillek + a SAJÁT ágens-lokális skilljeid."
      echo "Más ágens lokális skilljeit nem látod. Lokálisat (agents/${agent_name}/.claude/skills/) szabadon"
      echo "hozhatsz létre/patchelhetsz; globálisat (~/.claude/skills/) csak NEXUS-jóváhagyással."
      echo ""
      echo "## Globális skillek (~/.claude/skills/)"
      echo ""
      echo "| Skill | Leírás |"
      echo "|-------|--------|"
    } > "$OUT"
    GCOUNT=$(emit_skill_table "$GLOBAL_SKILLS_DIR" "$OUT")
    {
      echo ""
      echo "## Saját lokális skillek (agents/${agent_name}/.claude/skills/)"
      echo ""
      echo "| Skill | Leírás |"
      echo "|-------|--------|"
    } >> "$OUT"
    LCOUNT=$(emit_skill_table "$agent_skills" "$OUT")
    if [ "$LCOUNT" -eq 0 ]; then
      echo "| _(nincs lokális skill)_ | |" >> "$OUT"
    fi
    {
      echo ""
      echo "_${GCOUNT} globális + ${LCOUNT} lokális skill. Generálva: $(date '+%Y-%m-%d %H:%M')_"
    } >> "$OUT"
    echo "Agent skill index: $OUT (${GCOUNT} global + ${LCOUNT} local)"
  done
fi
