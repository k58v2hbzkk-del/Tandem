const $ = (s) => document.querySelector(s)
const keyInput = $('#key')
try { keyInput.value = localStorage.getItem('deskKey') || '' } catch {}
keyInput.addEventListener('change', () => { try { localStorage.setItem('deskKey', keyInput.value) } catch {} })

const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—')
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
let explorer = 'https://testnet-explorer.hsk.xyz'

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-admin-token': keyInput.value },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}

function render(s) {
  explorer = s.chainId === 177 ? 'https://hashkey.blockscout.com' : 'https://testnet-explorer.hsk.xyz'
  $('#meta').textContent = `HSP team "${s.team}" · ${s.chainId === 177 ? 'HSK mainnet' : 'HSK testnet'} · factory ${short(s.factory)}`
  $('#members').innerHTML = s.members
    .map((m) => `<li><span>${esc(m.name)} <small class="muted">${esc(m.does)}</small></span><span class="pct">${m.share / 100}%</span><a class="addr" href="${explorer}/address/${m.address}" target="_blank">${m.address}</a></li>`)
    .join('')
  $('#jobs').innerHTML = s.jobs.length ? s.jobs.map(job).join('') : '<div class="empty">No jobs yet.</div>'
}

function job(j) {
  const link = (h, t = 'tx') => (h ? `<a href="${explorer}/${t}/${h}" target="_blank">${short(h)}</a>` : '—')
  const pay = j.pay ? `${(Number(j.usd) || 0).toFixed(2)} USD in ${esc(j.pay.coin)}` : esc(j.usd)
  const action =
    j.status === 'awaiting_sign'
      ? `<div class="act"><button data-id="${j.id}" data-step="sign">Approve signing ${esc(j.quote?.token_total_raw)} raw ${esc(j.pay?.coin)}</button></div>`
      : j.status === 'awaiting_submit'
        ? `<div class="act"><button data-id="${j.id}" data-step="submit">Approve submission to HSP</button></div>`
        : ''
  const work = j.work?.brief ? `<div class="work"><b>Delivered:</b> ${esc(j.work.brief)}</div>` : ''
  return `<article class="job">
    <div class="job-top"><h4>${esc(j.request)}</h4><span class="badge ${esc(j.status)}">${esc(j.status.replace('_', ' '))}</span></div>
    <div class="facts">
      <div><span>Price</span>${pay}</div>
      <div><span>Team address</span>${link(j.split, 'address')}</div>
      <div><span>HSP flow</span>${esc(j.flowId || '—')}</div>
      <div><span>Payment tx</span>${link(j.tx)}</div>
      <div><span>Split payout tx</span>${link(j.settleTx)}</div>
      <div><span>Team attribution</span>${j.attribution === undefined ? '—' : j.attribution ? 'verified' : 'not verified'}</div>
    </div>
    <ul class="log">${j.log.map((l) => `<li><time>${new Date(l.at).toLocaleTimeString()}</time>${esc(l.msg)}</li>`).join('')}</ul>
    ${action}${work}
  </article>`
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-step]')
  if (!b) return
  b.disabled = true
  b.textContent = 'Working…'
  try { await api(`/api/jobs/${b.dataset.id}/approve`, { step: b.dataset.step }) } catch (err) { alert(err.message) }
  load()
})

$('#new').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  btn.disabled = true
  btn.textContent = 'Opening…'
  try { await api('/api/jobs', { request: $('#req').value, usd: Number($('#usd').value) }) } catch (err) { alert(err.message) }
  btn.disabled = false
  btn.textContent = 'Open a job'
  load()
})

async function load() {
  try { render(await api('/api/state')) } catch (e) { $('#meta').textContent = 'Desk offline: ' + e.message }
}
load()
setInterval(load, 5000)
