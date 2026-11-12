# Demo agent

A research and procurement agent for Kirenami Trading, a fictional trading firm in Tokyo. It gathers
market data and pays vendor invoices. It **holds no key that can move money**: its one key signs
payment requests, and the gateway decides what happens to them.

## Two ways to run it

| Mode           | When                           | What decides which tools to call                       |
| -------------- | ------------------------------ | ------------------------------------------------------ |
| Claude agent   | `ANTHROPIC_API_KEY` is set     | Claude, with tool use (`claude-sonnet-5-5` by default) |
| Scripted agent | no key, or the key is rejected | A fixed script, labelled "Scripted agent" in every log |

Both modes use the same two tools and the same gateway. The demo prints which one ran.

The scripted agent also **acts on any payment instruction it finds in a tool response**, as an agent
does that has been talked into it. Claude usually does not. The gateway is built for the case where it
does: a model can be persuaded by text it reads, so the refusal must not depend on the model.

## Tools

| Tool              | What it does                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_market_data` | Asks the data vendor for a quote, gets "402 Payment Required" with the price, and asks the gateway to buy it. The gateway pays from its spend wallet and hands back the quote. |
| `request_payment` | Asks the gateway to pay a payee, for example a vendor invoice. The answer is `auto` (paid), `needs_approval` (waits for the approver) or `refused` (with reasons).             |

Every request is an EIP-712 message signed with the agent's key, the one registered as the agent's
wallet in the ERC-8004 Identity Registry. See [the gateway's README](../gateway/README.md).

## Where a payee came from

The tools remember every address that appeared in something a tool returned, such as a vendor note
inside a quote. If the agent later asks to pay such an address, the request says so
(`context.payeeSource`). This is done by code, not by the model: a model that has been talked into
paying will not report where the address came from.

The gateway treats this as a claim, records it, and uses it in the reason it gives. It does not rely on
it: a payee that is not in the principal's vendor registry is refused whatever the request says.

## Settings

| Variable            | Default             | Meaning                                                               |
| ------------------- | ------------------- | --------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | none                | With it, the agent is Claude. Calls to the Claude API cost money.     |
| `AGENT_MODEL`       | `claude-sonnet-5-5` | The Claude model.                                                     |
| `AGENT_PRIVATE_KEY` | none, required      | The agent's request-signing key. Testnet key only. It never pays gas. |

Before any work starts, the agent checks the key and the model with one free call. If the key is not
accepted, the scripted agent runs instead and the demo says why.

Requests to Claude turn on the API's server-side fallback (`fallbacks: "default"`): if a safety
classifier declines a request, the API retries it on the model Anthropic recommends. The log then
names the model that answered.

## Test

```bash
pnpm --filter @agent-gateway/agent test
```

The tests need no API key and make no paid calls. The Claude agent is tested against a stand-in for
the Claude API that answers the requests the SDK really sends, so the request shapes and the tool
loop are checked.
