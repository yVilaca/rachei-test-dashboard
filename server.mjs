import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSuites } from './suites.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 4477)

function suiteMeta() {
  return buildSuites().map(({ id, name, description, options }) => ({ id, name, description, options }))
}

// Compõe os argumentos do Playwright a partir das opções escolhidas no painel.
function composeArgs(suite, { mode, spec, grep }) {
  const args = [...suite.args]
  if (suite.id === 'e2e') {
    if (mode === 'headed') args.push('--headed')
    if (grep) args.push('-g', grep)
    if (spec) args.push(`e2e/${spec}`) // caminho relativo ao cwd (rachei/)
  }
  return args
}

function runSuite(res, suiteId, opts = {}) {
  const suite = buildSuites().find((s) => s.id === suiteId)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  if (!suite) { send({ type: 'error', message: `Suíte "${suiteId}" não encontrada.` }); return res.end() }

  suite.args = composeArgs(suite, opts)
  // No modo "Assistir", PW_SLOWMO desacelera cada ação para dar pra seguir os cliques.
  const extraEnv = {}
  if (suite.id === 'e2e' && opts.mode === 'headed' && Number(opts.slowmo) > 0) {
    extraEnv.PW_SLOWMO = String(Number(opts.slowmo))
  }
  suite.env = { ...suite.env, ...extraEnv }
  send({ type: 'start', suite: suiteId, command: `${suite.cmd} ${suite.args.join(' ')}`,
    env: Object.keys(extraEnv).length ? extraEnv : undefined })

  let passed = 0
  let failed = 0
  let output = ''
  let child
  try {
    child = spawn(suite.cmd, suite.args, {
      cwd: suite.cwd,
      env: { ...process.env, ...suite.env, NO_COLOR: '1' },
      shell: !!suite.shell,
    })
  } catch (e) {
    send({ type: 'error', message: `Falha ao iniciar: ${e.message}` })
    return res.end()
  }

  let buffer = ''
  const onData = (chunk) => {
    const text = chunk.toString()
    output += text
    buffer += text
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() // guarda o resto incompleto
    for (const line of lines) {
      send({ type: 'log', line })
      if (suite.markers.pass.test(line)) passed++
      else if (suite.markers.fail.test(line)) failed++
    }
    send({ type: 'progress', passed, failed })
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData) // Django escreve na stderr

  child.on('error', (e) => { send({ type: 'error', message: e.message }); res.end() })

  child.on('close', (code) => {
    if (buffer) send({ type: 'log', line: buffer })
    let result
    try { result = suite.parse(output) } catch (e) { result = { parseError: e.message } }
    send({ type: 'done', code, at: new Date().toISOString(), ...result })
    res.end()
  })

  // Cancelar o processo se o cliente fechar/parar.
  res.on('close', () => { if (child.exitCode == null) { try { child.kill() } catch {} } })
}

// Abre um app nativo do Playwright (janela própria, destacada do painel).
function launchGui(res, action, opts = {}) {
  const suite = buildSuites().find((s) => s.id === 'e2e')
  let args
  if (action === 'ui') {
    args = ['playwright', 'test', '--ui']
    if (opts.grep) args.push('-g', opts.grep)
    if (opts.spec) args.push(`e2e/${opts.spec}`)
  } else if (action === 'debug') {
    // Inspector: pausa em cada ação, destaca o elemento e avança com "Step".
    args = ['playwright', 'test', '--debug']
    if (opts.grep) args.push('-g', opts.grep)
    if (opts.spec) args.push(`e2e/${opts.spec}`)
  } else if (action === 'report') {
    args = ['playwright', 'show-report']
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, message: `Ação "${action}" inválida.` }))
  }
  try {
    const child = spawn(suite.cmd, args, {
      cwd: suite.cwd,
      env: { ...process.env, ...suite.env },
      shell: true,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, command: `${suite.cmd} ${args.join(' ')}` }))
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, message: e.message }))
  }
}

async function serveStatic(res) {
  try {
    const html = await readFile(path.join(__dirname, 'public', 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch {
    res.writeHead(500); res.end('index.html não encontrado')
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname === '/api/suites') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(suiteMeta()))
  }
  const run = url.pathname.match(/^\/api\/run\/([\w-]+)$/)
  if (run) return runSuite(res, run[1], {
    mode: url.searchParams.get('mode') || 'headless',
    spec: url.searchParams.get('spec') || '',
    grep: url.searchParams.get('grep') || '',
    slowmo: url.searchParams.get('slowmo') || '0',
  })
  const launch = url.pathname.match(/^\/api\/launch\/([\w-]+)$/)
  if (launch) return launchGui(res, launch[1], {
    spec: url.searchParams.get('spec') || '',
    grep: url.searchParams.get('grep') || '',
  })
  if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res)
  res.writeHead(404); res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`\n  Rachei · painel de testes`)
  console.log(`  → http://localhost:${PORT}\n`)
})
