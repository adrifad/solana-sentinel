# 19 — Threat Model / Trust Boundaries

## Assets

Potential live wallet funds, provider API keys, configuration and strategy, SQLite records, creator evidence, admin session, VPS credentials.

## Trust boundaries

- Untrusted token metadata/social links/provider JSON → strict input validation + escaping.
- Web frontend/admin API → authenticated, restricted config update only.
- Scanner/risk/strategy → paper executor (non-signing).
- Future live worker → isolated signer with independent checks and short-lived authenticated capability.
- Database/logging → secret-free and append-only decision records.

## Threats / controls

| Threat                                            | Control                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Malicious token metadata causing script injection | escape/sanitize text, never execute metadata                         |
| Fake social endorsement                           | verify official channel independently, mint exact match              |
| API-key exfiltration via logs                     | masked logs, least privilege, secret scanning                        |
| PumpPortal Lightning key misuse                   | segregate, never expose to UI, maintain minimal linked wallet funds  |
| RPC data inconsistency / stale chain state        | source/slot provenance, staleness gate, optional second-source check |
| Fake paper profits                                | fresh exact-input quotes, reject missing liquidity, exact ledger     |
| Wrong wallet/mint or malicious route              | allowlist, pre-sign quote and account validation                     |
| Duplicate live orders after timeout               | idempotency, reconcile chain before re-send                          |
| Dashboard compromise                              | no direct signer access, immutable hard limits, authenticated audit  |
| VPS compromise                                    | separate signer host/identity, key management, limited funds         |
| Unbounded stream costs                            | subscription and budget caps                                         |
| Replay lookahead                                  | availability timestamps and immutable snapshot store                 |

## Incident priorities

If any possible secret disclosure occurs: immediately disarm live signer, revoke/rotate provider credentials, move any remaining funds from potentially exposed wallet using a trustworthy isolated environment, review audit logs, re-provision keys. If a provider is compromised, quarantine affected venue/source until cross-checked with on-chain data.

---
