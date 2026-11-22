# Tandem

**One HSP payment. The whole agent team gets paid.**

Built for the HSK Chain Horizon Hackathon · Seoul, track **Agent Payments & A2A Settlement (HSP)**.

## The problem inside HSP

An HSP order has exactly one `pay_to`. Real agent work is done by teams: a lead agent takes a job and
brings in specialists (research, writing, data, compute). Today the lead has to receive the whole
payment and then pay everyone else by hand, trusting itself to be honest and remembering to do it.
Nothing in the payment says who the team is or what each member is owed.

## What Tandem does

Every job gets its own payment address, and **the address is the team's agreement**:

```
split address = CREATE2(factory, orderRef, keccak256(Split code ‖ payees ‖ shares))
```

- Change one payee or one share and it becomes a different address. The paying agent can check the
  split **before** it pays, and nobody can change it afterwards.
- The address can receive the HSP payment before any contract exists there.
- When HSP confirms, anyone can call `settle`. It deploys the split if needed and pays every agent its
  share **in the same transaction**.
- No owner, no admin, no fees, no upgrades. Funds can only go to the agreed payees.

## The flow (HSP Agentic Payment, as specified in HSP's guide)

1. **Lead agent** quotes the job and its team split (Lead 40%, Researcher 35%, Writer 25%).
2. Lead opens the HSP order with `create_order`, `pay_to` = the team's split address.
3. **Client agent** checks on-chain that the factory derives the same address and that the terms are valid.
4. `prepare_payment` → the human operator **approves signing** → the client wallet signs HSP's EIP-712 data
   exactly as returned → `finalize_payment`.
5. The operator **approves submission** → `submit_payment` → HSP's Gateway executes the payment on HSK Chain.
6. `query_payment` every 15 s until `payment-safe` / `payment-finalized` (with team attribution checked).
7. `settle` pays every agent its share; the team delivers the work.

Quote expiry (5 min, Gateway code `30043`) triggers a fresh `prepare_payment` and a new signature; an old
signature is never reused. Orders are never duplicated on uncertain responses.

## Contracts (`contracts/`)

| Contract | Role |
|---|---|
| `TandemFactory` | `splitAddress`, `validTerms`, `deploy`, `settle`. Stateless, permissionless. |
| `Split` | The team address. `distribute(token)` pays the new balance by share; `claim` for a payee a token refused. |

Rules enforced on-chain: 1–10 distinct non-zero payees, non-zero shares summing to exactly 100%,
rounding dust to the first payee, re-entry blocked, a blocked payee cannot stop the others (their share is
reserved for `claim`), USDT-style tokens without return values supported.

```
cd contracts
forge install --no-git foundry-rs/forge-std@v1.9.4
forge test -vv        # 12 tests incl. fuzzing
```

### Owner permissions

None. There is no owner or admin in any contract.

## End-to-end test

`npm run e2e` starts a local chain (chain id 133), deploys the factory and an EIP-3009 token, runs a local
stand-in for the HSP MCP server with the same eight tools, and drives the real app through the whole flow.
The Gateway step executes a real `transferWithAuthorization`, so the client's EIP-712 signature is checked
by a contract. Result: 1.50 USDC split 0.60 / 0.525 / 0.375 in one transaction.

## Run it against HSP QA

Prerequisites from HSP's guide: the server's public egress IP must be on HSP's QA allowlist, and the payer
wallet must hold the HSP QA test token returned by `get_chain_config`.

```
npm ci
HSP_TEAM_NAME="<team name>" FACTORY=0x... PAYER_KEY=0x... RELAYER_KEY=0x... ADMIN_TOKEN=... npm start
```

`GET /api/ip` shows the egress IP to send to HSP. `render.yaml` deploys the desk to Render.

## Deploy

Repo secret `DEPLOYER_KEY` (a fresh wallet with a little HSK, never a main wallet), then run the **deploy**
workflow (testnet or mainnet). It tests, deploys, verifies on the HashKey explorer and commits the address
to `deployments/`.

## License

MIT
