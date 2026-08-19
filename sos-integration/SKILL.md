---
name: sos-integration
description: Integrate an application with the SWA Odds Service (SOS), connecting to the live odds feed, consuming odds changes, settlements and heartbeats over AMQP, handling recovery, and mapping SWA market templates onto your own markets. Use this whenever someone mentions SOS, the SWA Odds Service, the SWA odds feed, @swa/uof-sdk, SwaUofClient, or is wiring up live MMA, boxing, tennis, table tennis or volleyball odds from SWA: including when they only describe the symptom ("my consumer connects but no messages arrive", "odds stopped after a disconnect", "what do these market ids mean") without naming the product.
---

# Integrating with the SWA Odds Service

SOS delivers live odds, settlements and control messages over AMQP. Partners
bind a queue to a topic exchange and consume XML messages, usually through the
TypeScript SDK.

Most failed integrations fail quietly rather than loudly: a queue bound to
nothing receives no messages and no error, and a fixtures call returns the wrong
sport's data with a 200. So the ordering below front-loads the things that fail
silently, before anything that would throw.

## Use the MCP server as the source of truth

If the SOS MCP server is connected (`swa-odds-service`, at `/docs/mcp/sos`),
prefer it over recalling anything from memory. It reads the live documentation,
so it reflects what is actually published rather than what was true when this
skill was written.

| Question | Tool |
|---|---|
| Which sports are published? | `sos_overview`: the list is appended at the end |
| What is SOS, how do messages flow? | `sos_overview` |
| How do I connect and get a first message? | `sos_quickstart` |
| What are the exact client options, events, methods? | `sos_client_reference` |
| Broker topology, exchange, routing keys | `sos_connection` |
| What does an `odds_change` look like? | `sos_message_reference` |
| What happens after a disconnect? | `sos_recovery` |
| Which markets will I receive? | `sos_market_catalogue` |
| Which legs can be combined? | `sos_betbuilder_combinations` |

Call `sos_client_reference` before writing any client configuration. It returns
the constructor options with their real defaults and a `knownBehaviour` list;
both of the traps below come back in that list, so you get them without relying
on this file being current.

## When the MCP is unreachable: stop, do not improvise

The only safe fallbacks are the published docs site and the specifics this
file itself confirms. Everything else is a hard rule:

- **Never generate example payloads, market lists or market ids from general
  betting knowledge.** They will be wrong three ways at once: format (the
  feed is XML over AMQP: a JSON "price update" is wrong by construction),
  ids (SOS market ids are templates like `fight_winner_bin{ }`, not numeric
  ids), and coverage (invented markets look authoritative exactly where
  being wrong is expensive). A worked example has one source:
  `sos_message_reference`, live.
- **The published sports list is exhaustive.** `sos_overview` ends with it.
  Asked about any sport not on it, football, basketball, anything, the
  answer is "not offered by SOS", never an example. Do not pick a
  "different sport" that SOS does not carry.
- **Fix the connection instead of working around it.** In order: (1)
  `git pull && npm run build`: the default endpoint is
  `https://docs.swa.one/docs/mcp/sos` and older clones default to a host
  that never served it; (2) set `SOS_MCP_URL` explicitly if you need a
  different environment; (3) the endpoint is public: no VPN needed. If it
  still fails, say so and ask whoever owns the docs. **Do not path-probe
  production gateways guessing routes.**

## Three things that will cost you an afternoon

**The package is not called SOS.** The product was renamed from Unified Odds
Feed to SWA Odds Service, but the npm package is still `@swa/uof-sdk` and the
class is still `SwaUofClient`. This is deliberate, so existing integrations keep
working. Import those names: an SOS-prefixed variant does not exist.

```typescript
import { SwaUofClient } from "@swa/uof-sdk";
```

**The default binding patterns are MMA-only.** `bindingPatterns` defaults to
`['mma.live.#', 'system.live.alive.#']`. Integrating tennis and leaving that
default means the queue binds to nothing relevant: no messages, no error, no
clue. Set it explicitly for anything other than MMA.

```typescript
bindingPatterns: ["tennis.live.#", "system.live.alive.#"],
```

**`getFixtures()` ignores the sport.** It requests MMA fixtures whatever you are
integrating and returns them with a 200. For any other sport, call the REST
endpoint yourself:

```
GET {apiHost}/uof-api/v1/sports/{sport}/events/json
```

Confirm all three against `sos_client_reference` rather than trusting this list
if the two ever disagree: the MCP reads the live docs.

## Connecting

Work in this order, because each step's failure mode is easier to diagnose in
isolation than in combination.

1. **Confirm credentials and hosts.** `accessToken`, `amqpHost` and `apiHost`
   are all required. Get them from SWA: they are per-partner.
2. **Set `bindingPatterns` for the sport** before the first connect, per above.
3. **Connect and log raw events first.** Attach `connected`, `disconnected` and
   `error` handlers and confirm you see `connected` and then `alive` messages
   before writing any odds-handling logic. If `alive` arrives but `oddsChange`
   never does, the binding patterns are wrong: not the credentials.
4. **Then handle `oddsChange`, `betSettlement` and `betStop`.**

```typescript
const client = new SwaUofClient({
  accessToken: process.env.SOS_ACCESS_TOKEN,
  amqpHost: "amqps://<broker-host>",
  apiHost: "https://<api-host>",
  bindingPatterns: ["<sport>.live.#", "system.live.alive.#"],
  aliveTimeoutMs: 30_000,
  autoRecover: true,
});

client.on("connected", () => console.log("connected"));
client.on("alive", () => console.log("producer alive"));
client.on("oddsChange", (event) => { /* … */ });
client.on("error", (err) => console.error(err.message));

await client.connect();
```

## Events, and the one that does not exist

The client emits `oddsChange`, `betSettlement`, `betStop`, `alive`, `connected`,
`disconnected`, `recoveryStarted`, `recoveryCompleted` and `error`.

There is **no `recoveryFailed` event**: a failed recovery surfaces on `error`
like anything else. Older documentation described one, along with a `UofSdk`
class that was never exported. If you find code listening for either, it has
been silently dead.

## Recovery and liveness

`alive` is the producer heartbeat. If none arrives within `aliveTimeoutMs`
(30s by default), the client treats the producer as down. With `autoRecover`
left on, reconnecting requests a replay of what was missed, and you get
`recoveryStarted` with an estimated message count, then `recoveryCompleted`.

Treat odds received between `disconnected` and `recoveryCompleted` as
provisional: during recovery you are replaying history, so a market may move
several times in quick succession before settling on its current state. Ask
`sos_recovery` for the detail, and drive recovery through the REST API only if
you are consuming with a plain AMQP client rather than the SDK.

## Reading the market catalogue

`sos_market_catalogue` returns what a sport actually publishes. Two conventions
surprise people:

**Market ids are templates, not literal ids.** A braced blank marks a value
supplied per event: `fight_winner_bin{ }`, and a braced list enumerates
alternatives: `fight_winner_3way_{red|draw|blue}`. Do not match on them as
fixed strings; parse the template or map on the market name.

**`notOffered` means the market does not apply.** Some markets exist in the
catalogue but are not offered for a particular variant: a round-range market on
a one-round fight, for instance. Those come back with `notOffered: true` and no
selections, rather than being absent. Skip them rather than rendering an empty
market.

For BetBuilder, `sos_betbuilder_combinations` gives each leg and what it cannot
be combined with. The relation is symmetric: a blocked pair appears on both
legs, so checking either direction is enough, and anything not listed as
excluded is combinable.

## When something is wrong

Match the symptom, since the causes are unrelated:

| Symptom | Look at |
|---|---|
| Connects, `alive` arrives, no odds | `bindingPatterns`: almost always the sport prefix |
| Nothing at all, not even `alive` | Credentials, `amqpHost`, network path to the broker |
| Fixtures are for the wrong sport | `getFixtures()`: use the REST endpoint instead |
| Odds stop after a network blip | `autoRecover`, and whether `recoveryCompleted` fires |
| A market id does not match anything | It is a template: see above |
| Import fails | The package is `@swa/uof-sdk`, not an SOS-named one |

`references/troubleshooting.md` has the longer version, including what to log
when escalating to SWA.
