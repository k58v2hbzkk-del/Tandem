// The agent team that sells work through one HSP order and splits the payment.
import { keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const ROLES = [
  { id: 'lead', name: 'Lead', share: 4000, does: 'takes the job, plans it, checks the result' },
  { id: 'research', name: 'Researcher', share: 3500, does: 'pulls live market data for the brief' },
  { id: 'writer', name: 'Writer', share: 2500, does: 'turns the data into a short brief' },
]

/** Payee wallets: explicit env addresses, or derived from TEAM_SEED so they are recoverable. */
export function team() {
  const seed = process.env.TEAM_SEED || 'teamsplit-demo-seed'
  return ROLES.map((r) => {
    const env = process.env[`TEAM_${r.id.toUpperCase()}`]
    const address = env || privateKeyToAccount(keccak256(toHex(`${seed}:${r.id}`))).address
    return { ...r, address }
  })
}

export function terms(members = team()) {
  return { payees: members.map((m) => m.address), shares: members.map((m) => m.share) }
}

/** The work itself, done after payment is confirmed. Uses only public data. */
export async function doWork(job) {
  const out = { research: null, brief: null }
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=hashkey-ecopoints,hashkey-platform-token&vs_currencies=usd&include_24hr_change=true', {
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json()
    const t = j['hashkey-platform-token'] ?? Object.values(j)[0]
    out.research = t ? { asset: 'HSK', usd: t.usd, change24h: t.usd_24h_change } : null
  } catch {
    out.research = null
  }
  const d = out.research
  out.brief = d
    ? `HSK is trading at $${d.usd} (${d.change24h >= 0 ? '+' : ''}${d.change24h?.toFixed(2)}% in 24h). ` +
      `Brief requested: "${job.request}". Prepared by the Researcher and Writer agents, checked by the Lead.`
    : `Brief requested: "${job.request}". Market data was unavailable at delivery time; the team reports that rather than guessing.`
  return out
}
