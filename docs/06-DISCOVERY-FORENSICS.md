# 06 — Discovery, Creator Forensics and Test Token Detection

## 1. Token launch pipeline

1. Receive `subscribeNewToken` event, persist raw+normalized metadata and slot.
2. Dedup `(mint, creation_signature)` and identify Pump program/market phase.
3. Identify distinct `initiator`, `fee_payer`, `claimed_creator`, `mint_authority`, `funding_wallet`, `metadata_update_authority`. Unknown roles remain UNKNOWN.
4. Fetch mint account/token program and minimum necessary on-chain security state.
5. Lookup creator profile (cached historical launches, measured outcomes and verified warning evidence).
6. Queue deeper forensic exploration if profile absent/stale; timeout => quarantine rather than permit buy.
7. Start observation window (30/60/120 sec configurable) and collect initial independent buying/volume signals.
8. Produce safety and opportunity reports. Save snapshots and decision reasons.
9. Monitor migration, authority changes, concentration, price/volume, and anomalies until watch horizon.

## 2. Creator analysis signals

| Signal                 | Evidence                                                       | Caution                                          |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Historical launches    | Mint events linked to initiator/creator with source signatures | A creator may use multiple wallets               |
| Token launch outcomes  | Timed liquidity/price/tx records                               | Low liquidity is not necessarily malicious       |
| Developer sell pattern | Historical creator-associated wallet trades                    | Distinguish routine sells vs coordinated dumps   |
| Funding ancestry       | Transfers + depth/time confidence                              | CEX hot wallet is weak commonality evidence      |
| Wallet cluster         | Repeated timed funding, buys, sells, shared controllers        | Never assert common ownership from a single edge |
| Test/spam pattern      | Burst mint frequency and repeated metadata                     | New genuine projects may test                    |
| Liquidity events       | Verified pool/curve updates                                    | Curve and PumpSwap must be evaluated separately  |

## 3. Reputation record design

- `creator_id`, `wallet_role`, `evidence_signatures`, `labels`, `confidence` (0–1), `known_launches`, `assessed_outcomes`, `last_refreshed_slot`.
- Labels: `UNKNOWN`, `LOW_RISK_HISTORY`, `SUSPICIOUS_PATTERN`, `CONFIRMED_ABUSE` (only with documented criteria).
- Never use subjective label `SCAMMER` as a proven fact solely from clustering. Preserve investigator trace.
- Apply decay/re-evaluation and allow false-positive resolution, with audit trail.

## 4. Test token classifier

Feature signals: burst launches by same creator, duplicate metadata, names containing TEST/DEMO/DEV, near-zero organic buyer participation, repeated tiny swaps, no sustained market interest, same-wallet buy/sell loop.

Return `LIKELY_TEST`, `UNKNOWN` or `ORGANIC_CANDIDATE`. Each output carries evidence and confidence. `UNKNOWN` must not be auto-approved. Classification is heuristic, not a proof of maliciousness.

## 5. Optional social intelligence

- Collect social links from verified on-chain metadata or DEX Screener only as leads.
- Test if a known official channel independently announces the exact mint address.
- Assess timing and source provenance, not merely follower counts or verified badges.
- Social fetches run asynchronously, bounded by cost/time. Incomplete social analysis is `UNVERIFIED`, not `LEGIT`.
- Social score cannot override critical token or wallet risk failures.

## 6. Anti-poisoning

Creator reputation updates require blockchain evidence/independent confirmation. Keep separate tables for raw observations and inferred labels. Never let a freshly minted token's own metadata declare the creator trustworthy.

---
