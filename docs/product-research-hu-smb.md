# Termék-kutatás — eladható szoftvertermékek (HU/CEE, solo AI-flotta)

_Készült: 2026-06-10 • Forrás: CITADEL `product-gap-research` workflow (20 ágens, sweep → deep-dive → adversariális verifikáció: winnable-by-new-entrant + disztribúció, URL-idézve)._

**Téma:** milyen eladható SZOFTVERTERMÉKET (micro-SaaS / eszköz / plugin / app) érdemes egy egyszemélyes magyar AI-flotta-operátornak megépítenie és eladnia.

**Fő tanulság:** mind a 8 jelölt 2/10 — EGYIK SEM valós, solo új belépőként nyerhető termék. Visszatérő okok: ingyenes/beépített incumbensek (Billingo, Számlázz.hu, NAV saját appjai, Apple/Google Wallet), telített globális kategóriák (a wedge már leszállítva, pl. RedNudge), szabályozott termékek (e-pénztárgép/e-nyugta = NAV-licenc kell, solo nem szállíthatja), és mindenhol HALOTT disztribúció egy solo számára. A tanulság: az ÉPÍTÉS sosem volt a szűk keresztmetszet — a VEVŐ/disztribúció az.

## Rangsor (mind 2/10)

### 2/10 — NEM valós rés

**Hungarian incoming-invoice tracker + NAV/KATA threshold watchdog: a native-HU web app ingesting invoices (NAV Online Számla API + photo/PDF with AI OCR), keeping a running revenue total vs. the KATA 18M / VAT-exemption limits, auto-categorizing, and alerting before the buyer hits the 40% surcharge.**

- **Fizetési hajlandóság:** Compliance demand is real but the watchdog itself is a 0 Ft commodity that buyers already have installed, so WTP for a standalone new entrant is effectively nil. Billingo Free (0 Ft) includes unlimited invoicing + NAV sync and bundles the KATA Asszisztens / Átalányadó Asszisztens threshold frame for free in Basic/Standard/Pro and active KATA subs (confirmed billingo.hu/funkciok). Számlázz.hu bundles the keret- és adófigyelő (auto-pulls from invoices, email alerts) into #start/#digital/#profi (~1,700/2,500/3,300 Ft+VAT/mo). A standalone watchdog would have to undercut free-and-already-installed, capping price at roughly 500-1,500 Ft/mo, too thin to cover NAV API maintenance + AI OCR COGS for a solo. No forum thread found of anyone wanting to pay for a separate watchdog; the recurring HU answer is 'use your invoicing tool's built-in or the free Excel template.' No switching incentive exists.

- **Verseny:** Saturated and mostly free/bundled by native-HU, NAV-integrated incumbents. Számlázz.hu keret- és adófigyelő and Billingo KATA Asszisztens + Átalányadó Asszisztens (both verified, real-time, auto-fed from invoices) own the threshold-watch job at 0 Ft. QUiCK/Riport (7,000-22,000 Ft+VAT/mo) auto-computes thresholds + maintains the bevételi nyilvántartás. HolaSzámla pulls incoming+outgoing invoices DIRECTLY from NAV Online Számla (the exact ingestion proposed), 10,000+ clients, 20M+ invoices processed, owning the archiving/cost angle. NAV's own free Online Számlázó + free Excel templates cover the price-insensitive tail. Novitax/TEN-SOFT hold the accountant channel.

- **Disztribúciós út:** No realistic path, because there is no product wedge to distribute. To reach 50-100 paying users a solo would have to convince KATA/átalányadós sole proprietors to pay for a feature they already get free inside the invoicing tool they're required to use anyway — against incumbents that own the SEO, the app-store presence, and the accountant referral channel. The addressable population is shrinking and capped (KATA fell from ~444K to ~145K in 2022; ~40K active katás today), and the segment most likely to want a standalone alert (those on NAV's free Online Számlázó or paper) is precisely the group that already self-selected the free path. Selling through bookkeepers is possible only for a DIFFERENT product (cost/VAT organizer), and that channel is already held by HolaSzámla/QUiCK/full suites. Distribution is effectively hopeless.

- **Solo-építhetőség:** Technically buildable by a solo fleet (NAV Online Számla 3.0 API is free and documented; threshold math is trivial; AI OCR via metered API) but maintenance is HIGH and adversarial, and worse, the build is wasted because the core feature is off-target. Thresholds change every year (12->18->20->22->24M across 2024-2028), KATA/átalányadó rules shift frequently, and the NAV API auth (technical user, token exchange, AES) plus schema versions need constant green-keeping. Any miscalculation creates real tax liability for the user, an unbounded support/liability burden a solo cannot absorb. AI OCR adds recurring COGS for a feature the threshold job does not even need.

- **Fő kockázat:** The premise is factually wrong, which voids the whole product. Verified: for KATA only OUTGOING (revenue) invoices count toward the 18M limit, and the mandatory bevételi nyilvántartás is outgoing-only; INCOMING invoices do NOT count toward KATA 18M or the VAT-exemption limit. So an 'incoming-invoice tracker for threshold watching' solves a problem this buyer does not have. The genuinely-needed thing (revenue record + threshold alert) is already a free built-in of every major HU invoicing tool. Secondary risk: the candidate cited a stale 12M VAT limit (it was 18M in 2025, 20M in 2026), confirming the maintenance/correctness fragility.

- **Értékelés:** Hard skeptic verdict: AVOID, score 2/10. I independently verified the four load-bearing claims. (1) Thresholds: VAT exemption is 18M (2025) -> 20M (2026) -> 22M (2027) -> 24M (2028) per NAV; KATA 18M; the candidate's '12M' is the 2024 figure, now wrong. (2) Wrong object: for KATA, only outgoing invoices count toward the limit; incoming invoices do not (confirmed via officina.hu/billingo/NAV). The product's central mechanic (incoming-invoice tracking for threshold watching) targets a non-existent job for the stated buyer. (3) Incumbents own the watchdog for FREE/bundled: Billingo KATA + Átalányadó Asszisztens (free in paid tiers and active KATA subs) and Számlázz.hu keret- és adófigyelő (in #start/#digital/#profi), both auto-fed from invoices with alerts. (4) HolaSzámla already does NAV-direct ingestion (10,000+ clients) in the archiving market. So: no real gap, WTP ~0 vs free-and-installed, no distribution wedge, shrinking and capped population, high adversarial maintenance with real user tax liability. The one adjacent idea worth nothing more than a glance, a NAV-direct cost/VAT organizer for átalányadó sold through bookkeepers, is a DIFFERENT product already owned by HolaSzámla/QUiCK. Both make-or-break checks fail: nobody pays a new solo entrant here, and there is no realistic path to the first 50-100 users.

- **Források:**
  - https://nav.gov.hu/ado/afa/Emelkedik_az_alanyi_adomentesseg_ertekhatara
  - https://nav.gov.hu/ado/sme---kisvallalkozasok-kozossegi-alanyi-adomentessegi-rendszere/Informacio_az_SME-rendszer_kulfoldi_adoalanyainak_-_20_millio_forintra_emelkedik_a_magyar_alanyi_adomentesseg_beveteli_ertekhatara
  - https://www.szamlazz.hu/keret-es-adofigyelo-egyeni-vallalkozoknak/
  - https://tudastar.szamlazz.hu/gyik/kata-keret-aam-keret-ev-elejen
  - https://www.billingo.hu/funkciok/kata-asszisztens
  - https://www.billingo.hu/funkciok/atalanyado-asszisztens
  - https://support.billingo.hu/content/2070249487
  - https://officina.hu/gazdasag/178-kata-beveteli-nyilvantartas-minta
  - https://www.billingo.hu/blog/olvas/kata-beveteli-nyilvantartas
  - https://nav.gov.hu/ugyfeliranytu/valaszol-a-nav/uj-kata/nyilvantartasi-szamlaadasi-es-nyilatkozatteteli-kotelezettseg
  - https://www.holaszamla.hu/
  - https://www.szamlazz.hu/quick-koltsegnyilvantartas/
  - https://kkvmagazin.com/v/szamlazz-kata-adozas-fintech-elemzes/
  - https://uzletem.hu/vallalkozo/tobb-mint-640-ezer-egyeni-vallalkozo-nyilvantartasat-veszi-at-2027-tol-a-kamara

---

### 2/10 — NEM valós rés

**Native-Hungarian AI receipt/expense pre-processor for KATA/egyéni vállalkozó sole traders: snap/forward receipts, AI extracts vendor/date/total/VAT/line-items in HU, categorizes, exports a monthly CSV/PDF pack the könyvelő imports; free guest access for the accountant; sold via bookkeepers reselling to their client base.**

- **Fizetési hajlandóság:** WTP for the JOB exists but is already captured, and the price ceiling is brutal. Verified incumbent pricing: HolaSzámla 1,990 / 2,990 / 4,990 Ft/mo with an accountant tier at 748 Ft/mo per company (holaszamla.hu/arak) — and it already pulls BOTH invoices AND receipts from NAV. Cashbook 3,300 Ft+VAT/mo for accountants + 990 Ft+VAT/mo per managed business. Billingo's receipt-capture MobilApp is free. So a new solo entrant's realistic ceiling is ~750-3,000 Ft/mo/company in a slot already occupied by HU-native, NAV-integrated tools. Globally, SparkReceipt (verified: sparkreceipt.com/pricing) ships the EXACT pitch — AI extraction, 150+ currencies, free accountant guest access, $6.58-16.65/mo, free tier 15 scans/mo. Customers would not switch their whole client base to an unknown solo brand for a marginal receipt feature when their existing invoicing/bookkeeping vendor already bundles it and adds the free NAV pull they actually want.

- **Verseny:** Saturated and HU-native. Verified: HolaSzámla pulls incoming invoices + receipts directly from NAV with an accountant<->business cooperation model and one-click XML/XLS/PDF/CSV/TSV export — i.e. it owns the exact channel and feature set, minus the manual snapping. Plus Cashbook, Számlázz.hu Számlaverzum (#profi, aimed at KATA), free Billingo MobilApp, and the accountant-side stack (Novitax IPTAX, Kulcs-Soft, SMARTBooks, Ovitas, Innodox). Globally SparkReceipt/Dext/Hubdoc cover the multi-currency foreign-receipt case. STRUCTURAL: NAV Online Számla already auto-feeds invoices to accountants for free, and e-nyugta becomes mandatory 2026-09-01 with a FREE NAV eNyugta app collecting digital receipts at the source — shrinking the paper-receipt-to-data job every quarter for ~270k businesses (verified nav.gov.hu/ado/enyugta, hirlevel.egov.hu).

- **Disztribúciós út:** Weak-to-hopeless. The proposed channel (bookkeepers reselling) is the single channel incumbents have already locked: HolaSzámla and Cashbook are sold to könyvelők on a per-company tier explicitly built around the accountant-business handoff. A bookkeeper won't migrate a whole client roster to a no-name solo tool for a marginal extraction feature, and the feature they actually want (the free NAV pull) the solo cannot match without ongoing regulated integration. Direct-to-sole-trader is worse: no unmet-demand thread found (search surfaced only NAV/how-to content), and the target already gets free options from Billingo and the NAV apps. No realistic path to the first 50-100 paying companies.

- **Solo-építhetőség:** Build itself is easy for a solo AI fleet — vision-LLM extraction (Gemini Flash/GPT-4o-mini/Claude at ~EUR 0.015-0.025/receipt), CSV/PDF export, guest links are trivial, COGS low and metered-friendly. But the moat lives entirely in the parts a solo cannot out-run: (1) NAV Online Számla + e-nyugta integration (regulated, evolving through the 2026-2028 e-pénztárgép transition, requires technical-user auth + ongoing schema maintenance) — and this is the part customers actually pay for; (2) import compatibility with dozens of HU könyvelő programs (Novitax, Kulcs-Soft, RLB...) is a perpetual integration treadmill; (3) GDPR + 8-year bizonylat retention. High ongoing maintenance against a 1-3k Ft/mo ceiling = negative unit economics for a solo.

- **Fő kockázat:** The job is being eliminated at the source by the tax authority. e-nyugta (mandatory 2026-09-01) + the free NAV eNyugta/ePénztárgép apps + the existing free NAV invoice pull progressively destroy the paper-receipt-to-data task, while HU-native incumbents (HolaSzámla, Cashbook, Számlázz, Billingo) already bundle AI receipt capture into the exact bookkeeper channel — leaving a new solo entrant with a commodity feature, no NAV pull, and no defensible wedge at a sub-3,000 Ft/mo price.

- **Értékelés:** Independently verified the four load-bearing claims and all hold: (1) e-nyugta mandatory 2026-09-01 with a free NAV app hitting ~270k businesses (nav.gov.hu, hirlevel.egov.hu, fmkik.hu); (2) HolaSzámla pulls invoices AND receipts from NAV at 1,990-4,990 Ft/mo with a 748 Ft/mo/company accountant tier and the accountant-business cooperation channel (holaszamla.hu/arak); (3) SparkReceipt ships the identical global pitch at $6.58-16.65/mo with free accountant access (sparkreceipt.com/pricing); (4) no unserved-demand thread found for HU sole traders — only regulatory how-to content, i.e. saturation not opportunity. The gap is genuinely thin (only no-NAV-data foreign/handwritten receipts, a tiny slice already covered by SparkReceipt/Dext). Distribution is the killer: the bookkeeper-reseller channel is already owned, and there is no realistic path to 50-100 paying companies for a no-name solo. Buildability is high but the moat is in regulatory/integration maintenance a solo cannot sustain at the price ceiling. AVOID. Score 2 — real underlying pain, but already met, structurally undercut by the state, and undistributable for a new solo entrant.

- **Források:**
  - https://nav.gov.hu/ado/enyugta
  - https://hirlevel.egov.hu/2025/03/01/kitolja-az-e-nyugta-bevezetesenek-hataridejet-a-kormany-csak-2026-szeptemberetol-lesz-kotelezo-a-hasznalata/
  - https://fmkik.hu/hirek/csak-2026-szeptember-1-tol-lesz-kotelezo-az-e-nyugta
  - https://www.holaszamla.hu/
  - https://www.holaszamla.hu/arak
  - https://www.holaszamla.hu/NAV-online-szamla-lekerdezes
  - https://cashbook.hu/vallalkozok-mobilapp
  - https://katautan.szamlazz.hu/koltsegszamlak-gyujtese-digitalisan/
  - https://www.billingo.hu/funkciok/mobilapp
  - https://sparkreceipt.com/pricing/
  - https://dext.com/en/partner/pricing
  - https://onlineszamla.nav.gov.hu/
  - https://www.mindee.com/blog/llm-vs-ocr-api-cost-comparison

---

### 2/10 — NEM valós rés

**AI feedback inbox for solo founders / small teams — embeddable widget + email/forward intake that auto-dedupes feature requests/complaints, clusters by theme, ranks by frequency. Positioned as a single-seat-priced, AI-included alternative to Canny.**

- **Fizetési hajlandóság:** People DO pay for feedback boards ($13-79/mo band is established: Sleekplan $13, Peeqback $19/$149 LTD, Frill $25, Nolt/UserJot $29, Featurebase $29+/seat, Canny $79+). But they will NOT switch to a NEW solo entrant: the price-conscious wedge (solo founders / indie SaaS at ~$500 MRR) is ALREADY served by UserJot ($29 flat, unlimited users, AI dedup+auto-categorization FREE, literally built by a solo founder 'tired of bloated overpriced tools') and a free-forever tier, plus a $0 open-source option (Fider, AGPL, mature since 2017). A new product would have to price AT or BELOW $29 flat with AI free just to enter the consideration set — leaving no margin after recurring AI COGS. Verified: worknotes.ai/blog/userjot-pricing, userjot.com.

- **Verseny:** Brutally saturated and effectively owned at every price point. The exact feature set (multi-channel intake + AI dedup + theme clustering + frequency ranking + single-seat flat pricing) is commoditized. Cheap clones already shipping AI dedup/auto-categorize: UserJot, Featurebase, Sleekplan, Frill, Nolt, Peeqback, Supahub, Upvoty, Feedbear, ProductLift, Savio, Rapidr, IdeaPlan, FeatureUpvote, Quackback, plus ~5 more. Free/built-in substitutes: Fider (open-source, self-host), GitHub Discussions ($0), spreadsheet, Slack+Zapier DIY. Upmarket true unstructured clustering (the only seam): Enterpret, Pylon Product Intelligence, Productboard, Canny's own new AI tools — data moats + sales motions a solo can't match. Entrant would be #20+ in the field.

- **Disztribúciós út:** Effectively hopeless for a solo. This is an English-first, developer-facing GLOBAL category — the Hungarian/CEE native-language and compliance edge does NOT apply (no HU-language gap exists). The only discovery channel is SEO/content, and every relevant query ('Canny alternative', 'feedback tool for founders') already returns 10+ optimized comparison pages from incumbents who have spent years on it. Cold outbound to indie founders sells a tool whose free/$29 alternatives they already know. No marketplace surface (it's not a plugin/extension), no viral loop strong enough to overcome a 20-deep incumbent field. Getting the first 50-100 paying users would require sustained marketing spend a solo cannot fund against entrenched SEO incumbents.

- **Solo-építhetőség:** Technically easy for an AI fleet (embeddable JS widget, inbound-email parsing, LLM embedding pipeline for dedup/clustering, board UI — all well-trodden). That low difficulty is exactly WHY 20+ competitors already exist. The killer is ongoing economics: AI COGS are recurring and per-item (embeddings+clustering+dedup run on every inbound message); at a market-mandated $29 flat with 'AI free', a chatty customer erodes the entire margin — confirmed by Featurebase already metering AI separately at $0.29/resolution to survive. Plus an integration-maintenance treadmill (Intercom/Slack/Twitter API churn, email deliverability, spam, EU GDPR/data-residency for stored PII feedback). Buildable but a margin trap.

- **Fő kockázat:** A no-margin no-man's-land: squeezed between free (Fider/GitHub) and a $29-flat solo-built incumbent (UserJot) on the low end, and data-moated upmarket players (Enterpret/Pylon) on the high end — with recurring per-message AI COGS that flat $29 pricing cannot cover, and no realistic distribution channel to reach buyers who already know cheaper/free alternatives.

- **Értékelés:** AVOID. The category demand is real but the supply response is overwhelming and the buyer is value-skeptical. Every claimed differentiator is already standard and free: verified that UserJot ($29 flat, built BY a solo for solos) ships AI duplicate detection + auto-categorization at no extra cost with a generous free tier; Featurebase ships AI dedup but had to meter AI at $0.29/resolution (proving flat-priced AI is a margin trap); Fider is a mature free open-source substitute. Productboard itself published 'How feature voting forums failed us', and multiple sources warn that boards become 'graveyards of stale requests' biased toward power users — actively dampening demand, especially for the pre-PMF indie buyer this targets. No Hungarian/CEE language or compliance seam exists (English-first dev category). Distribution is the decisive killer: a solo cannot out-SEO a 20-deep field of incumbents whose comparison pages own every relevant search. Both make-or-break checks fail: (1) no one would pay entrant #20 over a free or $29 solo-built incumbent, and (2) there is no realistic path to the first 50-100 paying users. Score 2 (not 1 only because the underlying job is genuinely real and the tech is buildable — but it is unsellable).

- **Források:**
  - https://www.worknotes.ai/blog/userjot-pricing
  - https://userjot.com/
  - https://userjot.com/blog/top-5-feedback-tools-solo-founders
  - https://featureos.com/blog/featurebase-pricing
  - https://www.featurebase.app/pricing
  - https://help.featurebase.app/articles/7608294-featurebase-pricing-explained
  - https://www.fider.io/
  - https://github.com/getfider/fider
  - https://quackback.io/blog/open-source-feedback-tools
  - https://www.productboard.com/blog/how-feature-voting-forums-failed-us/
  - https://sleekplan.com/blog/canny-io-alternatives-in-2026-market-map-pricing-tradeoffs-and-the-best-alternative-to-canny-io-2425/
  - https://peeqback.com/blog/canny-alternative-for-indie-hackers
  - https://www.enterpret.com/
  - https://www.usepylon.com/blog/introducing-product-intelligence
  - https://canny.io/blog/best-ai-feedback-tools/
  - https://www.indiehackers.com/post/how-do-you-collect-user-feedback-1e52b722bb

---

### 2/10 — NEM valós rés

**Unified rewards/gift-card/loyalty wallet for Europe (HU/CEE-aware): one place to track gift-card balances, store-loyalty points and miles, with expiry reminders and AI that parses balance/expiry from a snapped card or a forwarded email receipt. Consumer freemium -> cheap premium for reminders/auto-sync.**

- **Fizetési hajlandóság:** Weak and capped. The category's consumer price ceiling is low: dominant tools are free (SuperCards 3M+ users, Apple/Google Wallet, CardCompass) or one-time a-few-euros (NeatPass $4.99, CardCompass $1.99 remove-ads, Pass2U Pro). Only AwardWallet sustains a recurring ~$49.99/yr sub, and verification confirms that is because of hard-to-replicate auto-sync (logs into reward accounts, unlimited daily updates) plus tiered expiry alerts at 90/60/30/7 days — i.e. people pay for the exact feature a solo cannot deliver. Strip auto-sync and you are a manual tracker competing with free apps where WTP collapses to ~0 / a one-time few euros. No evidence Hungarian consumers would pay anything for a localized wallet on top of free SuperShop/MOL Move/Lidl Plus apps. Would they switch to a NEW solo entrant and pay a sub? No realistic signal.

- **Verseny:** Crowded and owned at all three layers. Loyalty-card storage: SuperCards (3M+ users), Pass2U, Apple/Google Wallet (free, native). Miles/points value+expiry: AwardWallet entrenched, verified $49.99/yr with 90/60/30/7-day alerts and auto-sync (the candidate's claimed wedge, already shipped). Gift-card OCR+reminders: CardCompass, QuickScope, Giftly, Gift Card Balance Checker, Pass Cards, Folio, Gift Card Guard — verified to offer free on-device OCR scan, balance tracking and smart alerts, which is exactly the post-auto-sync wedge. HU built-ins (SuperShop, MOL Move ~750k MAU, Lidl Plus, Tesco Clubcard HU) each ship their own free app, fragmenting the localized angle.

- **Disztribúciós út:** Effectively hopeless for a solo. This is a low-intent consumer mobile-app category where discovery = App/Play Store search, dominated by incumbents with millions of installs and thousands of ratings; a solo has no organic ranking and consumer CAC via ads is unrecoverable against a freemium/one-time-few-euros price point. The one fresh pool (displaced Stocard users post-Klarna shutdown) is real but is being absorbed by free alternatives (Barcodes, Pass2U, mobile-pocket, Apple/Google Wallet) and is not searching for a paid product. No B2B beachhead, no plugin-marketplace surface, no SEO moat, no email-list lever. First 50-100 PAYING users is not credibly reachable.

- **Solo-építhetőség:** Thin version is easy; the version worth paying for is not solo-maintainable. Card storage, barcode display, OCR scan, email-forward parser and reminders are straightforward (PWA or RN). AI parsing is cheap and proven (vision LLMs ~97% receipt extraction; GPT-4o-mini ~$0.00015/1k tok, Gemini Flash ~$0.0006/image) so per-scan COGS is negligible. The killer is the only sub-justifying feature, auto-balance-sync: it requires per-retailer login scrapers that break constantly (AwardWallet, a funded company, still fails on Marriott/Chase) and storing 3rd-party credentials carries GDPR/PSD2 liability (screen-scraping curtailed under PSD2). A solo cannot maintain a scraper fleet across HU+EU retailers. So the buildable version is the free-tier-equivalent that nobody pays for.

- **Fő kockázat:** The paid-tier value prop (auto-sync) is undeliverable and legally fraught for a solo; everything a solo CAN build (OCR + reminders + manual entry) is already free from multiple incumbents, so the product has no defensible reason to be paid and no organic distribution channel to reach the few who might.

- **Értékelés:** Demand for the underlying job is real and documented (AARP guide, spreadsheet templates, Stocard-shutdown backlash), but it is already monetized by incumbents and the part a solo can actually ship is free everywhere. Verification confirmed the three fatal facts: (1) AwardWallet already delivers the exact claimed wedge (points value + tiered expiry alerts + auto-sync) at $49.99/yr; (2) CardCompass et al. already offer free on-device OCR scan + balance tracking + smart alerts, gutting the manual+AI-OCR+reminders fallback; (3) the only paid-justifying feature (auto-sync) is technically fragile and GDPR/PSD2-hostile, i.e. not solo-maintainable. The HU/CEE localization angle is a thin national wedge against free per-program apps with no evidence of incremental WTP. Worst of all, distribution is a dead end: a consumer mobile app with no organic store ranking, no B2B/plugin surface, and unrecoverable ad CAC against a near-zero price point — the post-Stocard refugees flow to free alternatives. Hopeless distribution + no defensible paid value + saturated/free competition = score low. Poor fit vs the operator's B2B/extension/plugin lanes.

- **Források:**
  - https://awardwallet.com/pricing
  - https://onemileatatime.com/guides/awardwallet/
  - https://frequentmiler.com/awardwallet/
  - https://giftcardguard.com/blog/top-gift-card-management-apps/
  - https://apps.apple.com/us/app/cardcompass-gift-card-tracker/id6752426189
  - https://apps.apple.com/us/app/quickscope-ocr-gift-scanner/id6749918722
  - https://neatpass.app/learn/stocard-shutting-down
  - https://vamers.com/2026/03/20/klarna-stocard-barcodes-loyalty/
  - https://choice.community/t/stocard-being-replaced-by-klarna-app/33022
  - https://forums.macrumors.com/threads/stocard-replacement.2434874/
  - https://www.pass2u.net/pricing
  - https://play.google.com/store/apps/details?id=de.superapps.supercards
  - https://sheetrix.com/templates/gift-card-tracker/
  - https://www.aarp.org/money/personal-finance/track-gift-cards/
  - https://play.google.com/store/apps/details?id=hu.supershop.app
  - https://www.molmove.hu/s/discover-mol-move
  - https://apps.apple.com/hu/app/lidl-plus/id1238611143
  - https://research.aimultiple.com/receipt-ocr/
  - https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini
  - https://eimf.eu/what-is-screen-scraping-the-eu-gdpr-its-ban-under-psd2-and-why-should-we-care/

---

### 2/10 — NEM valós rés

**Paid n8n community-node pack for Hungarian invoicing/finance — sharpened to the NAV Online Számla 3.0 node (the hard crypto/XML one: SHA3-512/AES-128/XML signing) plus Számlázz.hu and Billingo trigger nodes, sold not as paywalled bits (impossible) but as a maintained HU-compliance pack with paid support/SLA + template packs + done-for-you config. Buyer = HU n8n self-hosters, webshops, small accounting/automation agencies.**

- **Fizetési hajlandóság:** Low and only weakly demonstrated. The single real HU comparable is Viszt Péter's Számlázz.hu+Billingo Zapier connector at EUR40/yr net per service (confirmed on visztpeter.me: "40,00 EUR netto / ev"). Every DACH-equivalent invoicing n8n node (buchpilot, dachflow, sevdesk-v2, lexoffice-api) is free/MIT — no paid invoicing node exists anywhere, so the market price for a node is effectively zero. WTP for the SUPPORT/templates wrapper is unproven; HU buyers who need NAV reporting already get it free inside Számlázz.hu/Billingo (which report to NAV for them), so the raw NAV node only matters to the narrow segment hand-rolling against the tax authority directly. Crucially, even buyers who would pay EUR40-60/yr would switch to a free MIT clone the moment one appears.

- **Verseny:** Severe structural competition despite thin direct supply. Substitutes own the space: (a) n8n's own free HTTP Request + Code node (the documented default — present in 73%/52% of scraped workflows); (b) Számlázz.hu's OFFICIAL Zapier integration + 200+ listed integrations, and Billingo's clean REST API v3 with PHP/Java/JS SDKs + szamlazz.js npm lib that already wraps NAV reporting; (c) HU automation agencies (n8n.hu, AIWORKS, SRG, DigitalGrant) sell the integration as a service and sit in the channel; (d) Számlázz.hu/Billingo themselves report to NAV natively, removing the need to touch the raw API for most users. npm-registry check confirms zero existing HU invoicing nodes, but that thin supply is a symptom of weak demand, not an unguarded opening — and a free MIT clone can land overnight.

- **Disztribúciós út:** Effectively hopeless at the required scale. The buyer pool is HU n8n SELF-HOSTERS with direct-NAV invoicing needs — a tiny slice of a tiny niche. Realistic channels (n8n forum feature-requests board, n8n.hu/HU FB automation groups, the npm listing itself) reach maybe dozens of relevant people, and the open-npm verified-node model means anyone who discovers your free node never pays. Reaching 50-100 PAYING customers for a paid-support/template wrapper on a single-country invoicing node is not plausible; the HU agencies in this channel are competitors who'd self-serve. No observed HU buyer threads asking for this node (demand is inferred from generic "missing node" pain, not from any "is there an n8n node for NAV/Számlázz" request).

- **Solo-építhetőség:** Build is feasible solo: Számlázz/Billingo nodes are trivial (szamlazz.js v9 + Billingo REST v3/SDKs, ~2-5 days each); the NAV node is the hard, valuable part (SHA-512/SHA3-512/AES-128-ECB/GZIP/BASE64 crypto chain + per-request requestSignature + tracking NAV's v3.0 XML schema) but still a one-person job. API COGS ~zero (NAV/Számlázz/Billingo free to call; only hosting). The real defeat is MONETIZATION, not building: n8n verified nodes MUST be MIT-licensed AND have zero runtime dependencies (confirmed by official docs + n8n blog), and npm install is open — so you cannot paywall the node or even bundle szamlazz.js into a verified one. The only paid-custom-node rail (prokodo marketplace) is still pre-launch MVP. Maintenance tax is recurring: NAV cert/schema changes + n8n major-version breakage.

- **Fő kockázat:** No paywall rail for the asset itself (verified node = MIT + zero-deps + open npm), so any traction invites a free MIT clone that resets price to zero; combined with a single-country niche too small to reach 50-100 paying users. Distribution + un-defensible monetization compound into a dead end.

- **Értékelés:** The dossier is unusually self-aware and its skeptical conclusions hold up under verification. Confirmed: (1) verified n8n nodes must be MIT + zero runtime dependencies with open npm install — official docs/blog — so the node literally cannot be sold or gated, and szamlazz.js cannot even be bundled; (2) npm registry has zero HU invoicing nodes (thin supply), but that reflects weak demand, not opportunity; (3) demand for THIS node is inferred from generic 'missing node / 73% HTTP-Request' stats, with NO observed HU buyer requests; (4) WTP is low (EUR40/yr net per service, confirmed) and instantly undercuttable by a free MIT clone; (5) Számlázz.hu/Billingo already report to NAV natively and have official Zapier + SDK paths, so the genuinely-hard NAV node only matters to a narrow direct-API segment. The one defensible pivot (sell support/SLA + templates around a free node, or a thin hosted SaaS that holds NAV creds and does the signing) is a services/micro-SaaS business, not the 'paid node pack' premise, and still faces a hopeless solo distribution path: a single-country slice of n8n self-hosters, with HU agencies as channel competitors. Real engineering gap exists (NAV crypto/XML), but it is not monetizable as a product by a new solo entrant. Low score driven by broken monetization rail + non-existent distribution to 50-100 payers, not by build difficulty.

- **Források:**
  - https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/
  - https://blog.n8n.io/community-nodes-available-on-n8n-cloud/
  - https://docs.n8n.io/integrations/community-nodes/installation/verified-install/
  - https://www.n8n-marketplace.prokodo.com/en/
  - https://community.n8n.io/t/independent-n8n-node-marketplace-looking-for-feedback-from-node-devs-power-users/234180
  - https://visztpeter.me/termek/szamlazz-hu-zapier-osszekottetes/
  - https://integracio.szamlazz.hu/zapier
  - https://github.com/ewngs/szamlazz.js/
  - https://github.com/yunehu/billingo-v3
  - https://github.com/nav-gov-hu/Online-Invoice/issues/400
  - https://github.com/pzs/nav-online-invoice
  - https://community.n8n.io/c/feature-requests/nodes/7
  - https://medium.com/@mustaphaliaichi/what-are-people-actually-building-in-n8n-i-scraped-over-6-000-workflows-to-find-out-59eb8e34c317
  - https://dddinvoices.com/learn/e-invoicing-hungary
  - https://n8n.hu/

---

### 2/10 — NEM valós rés

**Niche Reddit/forum buyer-intent radar for solo founders — keyword + AI-relevance (1-10) scoring at a true micro price (~$5-9/mo, one project), positioned between free-but-noisy F5Bot and the $19-79/mo crowd.**

- **Fizetési hajlandóság:** People DO pay for filtered Reddit buyer-intent: GummySearch reached ~$35k MRR / 135k+ users, F5Bot now charges up to $58.33/mo for AI semantic alerts, and the $19-49/mo tier (Syften, Subreddit Signals, Octolens, MentionDrop) is densely populated and selling. Indie-hacker testimonials cite Reddit as a top early-customer channel ("first 10 customers, 40% conversion"). BUT WTP for a NEW solo entrant at $7/mo is the problem: that exact price/feature point is already filled by RedNudge ($7/mo, 5 kw, 300 AI-scored matches, Claude 1-10 scoring, daily digest). A new clone offers no reason to switch; the category's spend gravity is $19-49, where solo entrants face entrenched players. Confirmed: rednudge.com, f5bot.com pricing, gummysearch.com/final-chapter.

- **Verseny:** Saturated red ocean — 15+ near-identical tools and the proposed wedge is already shipped. RedNudge ($7-15/mo) IS the proposed product line-for-line. F5Bot (free → $14.17 → $58.33/mo) now adds AI semantic alerts + REST API + webhooks, moving into the same filtering niche. Mid-tier: Octolens ($49-149), Subreddit Signals ($19.99-59), Syften ($19.95-99.95), MentionDrop, Linkeddit, Buska, Prowlo, RedShip, SnitchFeed, CatchIntent, Reppit, Reddinbox, Prems, and more. Free substitutes: F5Bot free tier, native Reddit search. Category leader GummySearch (135k users) just shut down. New-entrant differentiation: effectively zero.

- **Disztribúciós út:** Realistically hopeless for a new entrant. The category is SEO-farmed to death — every keyword ("GummySearch alternative," "F5Bot alternative," "Reddit monitoring tools 2026") is already saturated with comparison listicles owned by the incumbents themselves (RedShip, Prowlo, Prems, Reppit, Octolens all run alternative-pages). The natural distribution channel (Reddit posting) is hostile to self-promotion and is the same platform whose data the product depends on. No HU/CEE wedge (Reddit is English-dominated, no compliance gap). A solo would be the 16th identical tool fighting for the same English-language SEO terms against entrenched players with content backlogs — no realistic path to 50-100 paying users.

- **Solo-építhetőség:** Trivial to BUILD (poll feed, embed/keyword match, LLM 1-10 relevance score, email digest = a weekend for an AI fleet; LLM COGS a few cents/1,000 posts). But UNMAINTAINABLE/un-survivable: since Nov 11, 2025 Reddit requires pre-approval for ALL API access (2-4 wk) and a written contract for ANY commercial use (~$0.24/1,000 calls, enterprise volume reportedly ~$12k/mo) — economically impossible at $7/mo. GummySearch (profitable, 135k users) was forced to shut down 2025-11-30 because it could not reach a compliant agreement. A solo has far less leverage. Surviving cheap clones almost certainly operate in a legal grey zone; one enforcement action ends the product and triggers refunds. Build-on-rented-land with an actively hostile landlord.

- **Fő kockázat:** Existential platform risk: the product is 100% dependent on Reddit data, and Reddit (post-Nov-2025) requires a commercial contract no solo can afford or obtain — proven by Reddit denying a viable agreement to a profitable 135k-user incumbent (GummySearch), forcing its shutdown. Even setting that aside, the exact wedge is already sold by RedNudge at the same price with the same Claude-scoring, so there is no moat and no differentiation.

- **Értékelés:** Verified all four load-bearing claims against primary sources and they hold. (1) GummySearch confirmed shut down 2025-11-30 over an unreachable Reddit commercial API agreement despite 135k+ users — definitive proof the category cannot legally survive at solo scale. (2) RedNudge confirmed as the literal proposed wedge: $7/mo, 5 keywords, 300 AI-scored matches, every post scored 1-10 by Claude, daily digest, 30-min scans, intent auto-tagging — same product, same price, same scoring engine, zero moat for a new clone. (3) Reddit's Nov 11 2025 policy confirmed: pre-approval required for ALL API access, written contract required for any commercial use, ~$0.24/1,000 calls — economically impossible at $7/mo. (4) F5Bot confirmed moving into AI filtering ($14.17 and $58.33/mo tiers with semantic alerts, REST API, webhooks). Demand for FILTERED Reddit intent is real, but the niche is aggressively over-served, the proposed wedge is already occupied, the native-HU edge does not apply (English-dominated platform, no compliance gap), distribution is hopeless against 15+ SEO-entrenched clones, and the whole category sits on rented land with a hostile landlord that just killed the leader. Clear AVOID. Score 2 (not 1 only because the underlying buyer-intent JOB is genuinely valuable — but it must be pursued on open-data platforms like Hacker News, Stack Exchange, Bluesky, or niche RSS forums, not Reddit).

- **Források:**
  - https://gummysearch.com/final-chapter/
  - https://gummysearch.com/docs/articles/gummysearch-is-now-closed-6533h
  - https://rednudge.com/
  - https://rednudge.com/reddit-keyword-monitoring
  - https://replydaddy.com/blog/reddit-api-pre-approval-2025-personal-projects-crackdown
  - https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data
  - https://octolens.com/blog/reddit-api-pricing
  - https://f5bot.com/
  - https://f5bot.com/docs-semantic
  - https://redship.io/reddit-tool/f5bot
  - https://prowlo.com/blog/f5bot-vs-syften-vs-octolens-vs-prowlo
  - https://www.xpoz.ai/blog/comparisons/reddit-monitoring-tools-pricing-compared-2026/
  - https://www.solopreneur.global/posts/gummysearch-shutdown-platform-risk-lessons
  - https://syncsuptech.substack.com/p/gummysearch-shuts-down
  - https://redship.io/blog/gummysearch-shut-down-alternatives

---

### 2/10 — NEM valós rés

**HU cloud e-pénztárgép (software cash register) app for micro-merchants (piaci árus, kisbolt, fodrász, food truck) issuing NAV e-nyugta under the Sept 1, 2026 mandate — a polished tablet/phone POS undercutting NAV's free app on UX, catalog/inventory, multi-VAT, daily close, printer pairing, analytics.**

- **Fizetési hajlandóság:** Mixed and ultimately disqualifying for THIS product. There IS proven monthly WTP from the same micro-merchants for nicer niche POS/NTAK software: Smart-Cash FULL ~HUF 12,000+VAT/mo, NTAK POS bundles from ~HUF 9,900+VAT/mo (cmo.hu), e-Étterem/BarSoft subscriptions — so micro-merchants pay for value-add over a bare option. BUT for the REGULATED register layer specifically, NAV's own app is FREE and is the permanent price anchor; and as of 2026 eptg.hu confirms there is literally NO authorized commercial e-pénztárgép on the market at all, so there is zero observed WTP for a paid register alternative and no 'is there a paid alternative' threads. People would pay a new entrant only for a value-add layer (booking/inventory/analytics), not for the register itself — which a solo cannot legally ship.

- **Verseny:** The incumbent IS the regulator. NAV ships its own FREE cloud register (NAV ePénztárgép, via state developer Pillér Informatikai Nonprofit Kft) plus the NAV eNyugta customer app, already including product catalog, fast receipt issuance, wide wireless-printer support, sales stats and automatic 10-yr retention — the 'polished basics' the candidate assumes are missing. Commercial entrants must be capitalized firms (Smart-Cash, HioPOS, BarSoft, e-Étterem, CashCube/Tekinvest, LA Pénztárgép, Armacash, ECR-TRADE) — none of which is a solo. As of 2026 even these have not yet cleared licensing; eptg.hu says no authorized commercial register exists yet.

- **Disztribúciós út:** Effectively hopeless for the register product because the product is illegal to ship solo (see buildability), so distribution is moot. Even the solo-shaped remnant — a value-add micro-app (booking + repeat-customer + inventory + AI analytics for fodrász/kisbolt) integrating with a licensed register via the open eRECEIPT spec — has a weak path: it depends on whatever integration surface licensed registers expose (none yet exist in 2026), competes with established NTAK/POS vendors who own the SMB channel and accountant relationships, and there is no observed inbound demand thread to seed from. A solo would have to do offline/local outreach (accountants, kamara, FB SMB groups) against incumbents already in those channels.

- **Solo-építhetőség:** The code is solo-buildable (NAV publishes the full eRECEIPT spec openly on GitHub, XSD/example XML, maintained to v1.5; low COGS, AI only for optional analytics). But SHIPPING is not solo-shaped due to the operating model, confirmed verbatim in 8/2025 NGM rendelet 6.§(2): jegyzett tőke ≥ HUF 50,000,000, ≥5 insured employees, independent-auditor-certified sustainable business plan, audited cybersecurity resilience index, plus 6.§(1) 0–24h year-round customer service and 5.§/8.§ type examination (KOBAK) with source-code submission and a no-hidden-function declaration. License fee HUF 1,000,000 (HUF 500,000 for vevői alkalmazás only). Ongoing: track NGM/XSD changes (already changed) and run a 24/7/365 SLA forever — incompatible with one person.

- **Fő kockázat:** Hard regulatory exclusion: a solo cannot meet the HUF 50M capital + 5-employee + auditor + 24/7 + type-exam bar to legally distribute the register, and NAV's free app caps any price for the basics. The 'value-add layer' fallback is a different, smaller product hostage to integration surfaces that did not exist as of 2026.

- **Értékelés:** Demand for the underlying job is real and large (~270,000 businesses forced digital from Sept 1, 2026) and monthly POS WTP among these merchants is proven. But the candidate fails both make-or-break checks. (1) Would anyone pay a NEW SOLO entrant for the register? No — the register is a regulated artifact a solo legally cannot ship: 8/2025 NGM rendelet 6.§(2) demands HUF 50M registered capital, ≥5 employees, auditor-certified business plan, audited cybersecurity, type examination + source-code/no-hidden-function submission, and a permanent 24/7/365 support desk; and NAV's free app anchors the price to zero. I verified these thresholds directly in the rendelet text and confirmed via eptg.hu that as of 2026 there is NOT EVEN a single authorized commercial register on the market yet — the field is occupied by capitalized incumbents, not solos. (2) Distribution: moot for the illegal register; for the only solo-shaped remnant (a value-add booking/inventory/analytics add-on on top of someone else's licensed register via eRECEIPT) there is no integration surface yet, no observed inbound demand, and entrenched NTAK/POS vendors own the channel. Right gap, wrong shape and wrong actor for a solo. Score 2: real underlying pain, but structurally closed to a solo builder by law and by a free state incumbent.

- **Források:**
  - https://net.jogtar.hu/jogszabaly?docid=a2500008.ngm
  - https://eptg.hu/
  - https://nav.gov.hu/pfile/file?path=/ado/enyugta/forgalmazoknak/tajekoztato-az-e-penztargepek-es-a-vevoi-alkalmazasok-forgalmazasanak-engedelyezese-iranti-kerelem-benyujtasarol-es-engedelyezesi-eljarasarol
  - https://github.com/nav-gov-hu/eRECEIPT
  - https://kormany.hu/hirek/zsebunkben-a-penztargep-ingyenesen-letoltheto-a-nav-epenztargep-es-nav-enyugta-alkalmazasa
  - https://nav.gov.hu/print/sajtoszoba/hirek/Mar_tobb_mint_otszazan_toltottek_le_a_NAV_ePenztargep_es_a_NAV_eNyugta_alkalmazast
  - https://nav.gov.hu/ado/enyugta/forgalmazasi-engedelyek/forgalmazasi-engedelyek
  - https://play.google.com/store/apps/details?id=hu.pillerkft.epenztargep
  - https://apps.apple.com/hu/app/nav-ep%C3%A9nzt%C3%A1rg%C3%A9p/id6746411775
  - https://cmo.hu/epenztargep/ntak-pos-ecr-vendeglato-csomag
  - https://www.barsoft.hu/integraciok
  - https://www.e-etterem.hu/2026/02/26/ettermi-szoftver-arak-2026-teljes-utmutato-a-koltsegekhez-es-a-megteruleshez/
  - https://piacesprofit.hu/cikkek/kkv_cegblog/felejtsuk-el-az-online-penztargepet.html

---

### 2/10 — NEM valós rés

**Consumer "digital receipt wallet" + warranty/jótállás tracker for Hungary — pulls e-receipts from NAV's nyugtatár, auto-detects warranty windows, sends expiry reminders, AI OCR for paper receipts, premium analytics/family sharing/claim assistant.**

- **Fizetési hajlandóság:** Low and unproven for a NEW entrant. The entire warranty/receipt-tracker category is monetized at or near zero to consumers: global comps (TrackWarranty, Warranty Keeper) are free; receipt-scanning apps that get traction PAY users (Receipt Hog, Swagbucks-style data resale) rather than charge them — a documented hard-to-monetize category (sidehustlenation, moneypantry). AI ones (SlipCrate) are freemium with tiny undisclosed subs. In HU the realistic premium ceiling is ~500-1,500 HUF/mo (~1.3-4 EUR), and a free official NAV eNyugta app plus free retailer wallets (Lidl Plus, eMAG) cover the core job, so most users have no reason to pay — let alone switch from a state app to an unknown solo brand. Only real money is a B2B2C retailer/insurer co-brand, which is enterprise sales, not a self-serve product.

- **Verseny:** Owned at both ends. BUILT-IN/FREE: NAV eNyugta (Pillér Informatikai Nonprofit Kft.) is the default free buyer app; NAV stores all e-receipts 10 years free. Confirmed via the official license list: exactly 2 valid buyer-app licenses exist, both NAV's own (Android+iOS) — ZERO third parties have cleared licensing. RETAILER WALLETS own the high-volume grocery/electronics end (Lidl Plus digital receipts + returns, eMAG/MediaMarkt e-warranty cards). HU clone already exists (Proofee, manual capture). Global warranty trackers (TrackWarranty, SlipCrate, MyItems) saturate the manual-capture half. HU law further erodes pain: jótállási jegy or nyugta alone suffices for a claim; szavatosság runs 2 years regardless of keeping the receipt.

- **Disztribúciós út:** No realistic solo path to 50-100 paying users. Without the NAV license you ship a manual-capture clone with no HU moat, competing head-on with a free state app, free retailer wallets, and an existing HU clone — paid acquisition (App Store/Meta) can't earn back a sub capped at ~1-4 EUR/mo, and there is no visible "I wish a better receipt wallet existed" groundswell in HU forums (the demand is for keeping warranties, already nominally free-covered). With the license, distribution is moot because clearing the regulatory wall is itself the year-long blocker. The only money path (retailer/insurer co-brand) is enterprise BD a solo can't realistically run. Distribution is effectively hopeless.

- **Solo-építhetőség:** App is buildable by an AI fleet (mobile app, cloud OCR/LLM, reminder scheduler, simple analytics; modest metered COGS). But the load-bearing blocker is REGULATORY, not technical: reading the nyugtatár requires a NAV forgalmazási engedély for the vevői alkalmazás, which needs a típusvizsgálat (type test per 8/2025 NGM rendelet), a clean-tax-status company, an admin fee, AND re-certification on every software modification — directly hostile to an AI fleet that ships frequent updates. Confirmed: no third party has passed it. Architecture also blocks the killer feature — receipts are retrieved per-purchase via a cryptographic keresőkulcs+keresődátum (or by scanning paper QRs), the buyer is anonymous with NO central account, and apps are forbidden to auto-transfer; so no "see every receipt you ever got" bulk pull. Net: COGS fine, moat and go-to-market broken.

- **Fő kockázat:** You either (a) skip the license and become an undifferentiated manual-capture clone with no moat against a free state app + free retailer wallets, or (b) sink months/a company into NAV type-certification only to still lack the bulk-receipt feature (per-receipt retrieval, no central account) that would make the product magic — and either way consumers won't pay an unknown solo brand when free official + retailer options exist.

- **Értékelés:** Independently verified: (1) license wall is real and unbreached — NAV's official list shows exactly 2 buyer-app licenses, both NAV's own (Pillér Kft.), zero third parties; type test + re-certification-on-change explicitly required. (2) Architecture confirmed by NAV's own Q&A — per-receipt keresőkulcs/keresődátum, anonymous buyer, no central account, no bulk-pull API, apps forbidden to auto-transfer — so the magic feature is impossible. (3) WTP independently confirmed low — the whole warranty/receipt category is free or pays users, against a free state app + free retailer wallets. The job is genuinely painful and the NAV app is deliberately minimal (no reminders/analytics/OCR/claim help), so a UX delta exists — but a real gap requires a new solo entrant to actually WIN paying users, and here both ends are owned, WTP is near-zero, and there is no solo distribution path. Note: the grocery-chain e-receipt delay is to mid-2028 (July 1, 2028), and those chains already run their own wallets, so the high-spend segment is doubly out of reach. Weak solo bet. Score 2.

- **Források:**
  - https://nav.gov.hu/print/ado/enyugta/forgalmazasi-engedelyek/forgalmazasi-engedelyek
  - https://nav.gov.hu/ado/enyugta/kerdesek-es-valaszok/vevoi-alkalmazas
  - https://nav.gov.hu/ado/enyugta/forgalmazoknak/tajekoztato-az-e-penztargepek-es-a-vevoi-alkalmazasok-forgalmazasanak-engedelyezese-iranti-kerelem-benyujtasarol-es-engedelyezesi-eljarasarol-cikk
  - https://adovilag.hu/2025/08/04/az-e-nyugta-rendszer-bemutatasa/
  - https://nav.gov.hu/sajtoszoba/hirek/az-e-penztargepeke-a-jovo-ma-lepett-hatalyba-a-rendelet
  - https://www.sidehustlenation.com/best-receipt-scanning-apps/
  - https://moneypantry.com/apps-pay-you-scan-grocery-receipts/
  - https://trackwarranty.app/
  - https://slipcrate.com
  - https://proofee.webnode.hu/
  - https://ugyfelszolgalat.lidl.hu/SelfServiceHU/s/article/Mit-jelent-a-digit%C3%A1lis-nyugta
  - https://kormany.hu/hirek/zsebunkben-a-penztargep-ingyenesen-letoltheto-a-nav-epenztargep-es-nav-enyugta-alkalmazasa

---

## Megfontolt jelöltek (sweep után)
- Hungarian incoming-invoice (bejövő számla) tracker + NAV/KATA threshold watchdog — a tiny native-HU web app that ingests invoices (NAV Online Számla API + photo/PDF upload), running-totals revenue against the KATA 18M HUF / VAT-exemption 12M HUF limits, and warns before you cross them. Metered AI for OCR/auto-categorize.
- Native-Hungarian AI receipt/expense pre-processor for the 'shoebox-of-receipts → accountant' handoff. Snap or forward receipts; AI extracts vendor/date/total/VAT/line-items in HU, categorizes, and exports a clean monthly pack (CSV/PDF) the könyvelő can import. Free guest access for the accountant.
- AI feedback inbox for solo founders / small teams — embeddable widget + email/forward intake that auto-dedupes incoming feature requests/complaints across channels, clusters them, and ranks by frequency. A lightweight, single-seat-priced alternative to Canny/heavy PM suites.
- Unified rewards/gift-card/loyalty wallet for EUROPE — track gift-card balances, store-loyalty points, and miles across HU/EU retailers in one place, with expiry reminders. AI parses balance/expiry from a snapped card or a forwarded email receipt.
- Pre-built n8n community nodes for services n8n lacks (and their HU/CEE equivalents) — e.g. typed nodes for Hungarian invoicing (Számlázz.hu / NAV Online Számla), local banks, or other no-native-node APIs — sold as a paid node pack / templates, replacing the brittle raw HTTP-Request workaround.
- Niche Reddit/forum buyer-intent radar for SOLO founders — keyword + AI-relevance monitoring at a true micro price (one project, ~$5-9/mo), bridging the gap between 'free but noisy' F5Bot and the $19-79/mo crowd. Wedge: AI relevance scoring so a solo isn't drowned in false positives.
- HU cloud e-pénztárgép (software cash register) app for micro-merchants — a polished mobile/tablet POS that issues NAV e-receipts (e-nyugta) and reports to NAV, built on the open NAV e-cash-register spec, NAV-approved, targeting market vendors, small shops, hairdressers, food trucks who today only have NAV's bare-bones free app.
- Consumer e-nyugta wallet + warranty/garancia tracker app ('digitális nyugtatárca') — a beautiful consumer app that pulls a buyer's e-receipts from NAV's nyugtatár, auto-detects warranty (jótállás/szavatosság) periods, sends expiry reminders, organizes receipts by product, and helps file warranty claims. AI-native: auto-categorize spend, OCR legacy paper receipts.
