// HashKey Chain access: split address maths, on-chain checks and settlement.
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, getContractAddress, keccak256, toHex, concat } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'

const art = JSON.parse(readFileSync(new URL('./abi/TeamSplit.json', import.meta.url), 'utf8'))
export const factoryAbi = art.factoryAbi
export const splitAbi = art.splitAbi

export const hskTestnet = defineChain({
  id: 133,
  name: 'HashKey Chain Testnet',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: [process.env.HSK_TESTNET_RPC || 'https://testnet.hsk.xyz'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://testnet-explorer.hsk.xyz' } },
})
export const hskMainnet = defineChain({
  id: 177,
  name: 'HashKey Chain',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: [process.env.HSK_MAINNET_RPC || 'https://mainnet.hsk.xyz'] } },
  blockExplorers: { default: { name: 'Explorer', url: 'https://hashkey.blockscout.com' } },
})

export const chainFor = (id) => (Number(id) === 177 ? hskMainnet : hskTestnet)

/** Job reference → CREATE2 salt. */
export const refOf = (orderId) => keccak256(toHex(orderId))

/** The team's payment address, computed exactly as TeamSplitFactory.splitAddress does. */
export function splitAddress(factory, payees, shares, ref) {
  const args = encodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }], [payees, shares.map(Number)])
  return getContractAddress({ opcode: 'CREATE2', from: factory, salt: ref, bytecode: concat([art.splitBytecode, args]) })
}

export function clients(chainId, key) {
  const chain = chainFor(chainId)
  const pub = createPublicClient({ chain, transport: http() })
  const wallet = key ? createWalletClient({ chain, transport: http(), account: privateKeyToAccount(key) }) : null
  return { chain, pub, wallet }
}

const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]

export async function tokenBalance(pub, token, who) {
  return pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] })
}

/** Confirms on-chain that the factory derives the same address for these terms. */
export async function verifySplit(pub, factory, payees, shares, ref) {
  const [onchain, valid] = await Promise.all([
    pub.readContract({ address: factory, abi: factoryAbi, functionName: 'splitAddress', args: [payees, shares, ref] }),
    pub.readContract({ address: factory, abi: factoryAbi, functionName: 'validTerms', args: [payees, shares] }),
  ])
  return { onchain, valid }
}

export async function settle(wallet, pub, factory, payees, shares, ref, token) {
  const hash = await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'settle', args: [payees, shares, ref, token] })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  return { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() }
}

/**
 * Signs HSP's EIP-712 payload exactly as returned. viem needs uint/int values as bigint, so numeric
 * strings are converted according to the declared types; nothing else is changed.
 */
export async function signHspTypedData(account, eip712) {
  const types = { ...eip712.types }
  delete types.EIP712Domain
  const conv = (type, v) => {
    if (v === null || v === undefined) return v
    if (/^u?int\d*$/.test(type)) return BigInt(v)
    if (type.endsWith('[]')) return v.map((x) => conv(type.slice(0, -2), x))
    if (types[type]) return Object.fromEntries(types[type].map((f) => [f.name, conv(f.type, v[f.name])]))
    return v
  }
  const domain = { ...eip712.domain }
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId)
  const message = conv(eip712.primaryType, eip712.message)
  return account.signTypedData({ domain, types, primaryType: eip712.primaryType, message })
}
