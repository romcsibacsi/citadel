# Plugins

The orchestrator has two plugin systems, both operator-gated:

1. **Claude Code plugins (per agent)** — manage each agent's native Claude Code
   marketplaces + enabled plugins from the dashboard (no shelling into the agent).
2. **Orchestrator extension plugins** — extend the orchestrator *itself* (new views,
   routes, scheduled tasks, agent tools) without forking the core.

---

## 1. Claude Code plugins (per agent)

The **Plugins** view (and `/api/plugins/agent/:id/*`) reads/writes each agent's
config-root:

- `config-root/plugins/known_marketplaces.json` — marketplaces (`{ name, source }`,
  source = a git URL or a local path).
- `config-root/.claude.json` → `enabledPlugins` — which plugins are on for that agent.

Add a marketplace, browse the plugins it offers, enable/disable per agent (or
"enable for all"), then **Apply** restarts the agent so Claude Code reloads its
plugins. A plugin runs with the **agent's** permissions: it can never grant the
agent more than its security profile allows, and plugin-bundled hooks/commands/MCP
are still subject to the agent's permission rules. Install/enable is always a
deliberate operator action; nothing is auto-enabled.

---

## 2. Orchestrator extension plugins

A plugin is a directory under the orchestrator's `plugins/` dir:

```
plugins/<id>/
  manifest.json     # id, name, version, author?, description?, apiVersion, capabilities?
  index.js          # ESM, exports `register(api)`
```

### manifest.json

```json
{
  "id": "hello-extension",
  "name": "Hello Extension",
  "version": "1.0.0",
  "author": "you",
  "description": "what it does",
  "apiVersion": 1,
  "capabilities": ["view", "route", "scheduledTask", "agentTool"]
}
```

`apiVersion` must match the host API version (currently **1**). A mismatch is
refused (the plugin is marked `failed`, the host keeps running).

### The host API (`register(api)`)

The `register` function receives a **restricted** API — and nothing else. There is
no AppContext, no `saveConfig`, no vault, no billing, no bearer token, no agent
spawn. These omissions are the safety boundary.

```js
export const register = (api) => {
  api.registerView({ id, navLabel, icon?, render: () => '<html string>' });
  api.registerRoute({ method, path, handler: (ctx) => ctx.json(status, payload) });
  api.registerScheduledTask({ name, schedule /* cron */, run: () => {} });
  api.registerAgentTool({ name, schema, run: (args, { agentId }) => result });
  api.log('message');
};
```

- **View** — a nav item + a server-rendered HTML panel. The dashboard fetches your
  HTML and frames it in a **fully-sandboxed iframe** (`sandbox=""` — no script
  execution, opaque origin), so a view is a **static** panel: any `<script>` or
  inline event handler in your HTML will NOT run, and it can never reach the operator
  token or the dashboard DOM. (This is the boundary that stops a view-capable plugin
  from escalating privilege through the operator's browser.)
- **Route** — reachable at `/api/plugins/ext/<id><path>`. The host **bearer-gates and
  CSRF-checks** it like every other `/api/*` route; your handler gets only the
  restricted `{ method, query, body, json }` context (never the raw req/res/token).
- **Scheduled task** — a cron-driven `run()` on the existing scheduler, isolated.
- **Agent tool** — a tool an agent can call BY NAME via `POST /api/agent-tools/<name>`
  (the same bearer-gated surface agents use for everything else). The flow:
  1. only an **enabled** plugin's tool resolves (a disabled/removed plugin's tool 404s);
  2. **the privilege gate runs first** — if the tool declares a `requiredPermission`
     (`{ tool, specifier }`, the same vocabulary as a profile rule, e.g.
     `{ tool: 'Bash', specifier: 'sudo *' }`), the host evaluates it against the
     **requesting agent's** security profile (`decidePermission`); anything the profile
     does not `allow` (a `deny` or an `ask`) is **refused** (403), never silently run.
     A tool with no `requiredPermission` is a pure tool and skips the gate;
  3. the tool's `run(args, { agentId })` is **bounded by a timeout and isolated** — a
     throw or hang returns a 502 to the agent and never takes down the host or peers;
  4. `run` receives ONLY `{ agentId }` — no AppContext, billing, vault, or saveConfig —
     so a plugin tool cannot escalate privilege or change billing.

  ```js
  api.registerAgentTool({
    name: 'fetch_page',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    requiredPermission: { tool: 'WebFetch' }, // gated against the calling agent's profile
    run: async (args, { agentId }) => ({ /* ... */ }),
  });
  ```

### Lifecycle + safety

- **Disabled by default.** A plugin runs only when the operator enables it
  (Settings / `config.plugins.enabled` ∪ the `plugin-extensions-enabled` setting).
- **Isolated.** A plugin that throws on load or in `register()` is logged and marked
  `failed`; the supervisor and the other plugins keep running.
- **Cannot** change the billing mode, read undeclared secrets, bypass auth, or
  escalate privilege — none of those surfaces exist on the host API, and a view's HTML
  is sandboxed (no script execution) so it cannot escalate through the operator browser.
- **Namespaced.** A plugin id must be a simple slug (`^[a-z0-9][a-z0-9-]*$`) and a route
  path one or more dot-free segments — enforced at registration, so a crafted manifest
  cannot escape its `/api/plugins/ext/<id>/` subtree or shadow a core route.

See `seed/plugins/hello-extension/` for a complete reference plugin.
