// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { registerStatusRoutes } from './status.js';
import { registerOverviewRoutes } from './overview.js';
import { registerAgentRoutes } from './agents.js';
import { registerAgentConfigRoutes } from './agentConfig.js';
import { registerMessageRoutes } from './messages.js';
import { registerMemoryRoutes } from './memories.js';
import { registerJournalRoutes } from './journal.js';
import { registerKanbanRoutes } from './kanban.js';
import { registerIdeaRoutes } from './ideas.js';
// #386 FÁZIS-0: the cs/csWidget/bk/portal route registrars are NO LONGER wired by the core.
// They are the accounting vertical's routes, registered at boot via the ModuleRegistry
// (modules.registerRoutes in main.ts). The public core never imports them => default-deny.
import { registerPanelRoutes } from './panels.js';
import { registerBackgroundRoutes } from './background.js';
import { registerConnectorRoutes } from './connectors.js';
import { registerObservabilityRoutes } from './observability.js';
import { registerMigrationRoutes } from './migration.js';
import { registerUpdateRoutes } from './updates.js';
import { registerStudioRoutes } from './studio.js';
import { registerFilesRoutes } from './files.js';
import { registerAutonomyRoutes } from './autonomy.js';
import { registerScheduleRoutes } from './schedules.js';
import { registerSkillRoutes } from './skills.js';
import { registerVaultRoutes } from './vault.js';
import { registerChannelRoutes } from './channels.js';
import { registerSettingsRoutes } from './settings.js';
import { registerOnboardingRoutes } from './onboarding.js';
import { registerBillingRoutes } from './billing.js';
import { registerPluginRoutes, registerPluginExtensionRoutes } from './plugins.js';
import { registerWebhookRoutes } from '../../webhook/routes.js';

export function registerAllRoutes(router: Router, ctx: AppContext): void {
  registerStatusRoutes(router, ctx);
  registerOverviewRoutes(router, ctx);
  registerAgentRoutes(router, ctx);
  registerAgentConfigRoutes(router, ctx);
  registerMessageRoutes(router, ctx);
  registerMemoryRoutes(router, ctx);
  registerJournalRoutes(router, ctx);
  registerKanbanRoutes(router, ctx);
  registerIdeaRoutes(router, ctx);
  // #386 FÁZIS-0: cs/csWidget/bk/portal routes moved to the accounting ModulePack
  // (registered after these core routes by modules.registerRoutes in main.ts).
  registerPanelRoutes(router, ctx);
  registerBackgroundRoutes(router, ctx);
  registerConnectorRoutes(router, ctx);
  registerObservabilityRoutes(router, ctx);
  registerMigrationRoutes(router, ctx);
  registerUpdateRoutes(router, ctx);
  registerStudioRoutes(router, ctx);
  registerFilesRoutes(router, ctx);
  registerAutonomyRoutes(router, ctx);
  registerScheduleRoutes(router, ctx);
  registerSkillRoutes(router, ctx);
  registerVaultRoutes(router, ctx);
  registerChannelRoutes(router, ctx);
  registerOnboardingRoutes(router, ctx);
  registerSettingsRoutes(router, ctx);
  registerBillingRoutes(router, ctx);
  registerPluginRoutes(router, ctx);
  registerPluginExtensionRoutes(router, ctx); // each loaded plugin's own (bearer-gated) route
  registerWebhookRoutes(router, ctx); // generic webhook: inbound (HMAC self-authed, public path) + config
}

/** The auth policy constants for the server pipeline (SPEC §17). */
export const AUTH_POLICY = {
  // #386 FÁZIS-0: '/api/cs/widget' moved into accountingModule.publicPaths (merged into the effective
  // policy at main.ts via modules.publicPaths()). The public core has NO vertical public paths.
  publicPaths: ['/api/auth/status', '/api/agents/avatar/*', '/api/plugins/webhook/in/*'],
  allowTokenQuery: (pathname: string): boolean =>
    /^\/api\/agents\/[^/]+\/stream$/.test(pathname) || pathname === '/api/files/raw' || pathname === '/api/studio/media',
};
