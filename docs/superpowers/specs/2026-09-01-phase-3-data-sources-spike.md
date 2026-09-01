# Phase 3 data sources — spike findings

**Question:** Spec §12 defers two Phase 3 decisions to build time — which
Twitter provider to use, and (implicitly) where new-coin data comes from, since
§7 never names a source. This is the investigation that answers both, so
Phase 3 can start without stalling on them.

**Status:** findings only. No code was written or kept. The scope decision is
still the project owner's.

---

## 1. New-coin scanner — solved, and cheaper than expected

**Recommendation: DexScreener's public API. No account, no key, no cost.**

Verified live on 2026-09-01, not read from documentation:

| Check | Result |
|---|---|
| Requires an API key | No — 12/12 unauthenticated calls returned 200 |
| Cost | Free |
| Documented rate limit | 60 requests/minute on `token-profiles/latest/v1` |
| Rate-limit headers | None advertised; the limit is documented, not signalled |

### The discovery pipeline works in two calls

1. `GET /token-profiles/latest/v1` — recently profiled tokens. Of 30 entries
   returned, 17 were Solana. Gives `chainId` and `tokenAddress`.
2. `GET /latest/dex/tokens/{address}` — that token's pairs, with everything a
   momentum score needs.

A live example pulled during the spike, to show the signal is real and not
theoretical — a token **three minutes old**:

```
symbol:            catcall
age:               3 minutes
volume m5 / h1:    $24,983 / $24,983
buys / sells (m5): 288 / 157
price change m5:   +79.97%
mint:              BnS61WuqU6LGvy8Pu6WXezuyQqvW2HcE2tnwRBr6pump
```

That mint drops straight into the existing `buildAxiomLink`, so the alert's
Axiom button needs no new work.

### Fields available for the momentum formula

`pairCreatedAt` (age), `liquidity.usd`, `volume` (m5/h1/h6/h24), `priceChange`
(same buckets), `txns.m5.buys` / `.sells`, `fdv`, `marketCap`,
`baseToken.address`.

**One gotcha worth designing around:** `liquidity` was **undefined** on the
three-minute-old pair above. The very newest pairs — exactly the ones a scanner
cares most about — may carry no liquidity figure at all. A formula that divides
by liquidity, or filters on a minimum, would silently skip the freshest coins.
Treat it as optional.

### Why not Helius for this

Helius could detect pool creation via webhooks on the relevant programs, but it
would consume the free tier's webhook address cap that wallet tracking already
depends on (spec §7), and would still need a second source for volume and price
momentum. DexScreener supplies discovery and momentum in one place, off-budget.

---

## 2. Twitter monitor — still needs a decision, but a cheap one

No keyless option exists. This half genuinely requires an account, which is why
it stays blocked.

Current pricing, for the same job (reading tweets):

| Provider | Cost per 1,000 tweets |
|---|---|
| TwitterAPIs | ~$0.04 |
| GetXAPI | ~$0.05 |
| **TwitterAPI.io** (named in spec §7) | **~$0.15** — $1 trial credit, no card |
| SocialData.tools | ~$0.20 |
| Official X API | ~$5.00 |

**Recommendation: TwitterAPI.io**, despite not being the cheapest. It is the
one spec §7 already names, the price difference is immaterial at this volume,
and the $1 trial with no card required means Phase 3 can be built and tested
before committing anything. Monitoring even 50 handles is a rounding error
against $1 of credit.

Cheaper providers are worth revisiting only if tweet volume ever becomes a real
line item, which at this scale it will not.

**What is needed from the project owner:** an account and an API key. Nothing
else about this half is blocked.

---

## 3. What this means for Phase 3

The phase splits cleanly, and the halves are independent:

- **Coin scanner — unblocked.** Data source settled, free, verified. Needs only
  the momentum formula, which spec §12 already frames as "a reasonable starting
  formula, not a promise of optimality", to be tuned after launch.
- **Twitter monitor — one credential away.** Provider recommended above.

Both publish onto the alert bus the wallet path already uses, and the bot's
fan-out already ignores alert types it does not recognise, so neither touches
existing behaviour.

## Open decisions that remain the owner's

1. **Momentum thresholds.** What counts as worth alerting: minimum age, volume,
   buy/sell ratio, price change. Too loose floods the channel; too tight and it
   never fires. Worth picking starting values together and tuning live.
2. **Whether new-coin alerts share the `/setup` channel** or want their own.
   Spec §5.2 assumes one channel; the multi-server work chose one channel per
   server deliberately, and splitting it later is additive.
3. **Whether to build the coin scanner alone first**, shipping value while the
   Twitter credential is sorted out.

## Sources

- [DexScreener API reference](https://docs.dexscreener.com/api/reference) —
  rate limits; endpoint behaviour verified directly rather than taken on trust.
- [X API pricing 2026](https://www.twitterapis.com/twitter-api-pricing) and
  [Twitter API alternatives ranked](https://www.twitterapis.com/twitter-api-alternatives)
  — provider comparison.
- [TwitterAPI.io cost breakdown](https://twitterapi.io/blog/x-api-cost-breakdown-2026)
  — trial credit and per-tweet pricing.
