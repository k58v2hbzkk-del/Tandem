// Thin client for HSP Agentic Payment (MCP over Streamable HTTP).
// Tool names and input schemas are read live from the server, as the HSP guide requires.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const REQUIRED = [
  'get_chain_config',
  'create_order',
  'get_order',
  'prepare_payment',
  'finalize_payment',
  'estimate_fee',
  'submit_payment',
  'query_payment',
]

export class Hsp {
  constructor(url) {
    this.url = url
    this.client = null
    this.tools = {}
  }

  async connect() {
    if (this.client) return
    const client = new Client({ name: 'tandem-agent', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(this.url)))
    const { tools } = await client.listTools()
    // client-side prefixes can differ: match by suffix
    for (const t of tools) {
      const base = REQUIRED.find((r) => t.name === r || t.name.endsWith(r))
      if (base) this.tools[base] = t
    }
    const missing = REQUIRED.filter((r) => !this.tools[r])
    if (missing.length) throw new Error(`HSP tools missing: ${missing.join(', ')}`)
    this.client = client
  }

  schema(tool) {
    return this.tools[tool]?.inputSchema ?? {}
  }

  describe() {
    return Object.fromEntries(
      Object.entries(this.tools).map(([k, t]) => [k, { name: t.name, description: t.description, inputSchema: t.inputSchema }]),
    )
  }

  /** Calls a tool and returns its JSON result (structuredContent, or parsed text). */
  async call(tool, args) {
    await this.connect()
    const res = await this.client.callTool({ name: this.tools[tool].name, arguments: args })
    const out = res.structuredContent ?? parseText(res.content)
    if (res.isError) {
      const msg = typeof out === 'string' ? out : JSON.stringify(out)
      throw Object.assign(new Error(`${tool}: ${msg.slice(0, 600)}`), { result: out })
    }
    return out
  }

  /**
   * Maps our semantic arguments onto the live schema's property names.
   * `wanted` is { semanticKey: value }, `aliases` is { semanticKey: [possible property names] }.
   */
  fit(tool, wanted, aliases = {}) {
    const props = Object.keys(this.schema(tool).properties ?? {})
    const args = {}
    for (const [key, value] of Object.entries(wanted)) {
      if (value === undefined) continue
      const names = [key, ...(aliases[key] ?? [])]
      const hit = names.find((n) => props.includes(n)) ?? props.find((p) => names.some((n) => p.toLowerCase().includes(n.toLowerCase())))
      args[hit ?? key] = value
    }
    return args
  }
}

function parseText(content = []) {
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Finds the first value for any of `keys` anywhere inside a nested object. */
export function pick(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) if (obj[k] !== undefined) return obj[k]
  for (const v of Object.values(obj)) {
    const r = typeof v === 'object' ? pick(v, ...keys) : undefined
    if (r !== undefined) return r
  }
  return undefined
}
