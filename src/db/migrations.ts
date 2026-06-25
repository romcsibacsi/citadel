// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Migration } from './database.js';

/**
 * Full v1 schema. All checked enums were decided up front (SPEC §22.5) so we
 * avoid table-rebuild migrations later. Future changes are appended as new
 * additive Migration entries — never edits to applied ones.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001-core-schema',
    up: (db) => {
      // --- inter-agent message queue (SPEC §6) ---
      db.exec(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','delivered','done','failed')),
        result TEXT,
        error TEXT,
        channel_meta TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        completed_at TEXT
      )`);
      db.exec(`CREATE INDEX idx_messages_pending ON messages (recipient, id) WHERE status = 'pending'`);
      db.exec(`CREATE INDEX idx_messages_thread ON messages (recipient, sender, id)`);
      db.exec(`CREATE INDEX idx_messages_sender_thread ON messages (sender, recipient, id)`);

      // --- memories (SPEC §8) — never DELETEd, only decayed/archived ---
      db.exec(`CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('hot','warm','cold','shared')),
        sector TEXT NOT NULL DEFAULT 'semantic' CHECK (sector IN ('semantic','episodic')),
        content TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '',
        salience REAL NOT NULL DEFAULT 1.0,
        embedding BLOB,
        auto_generated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        accessed_at TEXT,
        archived_at TEXT
      )`);
      db.exec(`CREATE INDEX idx_memories_agent ON memories (agent_id, category)`);
      db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(
        content, keywords, content='memories', content_rowid='id'
      )`);
      db.exec(`CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
      END`);
      db.exec(`CREATE TRIGGER memories_fts_au AFTER UPDATE OF content, keywords ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
        INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords);
      END`);
      db.exec(`CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES ('delete', old.id, old.content, old.keywords);
      END`);

      // --- conversation ledger (SPEC §8 continuity invariant) ---
      db.exec(`CREATE TABLE conversation_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        message_id TEXT,
        body TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      )`);
      // Inbound idempotency: unique on (agent, chat, direction, message_id) where present.
      // Outbound rows carry NULL message_id so they never dedupe against each other.
      db.exec(`CREATE UNIQUE INDEX uq_ledger_inbound
        ON conversation_ledger (agent_id, chat_id, direction, message_id)
        WHERE message_id IS NOT NULL`);
      db.exec(`CREATE INDEX idx_ledger_recent ON conversation_ledger (agent_id, chat_id, id)`);

      // --- daily logs (learning loop, SPEC §9) ---
      db.exec(`CREATE TABLE daily_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        day TEXT NOT NULL,
        line TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX idx_daily_logs_day ON daily_logs (day, agent_id)`);

      // --- scheduled tasks + runner state (SPEC §9) ---
      db.exec(`CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cron TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task','heartbeat')),
        enabled INTEGER NOT NULL DEFAULT 1,
        skip_if_busy INTEGER NOT NULL DEFAULT 0,
        force_send INTEGER NOT NULL DEFAULT 0,
        bypass_triage INTEGER NOT NULL DEFAULT 0,
        session_target TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE task_last_run (
        task_id TEXT PRIMARY KEY,
        last_run_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        fired_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('delivered','queued','skipped','failed')),
        detail TEXT
      )`);
      db.exec(`CREATE INDEX idx_task_runs_task ON task_runs (task_id, id)`);
      db.exec(`CREATE TABLE task_retry_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        target TEXT NOT NULL,
        prompt TEXT NOT NULL,
        force_send INTEGER NOT NULL DEFAULT 0,
        queued_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        alerted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','delivered','cancelled'))
      )`);
      db.exec(`CREATE INDEX idx_retry_pending ON task_retry_queue (status, target) WHERE status = 'pending'`);

      // --- kanban (SPEC §11) ---
      db.exec(`CREATE TABLE kanban_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned','in_progress','waiting','done')),
        assignee TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low','normal','high','urgent')),
        project TEXT,
        parent_id INTEGER REFERENCES kanban_cards(id),
        sort_order REAL NOT NULL DEFAULT 0,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        dispatched_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX idx_kanban_status ON kanban_cards (status, archived_at)`);
      db.exec(`CREATE INDEX idx_kanban_parent ON kanban_cards (parent_id)`);
      db.exec(`CREATE TABLE kanban_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX idx_kanban_comments_card ON kanban_comments (card_id, id)`);

      // --- idea box (SPEC §12) ---
      db.exec(`CREATE TABLE ideas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL DEFAULT 'new'
          CHECK (status IN ('new','reviewed','kanban','rejected','archived')),
        source TEXT NOT NULL DEFAULT '',
        kanban_id INTEGER REFERENCES kanban_cards(id),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX idx_ideas_status ON ideas (status)`);
      // one idea per promoted card — hardens the bidirectional link invariant
      db.exec(`CREATE UNIQUE INDEX uq_ideas_kanban ON ideas (kanban_id) WHERE kanban_id IS NOT NULL`);

      // --- autonomy ladder (SPEC §12) ---
      db.exec(`CREATE TABLE autonomy_settings (
        category TEXT PRIMARY KEY,
        level INTEGER NOT NULL CHECK (level IN (1,2,3)),
        max_level INTEGER NOT NULL DEFAULT 3 CHECK (max_level IN (1,2,3)),
        locked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        CHECK (level <= max_level)
      )`);

      // --- desired run state (SPEC §3) ---
      db.exec(`CREATE TABLE agent_desired_state (
        agent_id TEXT PRIMARY KEY,
        desired TEXT NOT NULL CHECK (desired IN ('running','stopped')),
        updated_at TEXT NOT NULL
      )`);

      // --- spawn approval queue (SPEC §15) ---
      db.exec(`CREATE TABLE spawn_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requester TEXT,
        agent_id TEXT NOT NULL,
        display_name TEXT,
        profile TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','denied','expired')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`);

      // --- channel client state (SPEC §7) ---
      db.exec(`CREATE TABLE channel_offsets (
        provider TEXT PRIMARY KEY,
        offset_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE channel_dedup (
        provider TEXT NOT NULL,
        update_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (provider, update_id)
      )`);

      // --- session map (chat -> session, SPEC §18) ---
      db.exec(`CREATE TABLE session_map (
        agent_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, chat_id)
      )`);

      // --- task-state save/replay (SPEC §9) ---
      db.exec(`CREATE TABLE agent_task_state (
        agent_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      // --- vault (SPEC §16) ---
      db.exec(`CREATE TABLE vault_secrets (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        ciphertext BLOB NOT NULL,
        iv BLOB NOT NULL,
        salt BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE vault_bindings (
        secret_id TEXT NOT NULL REFERENCES vault_secrets(id) ON DELETE CASCADE,
        env_var TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (secret_id, env_var, target)
      )`);
    },
  },
  {
    // Kanban cards gain an optional due date (PROMPT-05). Additive + nullable.
    id: '0002-kanban-due-date',
    up: (db) => {
      db.exec(`ALTER TABLE kanban_cards ADD COLUMN due_at TEXT`);
    },
  },
  {
    // Background one-shot tasks (PROMPT-12): a detached headless run per row.
    // task_id is the short 8-hex public id; status is constrained to the four
    // observable states; output is captured at finalization.
    id: '0003-background-tasks',
    up: (db) => {
      db.exec(`CREATE TABLE background_tasks (
        rowid_pk    INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL UNIQUE,
        agent_id    TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','done','failed','timeout')),
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        output      TEXT
      )`);
      db.exec(`CREATE INDEX idx_bg_agent_status ON background_tasks (agent_id, status)`);
      db.exec(`CREATE INDEX idx_bg_status ON background_tasks (status)`);
    },
  },
  {
    // MCP connectors (PROMPT-13): operator-managed connector records, github-repo
    // installs, external project paths, and a tiny live-cache meta kv. Secret
    // VALUES never live here — only env var names (the values go to the vault).
    id: '0004-connectors',
    up: (db) => {
      db.exec(`CREATE TABLE connectors (
        rowid_pk   INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        scope      TEXT NOT NULL,
        agent_id   TEXT,
        type       TEXT NOT NULL,
        endpoint   TEXT,
        source     TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'configured',
        env_names  TEXT NOT NULL DEFAULT '[]',
        catalog_id TEXT,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX idx_connectors_name ON connectors (name)`);
      db.exec(`CREATE TABLE connector_repos (
        rowid_pk     INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL UNIQUE,
        url          TEXT NOT NULL,
        installed_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE connector_paths (
        rowid_pk   INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE connector_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    },
  },
  {
    // Token usage accounting + tool-call log (PROMPT-14). Usage is accounting
    // against rate-limit windows, NOT money. token_usage is de-duplicated by
    // (agent, session, ts, input, output). tool_log feeds workflow analysis.
    id: '0005-observability',
    up: (db) => {
      db.exec(`CREATE TABLE token_usage (
        rowid_pk        INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id        TEXT NOT NULL,
        session_id      TEXT NOT NULL DEFAULT '',
        ts              TEXT NOT NULL,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_read      INTEGER NOT NULL DEFAULT 0,
        cache_creation  INTEGER NOT NULL DEFAULT 0,
        content_preview TEXT,
        tool_name       TEXT,
        task_title      TEXT,
        project         TEXT,
        UNIQUE (agent_id, session_id, ts, input_tokens, output_tokens)
      )`);
      db.exec(`CREATE INDEX idx_usage_ts ON token_usage (ts)`);
      db.exec(`CREATE INDEX idx_usage_agent_ts ON token_usage (agent_id, ts)`);
      db.exec(`CREATE TABLE token_collector_cursor (source TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
      db.exec(`CREATE TABLE tool_log (
        rowid_pk      INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        input_summary TEXT,
        success       INTEGER NOT NULL DEFAULT 1,
        ts            TEXT NOT NULL
      )`);
      db.exec(`CREATE INDEX idx_toollog_ts ON tool_log (ts)`);
    },
  },
  {
    // Generic operator app settings kv (PROMPT-16 integrations, reused by later
    // views). Non-secret values only — secrets always live in the vault.
    id: '0006-app-settings',
    up: (db) => {
      db.exec(`CREATE TABLE app_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    },
  },
  {
    // Channel management (FIX-channels): per-agent approved chats become the
    // dynamic inbound allowlist, and unknown chats land as pending pairings the
    // operator approves from the Channel surface. No token/value rows here —
    // credentials stay in the vault; invite links are minted on demand, not stored.
    id: '0007-channel-bindings',
    up: (db) => {
      db.exec(`CREATE TABLE channel_bindings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        chat_id  TEXT NOT NULL,
        label    TEXT NOT NULL DEFAULT '',
        kind     TEXT NOT NULL DEFAULT 'dm',
        bound_at TEXT NOT NULL,
        UNIQUE (agent_id, provider, chat_id)
      )`);
      db.exec(`CREATE TABLE channel_pairing_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        chat_id  TEXT NOT NULL,
        display_user TEXT NOT NULL DEFAULT '',
        status   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
        requested_at TEXT NOT NULL,
        resolved_at  TEXT,
        agent_id TEXT,
        UNIQUE (provider, chat_id)
      )`);
    },
  },
  {
    // Pending-retry last reason (FIX-07 §4.2/§6.8): persist the delivery result
    // (busy/down) that caused a retry to be queued / re-fail, so the Schedules
    // pending banner can surface a per-row reason line. Nullable + additive.
    id: '0008-retry-last-reason',
    up: (db) => {
      db.exec(`ALTER TABLE task_retry_queue ADD COLUMN last_reason TEXT`);
    },
  },
  {
    // FIX-channels-2: persisted channel invite links with a lifecycle (active /
    // revoked; expired is derived from expires_at) so the panel can list + refresh
    // + revoke them; plus a short pairing CODE so a pairing can be approved by the
    // code the operator was given. Both additive + nullable.
    id: '0009-channel-invites',
    up: (db) => {
      db.exec(`CREATE TABLE channel_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        link TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`);
      db.exec(`ALTER TABLE channel_pairing_requests ADD COLUMN code TEXT`);
    },
  },
  {
    // Per-connector enable/disable (FIX-connectors-custom-mcp): a disabled
    // connector is kept but flagged off. Defaults to 1 so every existing row
    // stays enabled across the upgrade.
    id: '0010-connector-enabled',
    up: (db) => {
      db.exec(`ALTER TABLE connectors ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
    },
  },
  {
    // NEXUS judge-panel (BUILD-judge-panel Phase 1): a panel = one parent kanban
    // card + flat child cards (solvers + judges). These tables hold the structured
    // state the comment trail can't query: the panel state machine, per-solver
    // solutions, and the judge roster. Verdict/decision/gate tables arrive in their
    // own phases. The kanban cards stay the unit of dispatch + the board object.
    id: '0011-judge-panel',
    up: (db) => {
      db.exec(`CREATE TABLE panels (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_card_id  INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'soliciting'
                          CHECK (status IN ('soliciting','debating','judging','deciding','gated_review','applied','rejected')),
        rubric          TEXT NOT NULL DEFAULT '{}',
        decision_rule   TEXT NOT NULL DEFAULT '{}',
        test_command    TEXT NOT NULL,
        branch_prefix   TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      )`);
      db.exec(`CREATE TABLE panel_solutions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id        INTEGER NOT NULL,
        solver_agent_id TEXT NOT NULL,
        child_card_id   INTEGER NOT NULL,
        branch          TEXT NOT NULL,
        angle           TEXT NOT NULL DEFAULT '',
        commit_sha      TEXT,
        tail_summary    TEXT,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','produced','timeout','failed')),
        deadline_at     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        FOREIGN KEY (panel_id) REFERENCES panels (id)
      )`);
      db.exec(`CREATE TABLE panel_judges (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id        INTEGER NOT NULL,
        role            TEXT NOT NULL CHECK (role IN ('probe','oracle')),
        judge_agent_id  TEXT NOT NULL,
        child_card_id   INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','dispatched','verdicts_in','failed')),
        deadline_at     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        FOREIGN KEY (panel_id) REFERENCES panels (id)
      )`);
      db.exec(`CREATE INDEX idx_panel_solutions_panel ON panel_solutions (panel_id)`);
      db.exec(`CREATE INDEX idx_panel_judges_panel ON panel_judges (panel_id)`);
    },
  },
  {
    // Judge-panel verdicts (BUILD-judge-panel Phase 2): one verdict per (solution,
    // judge). PROBE refutes, ORACLE verifies correctness. Judges run in parallel and
    // never see each other's verdicts. A malformed verdict is re-injected ONCE
    // (reinjects guard) then escalated.
    id: '0012-panel-verdicts',
    up: (db) => {
      db.exec(`CREATE TABLE panel_verdicts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id        INTEGER NOT NULL,
        solution_id     INTEGER NOT NULL,
        judge           TEXT NOT NULL CHECK (judge IN ('probe','oracle')),
        scores          TEXT NOT NULL DEFAULT '{}',
        refutations     TEXT NOT NULL DEFAULT '[]',
        recommendation  TEXT NOT NULL CHECK (recommendation IN ('accept','reject','revise')),
        fatal_defect    INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        UNIQUE (panel_id, solution_id, judge),
        FOREIGN KEY (panel_id) REFERENCES panels (id)
      )`);
      db.exec(`CREATE INDEX idx_panel_verdicts_panel ON panel_verdicts (panel_id)`);
      db.exec(`ALTER TABLE panel_judges ADD COLUMN reinjects INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    // Judge-panel decision (BUILD-judge-panel Phase 3): ONE immutable decision per
    // panel (UNIQUE panel_id → write-once). winning_solution_id is nullable (null =
    // no winner, all vetoed). rule_output is the full deterministic ranked trace;
    // snapshot is the FROZEN rule inputs, persisted so the decision replays bit-for-bit.
    id: '0013-panel-decisions',
    up: (db) => {
      db.exec(`CREATE TABLE panel_decisions (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id             INTEGER NOT NULL UNIQUE,
        winning_solution_id  INTEGER,
        decided_by           TEXT NOT NULL,
        rule_output          TEXT NOT NULL DEFAULT '{}',
        snapshot             TEXT NOT NULL DEFAULT '{}',
        created_at           TEXT NOT NULL,
        FOREIGN KEY (panel_id) REFERENCES panels (id)
      )`);
    },
  },
  {
    // Judge-panel gate (BUILD-judge-panel Phase 4): the evidence-backed branch→test→
    // review→approve gate over the WINNER's branch only. One row per (panel, stage),
    // UNIQUE → idempotent stage writes. The apply ROUTE handler is where the hard
    // predicate (test=passed AND review=passed AND approve=passed) is enforced before
    // any merge — never in a swallowed hook. `panels.category` drives the HARD_LOCKED
    // apply-boundary check (a locked category can never self-apply); `applied_at`
    // stamps the terminal apply.
    id: '0014-panel-gates',
    up: (db) => {
      db.exec(`CREATE TABLE panel_gates (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        panel_id     INTEGER NOT NULL,
        stage        TEXT NOT NULL CHECK (stage IN ('branch','test','review','approve','apply')),
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed','handoff')),
        evidence_ref TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        UNIQUE (panel_id, stage),
        FOREIGN KEY (panel_id) REFERENCES panels (id)
      )`);
      db.exec(`CREATE INDEX idx_panel_gates_panel ON panel_gates (panel_id)`);
      db.exec(`ALTER TABLE panels ADD COLUMN category TEXT NOT NULL DEFAULT 'code_change'`);
      db.exec(`ALTER TABLE panels ADD COLUMN applied_at TEXT`);
    },
  },
  {
    // FIX-panel-v1.1 Part A: agent-initiated panels — record the principal that started the
    // panel (operator vs which agent) for the audit trail. Defaults to 'operator' for any
    // pre-existing row. Apply/approve stay operator-only (the hard gate is unchanged).
    id: '0015-panel-initiator',
    up: (db) => {
      db.exec(`ALTER TABLE panels ADD COLUMN created_by TEXT NOT NULL DEFAULT 'operator'`);
    },
  },
];
