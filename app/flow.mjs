// One job, end to end: quote → HSP order to the team's split address → two human approvals →
// signed Payment Mandate → HSP Gateway → confirmation → on-chain split → delivery.
import { privateKeyToAccount } from 'viem/accounts'
import { Hsp, pick } from './hsp.mjs'
import { team, terms, doWork } from './team.mjs'
import { splitAddress, refOf, clients, verifySplit, settle, signHspTypedData, tokenBalance } from './chain.mjs'

const POLL_MS = 15_000
const DONE = ['payment-safe', 'payment-finalized']

export class Desk {
  constructor(store, cfg) {
    this.store = store
    this.cfg = cfg
    this.hsp = new Hsp(cfg.hspUrl)
    this.payer = cfg.payerKey ? privateKeyToAccount(cfg.payerKey) : null
    this.chainConfig = null
  }

  log(job, msg, data) {
    job.log.push({ at: new Date().toISOString(), msg, ...(data ? { data } : {}) })
    job.updated = Date.now()
    this.store.save()
  }

  fail(job, err) {
    job.status = 'error'
    job.error = String(err.message || err).slice(0, 800)
    this.log(job, 'Stopped: ' + job.error)
  }

  /** Reads HSP's supported network/token list and picks the configured one. */
  async payConfig() {
    if (this.chainConfig) return this.chainConfig
    const raw = await this.hsp.call('get_chain_config', {})
    const nets = [].concat(pick(raw, 'networks', 'chains') ?? raw)
    const want = String(this.cfg.chainId)
    let net = nets.find((n) => String(pick(n, 'chain_id', 'chainId')) === want) ?? nets[0]
    const tokens = [].concat(pick(net, 'tokens') ?? [])
    const tok = tokens.find((t) => String(pick(t, 'symbol', 'coin')).toUpperCase() === this.cfg.coin) ?? tokens[0]
    if (!tok) throw new Error('get_chain_config returned no token for chain ' + want)
    this.chainConfig = {
      raw,
      network: pick(net, 'network', 'name'),
      chainId: Number(pick(net, 'chain_id', 'chainId')),
      coin: pick(tok, 'symbol', 'coin'),
      token: pick(tok, 'address', 'contract_address'),
      decimals: Number(pick(tok, 'decimals')),
      protocol: pick(tok, 'payment_protocol', 'protocol'),
    }
    return this.chainConfig
  }

  /** Step 1: the Lead agent quotes and opens an HSP order paid to the team's split address. */
  async open(request, usd) {
    const job = this.store.newJob({ request, usd })
    try {
      const pc = await this.payConfig()
      const members = team()
      const { payees, shares } = terms(members)
      const orderId = `TS-${job.id}`
      const ref = refOf(orderId)
      const split = splitAddress(this.cfg.factory, payees, shares, ref)
      Object.assign(job, { orderId, ref, split, members, payees, shares, pay: pc })
      this.log(job, `Lead agent quoted $${usd} for the team: ${members.map((m) => `${m.name} ${m.share / 100}%`).join(', ')}`)
      this.log(job, `Team payment address (commits to the split): ${split}`)

      const cart = {
        contents: {
          id: orderId,
          user_cart_confirmation_required: true,
          payment_request: {
            method_data: [
              {
                supported_methods: 'https://www.x402.org/',
                data: { x402Version: 2, network: pc.network, chain_id: pc.chainId, contract_address: pc.token, pay_to: split, coin: pc.coin },
              },
            ],
            details: {
              id: `PR-${job.id}`,
              display_items: members.map((m) => ({ label: `${m.name}: ${m.does}`, amount: { currency: 'USD', value: ((usd * m.share) / 10000).toFixed(2) } })),
              total: { label: 'Team job', amount: { currency: 'USD', value: usd.toFixed(2) } },
            },
          },
          cart_expiry: new Date(Date.now() + 2 * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z'),
          merchant_name: this.cfg.team,
        },
      }
      // keep display_items consistent with the total after rounding
      const items = cart.contents.payment_request.details.display_items
      const sum = items.reduce((s, i) => s + Number(i.amount.value), 0)
      items[0].amount.value = (Number(items[0].amount.value) + (usd - sum)).toFixed(2)

      const res = await this.hsp.call('create_order', this.hsp.fit('create_order', { merchant_name: this.cfg.team, pay_to: split, cart_mandate: cart }))
      job.flowId = pick(res, 'flow_id')
      job.paymentRequestId = pick(res, 'payment_request_id')
      job.paymentUrl = pick(res, 'payment_url')
      job.status = 'ordered'
      this.log(job, 'HSP order created', { flow_id: job.flowId, payment_request_id: job.paymentRequestId })
      await this.prepare(job)
    } catch (e) {
      this.fail(job, e)
    }
    return job
  }

  /** Step 2: the Client agent checks the split on-chain, then asks HSP for the payment to sign. */
  async prepare(job) {
    const { pub } = clients(this.cfg.chainId)
    const v = await verifySplit(pub, this.cfg.factory, job.payees, job.shares, job.ref)
    if (!v.valid || v.onchain.toLowerCase() !== job.split.toLowerCase()) throw new Error('Split terms failed on-chain check; not paying')
    this.log(job, 'Client agent verified on-chain: this address can only pay the agreed team and shares')

    const res = await this.hsp.call(
      'prepare_payment',
      this.hsp.fit('prepare_payment', { flow_id: job.flowId, payer: this.payer.address, protocol: job.pay.protocol }, { payer: ['payer_address', 'from'] }),
    )
    job.prepared = res
    job.quote = {
      pay_to: pick(res, 'pay_to'),
      payer: pick(res, 'payer'),
      token_total_raw: String(pick(res, 'token_total_raw')),
      quote_expires_at: pick(res, 'quote_expires_at'),
    }
    if (job.quote.pay_to?.toLowerCase() !== job.split.toLowerCase()) throw new Error(`HSP quote pays ${job.quote.pay_to}, not the team split ${job.split}`)
    const bal = await tokenBalance(pub, job.pay.token, this.payer.address)
    if (bal < BigInt(job.quote.token_total_raw)) throw new Error(`Payer holds ${bal} raw units, needs ${job.quote.token_total_raw}. Fund the payer wallet with test ${job.pay.coin}.`)
    job.status = 'awaiting_sign'
    this.log(job, 'Waiting for your approval to sign', job.quote)
  }

  /** Human approval 1: sign. Human approval 2: submit. */
  async approve(job, step) {
    try {
      if (step === 'sign' && job.status === 'awaiting_sign') {
        if (Date.parse(job.quote.quote_expires_at) < Date.now() + 10_000) {
          this.log(job, 'Quote expired, asking HSP for a fresh one')
          return this.prepare(job)
        }
        const eip712 = pick(job.prepared, 'eip712')
        const signature = await signHspTypedData(this.payer, eip712)
        const fin = await this.hsp.call('finalize_payment', {
          ...this.hsp.fit('finalize_payment', {
            signature,
            payment_payload: pick(job.prepared, 'payment_payload'),
            payment_mandate_contents: pick(job.prepared, 'payment_mandate_contents'),
            cart_hash: pick(job.prepared, 'cart_hash'),
          }),
        })
        job.mandate = pick(fin, 'payment_mandate_json') ?? fin
        job.status = 'awaiting_submit'
        this.log(job, `Signed ${job.quote.token_total_raw} raw ${job.pay.coin} to ${job.split}. Waiting for your approval to submit.`)
      } else if (step === 'submit' && job.status === 'awaiting_submit') {
        const res = await this.hsp.call('submit_payment', this.hsp.fit('submit_payment', { payment_mandate_json: job.mandate }))
        job.status = 'submitted'
        this.log(job, 'Submitted to the HSP Gateway: ' + (pick(res, 'status') ?? 'payment-submitted'))
        this.poll(job)
      } else {
        throw new Error(`Cannot ${step} while ${job.status}`)
      }
    } catch (e) {
      if (String(e.message).includes('30043')) {
        this.log(job, 'Quote expired at the Gateway (30043): preparing a new quote to sign again')
        return this.prepare(job).catch((x) => this.fail(job, x))
      }
      this.fail(job, e)
    }
  }

  async poll(job) {
    const started = Date.now()
    const tick = async () => {
      try {
        const res = await this.hsp.call(
          'query_payment',
          this.hsp.fit('query_payment', { flow_id: job.flowId, expected_merchant_name: this.cfg.team }),
        )
        const status = pick(res, 'status')
        job.attribution = pick(res, 'attribution_verified')
        job.tx = pick(res, 'tx_signature') || job.tx
        if (status !== job.payStatus) this.log(job, `HSP status: ${status}`, { tx: job.tx, attribution_verified: job.attribution })
        job.payStatus = status
        if (DONE.includes(status)) return this.settle(job)
        if (status === 'payment-failed') return this.fail(job, new Error('HSP: ' + (pick(res, 'status_reason') ?? 'payment failed')))
        if (Date.now() - started > 600_000 && !job.pendingNoted) {
          job.pendingNoted = true
          this.log(job, `Pending confirmation. flow_id ${job.flowId}, payment_request_id ${job.paymentRequestId}`)
        }
      } catch (e) {
        this.log(job, 'Query failed, will retry: ' + e.message)
      }
      setTimeout(tick, POLL_MS)
    }
    tick()
  }

  /** Step 3: anyone can settle; our relayer does it so the team is paid right away. */
  async settle(job) {
    try {
      job.status = 'settling'
      const { pub, wallet } = clients(this.cfg.chainId, this.cfg.relayerKey || this.cfg.payerKey)
      const r = await settle(wallet, pub, this.cfg.factory, job.payees, job.shares, job.ref, job.pay.token)
      job.settleTx = r.hash
      this.log(job, `Split paid out on-chain to ${job.members.length} agents`, r)
      job.work = await doWork(job)
      job.status = 'delivered'
      this.log(job, 'Team delivered the work')
    } catch (e) {
      this.fail(job, e)
    }
  }

  /** Recover jobs that were mid-flight when the server restarted. */
  resume() {
    for (const job of this.store.jobs) {
      if (['submitted'].includes(job.status)) this.poll(job)
      if (job.status === 'settling') this.settle(job)
    }
  }
}
