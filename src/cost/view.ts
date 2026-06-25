// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { CostStore, UsageAggregate, UsageTotals, DayPoint } from './store.js';
import { rollup, type AgentSource } from './rollup.js';

/**
 * Cost / usage dashboard view + budget alert (FIX-plugin-cost-dashboard).
 *
 * MODE-AWARE by construction (the billing invariant is untouchable from here):
 *  - API billing mode → tokens × an operator-editable price table (input/output
 *    $/1M) produce a dollar figure that is ALWAYS labelled an estimate.
 *  - Subscription billing mode → VOLUME ONLY. No price table, no dollar figure,
 *    nothing that implies a per-token cost (it's a flat-rate pool).
 *  The renderer only ever READS `config.billing.mode`; it never writes it.
 *
 * The optional soft budget alert is purely informational: when monthly usage
 * crosses an operator-set token (or, in API mode, dollar-estimate) threshold it
 * drops ONE operator notice. It MUST NOT — and structurally cannot — change the
 * billing mode, disable an agent, or throttle anything: it is handed only a
 * notifier callback. See {@link checkBudget}.
 */

export type BillingMode = 'subscription' | 'api';

/** Per-model $/1M price (editable by the operator; defaults are seeded estimates). */
export interface ModelPrice {
  /** USD per 1,000,000 input (and cache) tokens. */
  inputPerM: number;
  /** USD per 1,000,000 output tokens. */
  outputPerM: number;
}

/**
 * Default, OPERATOR-EDITABLE price table (USD per 1M tokens). These are seeded
 * estimates only — the operator edits them in the view, and every dollar figure
 * derived from them is labelled an estimate. Values reflect the current model
 * catalogue ($/1M input / output): Fable 5 10/50, Opus 4.8 5/25, Sonnet 4.6
 * 3/15, Haiku 4.5 1/5.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { inputPerM: 10, outputPerM: 50 },
  'claude-opus-4-8': { inputPerM: 5, outputPerM: 25 },
  'claude-opus-4-7': { inputPerM: 5, outputPerM: 25 },
  'claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
};

/** A fallback price used for an unknown model so an estimate is never silently 0. */
const FALLBACK_PRICE: ModelPrice = { inputPerM: 5, outputPerM: 25 };

/** Minimal i18n surface the renderer needs (matches the app's I18n.t). */
export interface Translator {
  t(key: string, params?: Record<string, string | number>): string;
}

/** Estimated USD for a single model's token volume (input+cache priced as input). */
export function estimateCostUsd(
  inTok: number,
  outTok: number,
  cacheTok: number,
  price: ModelPrice,
): number {
  const inputUsd = ((inTok + cacheTok) / 1_000_000) * price.inputPerM;
  const outputUsd = (outTok / 1_000_000) * price.outputPerM;
  return inputUsd + outputUsd;
}

/** Resolve a model's price from the (merged) table, falling back when unknown. */
export function priceFor(model: string, prices: Record<string, ModelPrice>): ModelPrice {
  return prices[model] ?? FALLBACK_PRICE;
}

export interface RenderOptions {
  billingMode: BillingMode;
  totals: UsageTotals;
  byAgent: UsageAggregate[];
  byModel: UsageAggregate[];
  days: DayPoint[];
  /** Merged price table; only consulted (and shown) in API mode. */
  prices: Record<string, ModelPrice>;
  /** Per-agent estimated $ in API mode (computed from per-model rows). Optional. */
  agentCostUsd?: Map<string, number>;
  t: Translator;
  /** Window label, e.g. "2026-05-12 → 2026-06-12". */
  windowLabel: string;
}

/**
 * Render the dashboard panel HTML. The host frames this in a sandboxed iframe, so
 * it is a STATIC server-rendered panel (no script execution). Everything is
 * HTML-escaped. The dollar column appears ONLY in API mode.
 */
export function renderCostHtml(opts: RenderOptions): string {
  const { billingMode, totals, byAgent, byModel, days, prices } = opts;
  const t = (key: string, params?: Record<string, string | number>): string => opts.t.t(key, params);
  const isApi = billingMode === 'api';
  const parts: string[] = [];

  parts.push('<div class="panel">');
  parts.push(`<div class="panel-title">${esc(t('cost.title'))}</div>`);
  parts.push(`<p class="field-note">${esc(t('cost.window', { range: opts.windowLabel }))}</p>`);

  // Mode banner — makes the $ stance explicit and unmissable.
  if (isApi) {
    parts.push(`<p class="field-note cost-mode cost-mode-api">${esc(t('cost.mode_api'))}</p>`);
  } else {
    parts.push(`<p class="field-note cost-mode cost-mode-sub">${esc(t('cost.mode_subscription'))}</p>`);
  }

  // --- Totals ---
  parts.push(`<div class="cost-totals">`);
  parts.push(stat(t('cost.total_input'), fmt(totals.inTok)));
  parts.push(stat(t('cost.total_output'), fmt(totals.outTok)));
  parts.push(stat(t('cost.total_cache'), fmt(totals.cacheTok)));
  if (isApi) {
    const grand = sumCostUsd(byModel, prices);
    parts.push(stat(t('cost.total_cost_estimate'), usd(grand)));
  }
  parts.push('</div>');
  if (totals.hasEstimate) {
    parts.push(`<p class="field-note cost-estimate-note">${esc(t('cost.estimate_note'))}</p>`);
  }

  // --- Per-agent (top consumers) ---
  parts.push(`<div class="panel-subtitle">${esc(t('cost.by_agent'))}</div>`);
  parts.push(renderAggTable(byAgent, isApi, opts.agentCostUsd, t));

  // --- Per-model ---
  parts.push(`<div class="panel-subtitle">${esc(t('cost.by_model'))}</div>`);
  const modelCost = isApi
    ? new Map(byModel.map((m) => [m.key, estimateCostUsd(m.inTok, m.outTok, m.cacheTok, priceFor(m.key, prices))]))
    : undefined;
  parts.push(renderAggTable(byModel, isApi, modelCost, t));

  // --- Day series (volume only; a tiny inline bar series, no script) ---
  parts.push(`<div class="panel-subtitle">${esc(t('cost.day_series'))}</div>`);
  parts.push(renderDaySeries(days, t));

  // --- Price table (API mode only): editable, clearly an estimate basis ---
  if (isApi) {
    parts.push(`<div class="panel-subtitle">${esc(t('cost.price_table'))}</div>`);
    parts.push(`<p class="field-note">${esc(t('cost.price_table_note'))}</p>`);
    parts.push(renderPriceTable(prices, t));
  }

  parts.push('</div>');
  return parts.join('');
}

type TFn = (key: string, params?: Record<string, string | number>) => string;

function renderAggTable(
  rows: UsageAggregate[],
  isApi: boolean,
  costByKey: Map<string, number> | undefined,
  t: TFn,
): string {
  const head = [t('cost.col_name'), t('cost.col_input'), t('cost.col_output'), t('cost.col_cache')];
  if (isApi) head.push(t('cost.col_cost_estimate'));
  const ths = head.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.length === 0
    ? `<tr><td colspan="${head.length}" class="field-note">${esc(t('cost.no_data'))}</td></tr>`
    : rows.map((r) => {
        const tds = [
          `<td>${esc(r.key)}</td>`,
          `<td class="num">${fmt(r.inTok)}</td>`,
          `<td class="num">${fmt(r.outTok)}</td>`,
          `<td class="num">${fmt(r.cacheTok)}</td>`,
        ];
        if (isApi) tds.push(`<td class="num">${usd(costByKey?.get(r.key) ?? 0)}</td>`);
        return `<tr>${tds.join('')}</tr>`;
      }).join('');
  return `<table class="cost-table"><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderDaySeries(days: DayPoint[], t: TFn): string {
  if (days.length === 0) return `<p class="field-note">${esc(t('cost.no_data'))}</p>`;
  const max = Math.max(1, ...days.map((d) => d.inTok + d.outTok + d.cacheTok));
  const bars = days.map((d) => {
    const total = d.inTok + d.outTok + d.cacheTok;
    const pct = Math.round((total / max) * 100);
    return (
      `<div class="cost-day"><span class="cost-day-label">${esc(d.day)}</span>` +
      `<span class="cost-bar"><span class="cost-bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="cost-day-val num">${fmt(total)}</span></div>`
    );
  }).join('');
  return `<div class="cost-series">${bars}</div>`;
}

function renderPriceTable(prices: Record<string, ModelPrice>, t: TFn): string {
  const entries = Object.entries(prices).sort((a, b) => a[0].localeCompare(b[0]));
  const rows = entries.map(([model, p]) =>
    `<tr><td>${esc(model)}</td>` +
    `<td><input class="cost-price" data-model="${esc(model)}" data-field="inputPerM" type="number" min="0" step="0.01" value="${esc(String(p.inputPerM))}"></td>` +
    `<td><input class="cost-price" data-model="${esc(model)}" data-field="outputPerM" type="number" min="0" step="0.01" value="${esc(String(p.outputPerM))}"></td></tr>`,
  ).join('');
  return (
    `<table class="cost-table cost-price-table"><thead><tr>` +
    `<th>${esc(t('cost.col_model'))}</th><th>${esc(t('cost.col_input_price'))}</th><th>${esc(t('cost.col_output_price'))}</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
}

function sumCostUsd(byModel: UsageAggregate[], prices: Record<string, ModelPrice>): number {
  let total = 0;
  for (const m of byModel) total += estimateCostUsd(m.inTok, m.outTok, m.cacheTok, priceFor(m.key, prices));
  return total;
}

function stat(label: string, value: string): string {
  return `<div class="cost-stat"><span class="cost-stat-label">${esc(label)}</span><span class="cost-stat-value num">${esc(value)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Soft budget alert
// ---------------------------------------------------------------------------

/** An operator-set soft monthly budget. Either a token cap or (API mode) a $ cap. */
export interface BudgetConfig {
  /** Soft cap on total monthly tokens (input+output+cache). 0/undefined = off. */
  monthlyTokens?: number;
  /** Soft cap on the monthly $ ESTIMATE (API mode only). 0/undefined = off. */
  monthlyUsd?: number;
}

export interface BudgetCheckInput {
  billingMode: BillingMode;
  budget: BudgetConfig;
  /** Month-to-date totals (already windowed to the current month). */
  monthInTok: number;
  monthOutTok: number;
  monthCacheTok: number;
  /** Month-to-date estimated $ (API mode); ignored in subscription mode. */
  monthUsdEstimate: number;
}

export interface BudgetCheckResult {
  /** True iff a threshold was crossed. */
  crossed: boolean;
  /** Which dimension crossed, for the notice text. */
  kind?: 'tokens' | 'usd';
  /** The crossed value and its limit. */
  value?: number;
  limit?: number;
}

/**
 * PURE budget evaluation. It only compares numbers and returns a verdict — it has
 * no handle to config, billing, the supervisor, or any agent, so it CANNOT change
 * billing.mode or disable/throttle anything. The $ cap is only ever considered in
 * API billing mode (subscription mode is volume-only, so a $ cap is meaningless
 * there and is ignored).
 */
export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const tokens = input.monthInTok + input.monthOutTok + input.monthCacheTok;
  const tokenCap = input.budget.monthlyTokens ?? 0;
  if (tokenCap > 0 && tokens >= tokenCap) {
    return { crossed: true, kind: 'tokens', value: tokens, limit: tokenCap };
  }
  if (input.billingMode === 'api') {
    const usdCap = input.budget.monthlyUsd ?? 0;
    if (usdCap > 0 && input.monthUsdEstimate >= usdCap) {
      return { crossed: true, kind: 'usd', value: input.monthUsdEstimate, limit: usdCap };
    }
  }
  return { crossed: false };
}

/**
 * Evaluate the budget and, if crossed, emit ONE operator notice via `notify`.
 * `notify` is the ONLY side-effect channel — informational only. Returns the
 * verdict so callers can dedupe (e.g. fire at most once per month). This function
 * never receives config/billing/supervisor handles, by construction.
 */
export async function maybeAlertBudget(
  input: BudgetCheckInput,
  notify: (text: string) => void | Promise<void>,
  t: Translator,
): Promise<BudgetCheckResult> {
  const result = checkBudget(input);
  if (result.crossed) {
    const text = result.kind === 'usd'
      ? t.t('cost.budget_alert_usd', { value: usd(result.value ?? 0), limit: usd(result.limit ?? 0) })
      : t.t('cost.budget_alert_tokens', { value: fmt(result.value ?? 0), limit: fmt(result.limit ?? 0) });
    await notify(text);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Plugin wiring factory
// ---------------------------------------------------------------------------

/** The host API surface this plugin uses (subset of the real HostApi). */
export interface CostHostApi {
  registerView(view: { id: string; navLabel: string; icon?: string; render: () => string | Promise<string> }): void;
  registerScheduledTask(task: { name: string; schedule: string; run: () => void | Promise<void> }): void;
  log(message: string): void;
}

/** Everything the dashboard needs from the host application, captured by closure. */
export interface CostDeps {
  store: CostStore;
  /** Live read of the active billing mode — only ever read, never written. */
  billingMode: () => BillingMode;
  /** Where each agent's session transcripts live + its default model. */
  sources: () => AgentSource[];
  /** Operator-edited prices merged over DEFAULT_PRICES (API mode only). */
  prices: () => Record<string, ModelPrice>;
  /** Operator-set soft budget. */
  budget: () => BudgetConfig;
  /** Drop an operator notice (no-op when unbound). MUST be informational only. */
  notify: (text: string) => void | Promise<void>;
  t: Translator;
  /** Injectable clock for deterministic windows in tests. */
  now?: () => Date;
  /** Cron for the rollup task (default: every 30 min). */
  rollupCron?: string;
  /** Window size in days for the dashboard (default 30). */
  windowDays?: number;
}

/**
 * Register the cost dashboard's view + scheduled rollup on the host. The
 * integrator calls this from the plugin's register() with a CostDeps closure
 * (the host API itself never exposes config/store, so the rich context is
 * supplied here). The budget alert fires from the rollup task and is deduped to
 * once per calendar month.
 */
export function registerCostDashboard(api: CostHostApi, deps: CostDeps): void {
  const windowDays = deps.windowDays ?? 30;
  const now = deps.now ?? (() => new Date());
  let lastAlertMonth = '';

  api.registerView({
    id: 'cost',
    navLabel: deps.t.t('cost.nav'),
    icon: 'chart',
    render: () => {
      const to = utcDayString(now());
      const from = utcDayString(addDays(now(), -windowDays));
      const billingMode = deps.billingMode();
      const prices = deps.prices();
      const byModel = deps.store.byModel(from, to);
      const agentCostUsd = billingMode === 'api'
        ? computeAgentCosts(deps.store, from, to, prices)
        : undefined;
      return renderCostHtml({
        billingMode,
        totals: deps.store.totals(from, to),
        byAgent: deps.store.byAgent(from, to),
        byModel,
        days: deps.store.daySeries(from, to),
        prices,
        ...(agentCostUsd !== undefined ? { agentCostUsd } : {}),
        t: deps.t,
        windowLabel: `${from} → ${to}`,
      });
    },
  });

  api.registerScheduledTask({
    name: 'cost-rollup',
    schedule: deps.rollupCron ?? '*/30 * * * *',
    run: async () => {
      try {
        rollup(deps.store, deps.sources());
      } catch (err) {
        api.log(`cost-rollup failed: ${String(err)}`);
        return;
      }
      // Budget check is best-effort + informational; never fails the rollup, and
      // structurally cannot touch billing (it only has the notify callback).
      try {
        const month = monthStart(now());
        if (month === lastAlertMonth) return; // already alerted this month
        const monthEnd = utcDayString(now());
        const totals = deps.store.totals(month, monthEnd);
        const billingMode = deps.billingMode();
        const monthUsdEstimate = billingMode === 'api'
          ? sumCostUsd(deps.store.byModel(month, monthEnd), deps.prices())
          : 0;
        const result = await maybeAlertBudget(
          {
            billingMode,
            budget: deps.budget(),
            monthInTok: totals.inTok,
            monthOutTok: totals.outTok,
            monthCacheTok: totals.cacheTok,
            monthUsdEstimate,
          },
          deps.notify,
          deps.t,
        );
        if (result.crossed) lastAlertMonth = month;
      } catch (err) {
        api.log(`cost budget check failed: ${String(err)}`);
      }
    },
  });
}

/** Per-agent estimated $ across the window, summed from its per-model rows. */
function computeAgentCosts(
  store: CostStore,
  from: string,
  to: string,
  prices: Record<string, ModelPrice>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of store.rows(from, to)) {
    const cost = estimateCostUsd(row.inTok, row.outTok, row.cacheTok, priceFor(row.model, prices));
    out.set(row.agent, (out.get(row.agent) ?? 0) + cost);
  }
  return out;
}

/** Merge operator-edited prices over the seeded defaults (operator wins). */
export function mergePrices(overrides: Record<string, ModelPrice> | undefined): Record<string, ModelPrice> {
  return { ...DEFAULT_PRICES, ...(overrides ?? {}) };
}

// --- small date + formatting helpers ---

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function monthStart(d: Date): string {
  return `${d.toISOString().slice(0, 7)}-01`;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
