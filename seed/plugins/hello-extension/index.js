/**
 * Reference orchestrator extension plugin (FIX-plugins Part B). It registers ONE
 * of each extension point through the versioned host API. Note what it does NOT
 * get: no AppContext, no saveConfig, no vault, no billing, no bearer token, no
 * agent spawn — the host bearer-gates the route and the privilege gate stays the
 * sole authority. Plain ESM JS (the host dynamic-imports it from the plugins dir).
 */
export const register = (api) => {
  api.registerView({
    id: 'hello',
    navLabel: 'Hello plugin',
    icon: 'plug',
    render: () =>
      '<div class="panel"><div class="panel-title">Hello from a plugin</div>' +
      '<p class="field-note">This panel is rendered server-side by the example extension plugin via the host API, then framed by the dashboard.</p></div>',
  });

  api.registerRoute({
    method: 'GET',
    path: '/ping',
    handler: (ctx) => ctx.json(200, { ok: true, plugin: api.pluginId, reply: 'pong' }),
  });

  api.registerScheduledTask({
    name: 'hello-heartbeat',
    schedule: '0 * * * *',
    run: () => api.log('hello-heartbeat fired'),
  });

  api.registerAgentTool({
    name: 'hello_echo',
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (args, ctx) => ({ echoed: String(args.text ?? ''), by: ctx.agentId }),
  });
};
