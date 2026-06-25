# CITADEL — Public Roadmap

Items listed here are planned but not yet shipped. The list is not exhaustive and order does not imply priority. For shipped features see [README.md](README.md).

---

## Privacy and data handling

### Free-text name redaction (NER) — planned

Structured and regulated PII (email, phone, tax IDs, IBANs, card numbers) is masked today on the customer-support egress path before any cloud LLM reads it. **Not yet active:** free-text personal names written inline in a message body ("My name is…") are not currently detected and redacted. Planned: local NER-based (named-entity recognition) redaction for Hungarian personal names, running on-device before cloud egress.

### Local-gateway egress split — planned

A deeper structured-egress boundary so that agent reads of structured data (database lookups, record retrieval) are masked at a local gateway before the agent context is sent to the cloud LLM — without breaking local agent function. This extends the current choke-point approach to a broader set of structured reads.

---

## Contributing / tracking

Public issue tracking will open after the first public release. Until then, this file is the canonical public roadmap.
