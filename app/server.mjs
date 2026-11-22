import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Desk } from './flow.mjs'
import { team } from './team.mjs'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const DATA = process.env.DATA_DIR || path.join(ROOT, '..', 'data')
fs.mkdirSync(DATA, { recursive: true })

const cfg = {
  hspUrl: process.env.HSP_MCP_URL || 'https://mcp-qa.hashkeymerchant.com/',
  team: process.env.HSP_TEAM_NAME || 'Tandem',
  chainId: Number(process.env.CHAIN_ID || 133),
  coin: (process.env.PAY_COIN || 'USDC').toUpperCase(),
  factory: process.env.FACTORY,
  payerKey: process.env.PAYER_KEY,
  relayerKey: process.env.RELAYER_KEY,
  admin: process.env.ADMIN_TOKEN,
}

const store = {
  file: path.join(DATA, 'jobs.json'),
  jobs: [],
  load() {
    try {
      this.jobs = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.jobs = []
    }
  },
  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.jobs, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  },
  newJob(fields) {
    const job = { id: crypto.randomBytes(4).toString('hex'), created: Date.now(), status: 'quoting', log: [], ...fields }
    this.jobs.unshift(job)
    this.save()
    return job
  },
}
store.load()

const desk = new Desk(store, cfg)
desk.resume()

const publicJob = (j) => {
  const { prepared, mandate, ...rest } = j
  return rest
}

const isAdmin = (req) => {
  const t = req.headers['x-admin-token'] || ''
  return cfg.admin && t.length === cfg.admin.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(cfg.admin))
}

const body = (req) =>
  new Promise((res) => {
    let b = ''
    req.on('data', (c) => (b += c).length > 1e5 && req.destroy())
    req.on('end', () => {
      try {
        res(JSON.parse(b || '{}'))
      } catch {
        res({})
      }
    })
  })

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.woff2': 'font/woff2' }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true })
    if (url.pathname === '/api/state' && req.method === 'GET')
      return json(res, 200, {
        team: cfg.team,
        chainId: cfg.chainId,
        factory: cfg.factory,
        payer: desk.payer?.address,
        members: team(),
        pay: desk.chainConfig ? { ...desk.chainConfig, raw: undefined } : null,
        jobs: store.jobs.slice(0, 30).map(publicJob),
      })
    if (url.pathname === '/api/hsp/tools') {
      if (!isAdmin(req)) return json(res, 401, { error: 'admin only' })
      await desk.hsp.connect()
      return json(res, 200, { tools: desk.hsp.describe(), chainConfig: await desk.hsp.call('get_chain_config', {}) })
    }
    if (url.pathname === '/api/ip') {
      // the public egress IP HSP must allowlist
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
      return json(res, 200, r)
    }
    if (url.pathname === '/api/jobs' && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 401, { error: 'admin only' })
      const b = await body(req)
      const usd = Math.round(Number(b.usd || 1) * 100) / 100
      if (!(usd >= 0.1 && usd <= 50)) return json(res, 400, { error: 'usd must be 0.10–50' })
      const request = String(b.request || 'Market brief on HSK').slice(0, 200)
      const job = await desk.open(request, usd)
      return json(res, 200, publicJob(job))
    }
    const m = url.pathname.match(/^\/api\/jobs\/([0-9a-f]{8})\/approve$/)
    if (m && req.method === 'POST') {
      if (!isAdmin(req)) return json(res, 401, { error: 'admin only' })
      const job = store.jobs.find((j) => j.id === m[1])
      if (!job) return json(res, 404, { error: 'no job' })
      const { step } = await body(req)
      await desk.approve(job, step)
      return json(res, 200, publicJob(job))
    }
    // static
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const f = path.join(ROOT, 'public', rel)
    if (f.startsWith(path.join(ROOT, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' })
      return fs.createReadStream(f).pipe(res)
    }
    res.writeHead(404).end('not found')
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 500) })
  }
})

server.listen(Number(process.env.PORT || 3000), () => console.log(`Tandem on :${process.env.PORT || 3000} · chain ${cfg.chainId} · team "${cfg.team}"`))
