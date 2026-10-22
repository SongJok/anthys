# Public search broker (R17 partial)

This package implements the security-critical part of R17 and does **not** claim a live search integration:

- `reviewPublicSearchQuery` is an outbound DLP gate. Only an explicit `PUBLIC` classification passes; credential patterns, connection strings, secret-file names, internal hosts, e-mail addresses, long numeric identifiers and customer/tenant IDs are denied. Denials are content-free.
- `PublicFetcher` permits HTTPS only, no credentials, default port and DNS names (no IP literals). Every redirect hop is re-resolved; all answers must be globally routable and the checked address is pinned for the TLS connection, closing DNS-rebinding gaps. Responses are size-, time-, encoding- and MIME-bounded.
- `buildSearchEvidence` validates provider replies, canonicalizes/ dedupes citation URLs, drops unsafe URLs, keeps external text inert and records the actual retrieval time, per-source freshness and mixed-freshness/empty/timeout/unavailable states.
- `SearchBroker` requires a trusted provider object configured by the service. There is no request-supplied endpoint, image, mount or credential.

Not implemented here: a concrete live search provider, enterprise-search isolation (must stay a separate DWS/MCP path), the answer composer, and live/E2E acceptance. The safe path for T104 is a controlled provider fixture; T103/T105 security oracles are covered by `tests/security/search-egress.test.ts`.
