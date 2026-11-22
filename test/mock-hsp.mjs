// Local stand-in for the HSP Agentic Payment MCP server, for end-to-end tests only.
// Same eight tools; the Gateway step executes a real EIP-3009 transfer on a local chain,
// so the client's EIP-712 signing is verified by a contract, not by this mock.
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { createWalletClient, createPublicClient, http as vhttp, parseSignature, keccak256, toHex, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC = process.env.RPC
const TOKEN = process.env.TOKEN
const chain = defineChain({ id: 133, name: 'local', nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const gateway = createWalletClient({ chain, transport: vhttp(), account: privateKeyToAccount(process.env.GATEWAY_KEY) })
const pub = createPublicClient({ chain, transport: vhttp() })
const abi = [{ type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', inputs: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' } ], outputs: [] }]

const orders = new Map()
const out = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] })

function build() {
  const s = new McpServer({ name: 'mock-hsp', version: '0' })
  s.tool('get_chain_config', {}, async () => out({ networks: [{ network: 'hashkey-testnet', chain_id: 133, tokens: [{ symbol: 'USDC', address: TOKEN, decimals: 6, payment_protocol: 'eip3009' }] }] }))
  s.tool('create_order', { merchant_name: z.string(), pay_to: z.string(), cart_mandate: z.any() }, async ({ merchant_name, pay_to, cart_mandate }) => {
    const flow_id = 'flow-' + Math.random().toString(16).slice(2, 10)
    const usd = cart_mandate.contents.payment_request.details.total.amount.value
    orders.set(flow_id, { merchant_name, pay_to, usd, status: 'created', payment_request_id: cart_mandate.contents.payment_request.details.id })
    return out({ flow_id, payment_request_id: cart_mandate.contents.payment_request.details.id, payment_url: 'https://pay.example/flow/' + flow_id })
  })
  s.tool('get_order', { flow_id: z.string() }, async ({ flow_id }) => out(orders.get(flow_id)))
  s.tool('estimate_fee', { flow_id: z.string() }, async () => out({ gas_fee: '0', gas_fee_advanced: true }))
  s.tool('prepare_payment', { flow_id: z.string(), payer_address: z.string(), protocol: z.string() }, async ({ flow_id, payer_address }) => {
    const o = orders.get(flow_id)
    const value = String(Math.round(Number(o.usd) * 1e6))
    const now = Math.floor(Date.now() / 1000)
    const eip712 = {
      domain: { name: 'USD Coin', version: '2', chainId: '133', verifyingContract: TOKEN },
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
      },
      primaryType: 'TransferWithAuthorization',
      message: { from: payer_address, to: o.pay_to, value, validAfter: '0', validBefore: String(now + 3600), nonce: keccak256(toHex(flow_id)) },
    }
    o.eip712 = eip712
    return out({ eip712, cart_hash: 'ab'.repeat(32), token_total_raw: value, quote_expires_at: new Date(Date.now() + 300e3).toISOString(), pay_to: o.pay_to, payer: payer_address, payment_request_id: o.payment_request_id, payment_payload: { payload: { signature: '' }, flow_id }, payment_mandate_contents: { flow_id } })
  })
  s.tool('finalize_payment', { signature: z.string(), payment_payload: z.any(), payment_mandate_contents: z.any(), cart_hash: z.string() }, async ({ signature, payment_payload }) =>
    out({ payment_mandate_json: JSON.stringify({ flow_id: payment_payload.flow_id, signature }) }))
  s.tool('submit_payment', { payment_mandate_json: z.string() }, async ({ payment_mandate_json }) => {
    const { flow_id, signature } = JSON.parse(payment_mandate_json)
    const o = orders.get(flow_id)
    const m = o.eip712.message
    const { v, r, s: ss } = parseSignature(signature)
    const hash = await gateway.writeContract({ address: TOKEN, abi, functionName: 'transferWithAuthorization', args: [m.from, m.to, BigInt(m.value), 0n, BigInt(m.validBefore), m.nonce, Number(v), r, ss] })
    const rc = await pub.waitForTransactionReceipt({ hash })
    o.status = rc.status === 'success' ? 'payment-finalized' : 'payment-failed'
    o.tx = hash
    return out({ status: 'payment-submitted' })
  })
  s.tool('query_payment', { flow_id: z.string(), expected_merchant_name: z.string() }, async ({ flow_id, expected_merchant_name }) => {
    const o = orders.get(flow_id)
    return out({ payment: { status: o.status, tx_signature: o.tx ?? '', to_pay_address: o.pay_to }, attribution_verified: o.merchant_name === expected_merchant_name })
  })
  return s
}

http
  .createServer(async (req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', async () => {
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const s = build()
      await s.connect(t)
      await t.handleRequest(req, res, b ? JSON.parse(b) : undefined)
    })
  })
  .listen(Number(process.env.MOCK_PORT || 7070), () => console.log('mock HSP on', process.env.MOCK_PORT || 7070))
