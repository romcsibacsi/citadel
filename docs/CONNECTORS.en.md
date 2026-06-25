# Wiring your own MCP connector

An **MCP server** gives the agents extra tools (filesystem, a database, a SaaS API, …).
CITADEL manages connectors from the **Connectors** view (Operator-only). This guide
mirrors the in-app help panel.

## The two standard shapes

### stdio (a local command)
The agent **spawns a local process** and talks to it over stdin/stdout.

- **Command** — the executable, e.g. `npx -y @modelcontextprotocol/server-filesystem`
- **Args** — optional, e.g. `/data`
- The command runs on **this host**, so it must be installed / on `PATH`. Use the
  **Test** button — it checks the command resolves (it never executes it).

### HTTP / SSE (a remote server)
The agent reaches a server **over a URL**.

- **URL** — the `https://` endpoint, e.g. `https://mcp.example.com/mcp`
- Auth, if any, is provided as an **env var** (see Secrets). Use **Test** — it does a
  bounded HTTP GET; a `2xx`, `401`, `403`, or `405` all prove the endpoint answered.

## Secrets

Add only the **env var NAME** on the connector form. The **VALUE** goes to the **Vault**
and is never stored or logged with the connector. The **Test** button never sends your
secrets — it only probes reachability / command resolution.

## Assign + enable/disable

- A **project-scoped** connector can be **assigned** to specific sub-agents; the hub
  always has access.
- Each connector has an **Enable / Disable** toggle — turn one off without deleting it.
  A disabled connector is dimmed in the list and struck through.

## Examples

**stdio (filesystem):**
- Command: `npx -y @modelcontextprotocol/server-filesystem`
- Args: `/data`

**HTTP (with a bearer token):**
- URL: `https://mcp.example.com/mcp`
- Env var: `MCP_TOKEN` (value stored in the Vault, sent by your server config as the
  `Authorization: Bearer …` header)

## Notes

- The live `claude mcp` scan is behind a seam; **Refresh** stamps the cache. Everything
  you add here is persisted.
- Don't re-add locally something already enabled upstream in your Claude subscription —
  it duplicates and the CLI warns "local wins".
