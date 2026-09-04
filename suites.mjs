import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const BACKEND = path.resolve('../rachei-backend')
const FRONTEND = path.resolve('../rachei')

function tmpReport(name) {
  return path.join(os.tmpdir(), `rachei-${name}-${Date.now()}.json`)
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// Descobre os specs de e2e e seus títulos (para o seletor do painel).
export function listE2ESpecs() {
  const dir = path.join(FRONTEND, 'e2e')
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.ts')) } catch { return [] }
  return files.sort().map((file) => {
    let titles = []
    try {
      const src = fs.readFileSync(path.join(dir, file), 'utf8')
      titles = [...src.matchAll(/\btest\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
    } catch { /* ignora */ }
    return { file, titles }
  })
}

// ── Django (parse da saída de texto, --verbosity=2) ───────────────────────────
function parseDjango(output) {
  const lines = output.split(/\r?\n/)
  const tests = []
  const failed = [] // guarda entradas falhas na ordem para casar com os blocos de erro

  for (const line of lines) {
    const m = line.match(/^(.*?) \.\.\. (ok|FAIL|ERROR|skipped.*)$/)
    if (!m) continue
    const name = m[1].trim()
    const raw = m[2]
    const status = raw === 'ok' ? 'passed' : raw.startsWith('skipped') ? 'skipped' : 'failed'
    const t = { name, suite: 'backend', status, durationMs: null, error: null }
    tests.push(t)
    if (status === 'failed') failed.push(t)
  }

  // Blocos de erro: "====\nFAIL: nome\n----\n<traceback>" — casa por ordem.
  const blocks = output.split(/={60,}\n/).slice(1)
  let fi = 0
  for (const b of blocks) {
    const hm = b.match(/^(FAIL|ERROR): (.+)$/m)
    if (!hm) continue
    const body = b.split(/-{60,}\n/).slice(1).join('---\n').trim()
    if (failed[fi]) { failed[fi].error = `${hm[1]}: ${hm[2]}\n\n${body}`; fi++ }
  }

  // Contagens autoritativas vêm do rodapé do Django (Ran N / OK / FAILED(...)).
  // A lista `tests` é o melhor esforço para o detalhamento (falhas sempre entram).
  const ran = output.match(/Ran (\d+) tests? in ([\d.]+)s/)
  const total = ran ? Number(ran[1]) : tests.length
  const durationMs = ran ? Math.round(Number(ran[2]) * 1000) : null
  const skipped = tests.filter((t) => t.status === 'skipped').length
  const failMatch = output.match(/FAILED \(([^)]*)\)/)
  let failedN = tests.filter((t) => t.status === 'failed').length
  if (failMatch) {
    const f = failMatch[1].match(/failures=(\d+)/)
    const e = failMatch[1].match(/errors=(\d+)/)
    failedN = (f ? Number(f[1]) : 0) + (e ? Number(e[1]) : 0)
  }
  const passed = Math.max(0, total - failedN - skipped)
  return { summary: { total, passed, failed: failedN, skipped, durationMs }, tests }
}

// ── Vitest (relatório JSON) ───────────────────────────────────────────────────
function parseVitest(_output, reportPath) {
  const j = readJson(reportPath)
  if (!j) return { summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: null }, tests: [], parseError: true }
  const tests = []
  for (const file of j.testResults ?? []) {
    const rel = (file.name || '').split(/[\\/]/).slice(-2).join('/')
    for (const a of file.assertionResults ?? []) {
      const suiteTitle = (a.ancestorTitles ?? []).join(' › ')
      tests.push({
        name: suiteTitle ? `${suiteTitle} › ${a.title}` : a.title,
        suite: rel,
        status: a.status === 'passed' ? 'passed' : a.status === 'skipped' || a.status === 'todo' ? 'skipped' : 'failed',
        durationMs: a.duration != null ? Math.round(a.duration) : null,
        error: (a.failureMessages ?? []).join('\n\n') || null,
      })
    }
  }
  return {
    summary: {
      total: j.numTotalTests ?? tests.length,
      passed: j.numPassedTests ?? tests.filter((t) => t.status === 'passed').length,
      failed: j.numFailedTests ?? tests.filter((t) => t.status === 'failed').length,
      skipped: j.numPendingTests ?? tests.filter((t) => t.status === 'skipped').length,
      durationMs: j.startTime && j.endTime
        ? j.endTime - j.startTime
        : tests.reduce((a, t) => a + (t.durationMs || 0), 0) || null,
    },
    tests,
  }
}

// ── Playwright (relatório JSON) ───────────────────────────────────────────────
function parsePlaywright(_output, reportPath) {
  const j = readJson(reportPath)
  if (!j) return { summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: null }, tests: [], parseError: true }
  const tests = []
  const walk = (suite, trail) => {
    const name = suite.title ? [...trail, suite.title] : trail
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = (t.results ?? [])[t.results.length - 1] ?? {}
        const st = last.status
        tests.push({
          name: spec.title,
          suite: name.join(' › '),
          status: st === 'passed' ? 'passed' : st === 'skipped' ? 'skipped' : 'failed',
          durationMs: last.duration != null ? Math.round(last.duration) : null,
          error: last.error ? (last.error.message || JSON.stringify(last.error)).replace(/\[[0-9;]*m/g, '') : null,
        })
      }
    }
    for (const s of suite.suites ?? []) walk(s, name)
  }
  for (const s of j.suites ?? []) walk(s, [])
  const passed = tests.filter((t) => t.status === 'passed').length
  const failed = tests.filter((t) => t.status === 'failed').length
  const skipped = tests.filter((t) => t.status === 'skipped').length
  return {
    summary: { total: tests.length, passed, failed, skipped, durationMs: j.stats?.duration != null ? Math.round(j.stats.duration) : null },
    tests,
  }
}

// ── Definição das suítes ──────────────────────────────────────────────────────
export function buildSuites() {
  const vitestReport = tmpReport('vitest')
  const pwReport = tmpReport('playwright')
  return [
    {
      id: 'backend',
      name: 'Backend',
      description: 'Django · regras de negócio, segurança e autorização (Postgres)',
      cwd: BACKEND,
      cmd: 'python',
      args: ['manage.py', 'test', '--settings=config.settings_test', '--verbosity=2'],
      env: {},
      markers: { pass: / \.\.\. ok$/, fail: / \.\.\. (FAIL|ERROR)/ },
      parse: (out) => parseDjango(out),
    },
    {
      id: 'frontend',
      name: 'Frontend',
      description: 'Vitest + Testing Library + MSW · serviços, páginas e componentes',
      cwd: FRONTEND,
      cmd: 'npx',
      args: ['vitest', 'run', '--reporter=verbose', '--reporter=json', `--outputFile=${vitestReport}`],
      env: {},
      shell: true,
      markers: { pass: /^\s*[✓√]/, fail: /^\s*[×✗❯]/ },
      parse: (out) => parseVitest(out, vitestReport),
    },
    {
      id: 'e2e',
      name: 'E2E',
      description: 'Playwright · fluxos ponta a ponta contra a stack real',
      cwd: FRONTEND,
      cmd: 'npx',
      args: ['playwright', 'test', '--reporter=list,json'],
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: pwReport },
      shell: true,
      markers: { pass: /✓|\bok\b/, fail: /✘|✗|failed/ },
      parse: (out) => parsePlaywright(out, pwReport),
      // Configuração/acompanhamento exposto no painel (só a suíte E2E tem).
      options: {
        modes: [
          { id: 'headless', label: 'Headless', hint: 'Rápido, sem janela — o padrão de CI.' },
          { id: 'headed', label: 'Assistir', hint: 'Abre o Chromium e você vê cada passo.' },
        ],
        // Velocidade (slowMo, ms) — só faz efeito no modo "Assistir".
        speeds: [
          { id: '0', label: 'Normal' },
          { id: '400', label: 'Devagar' },
          { id: '800', label: 'Bem devagar' },
          { id: '1500', label: 'Passo lento' },
        ],
        // Ações que abrem apps nativos do Playwright (janela própria, fora do painel).
        gui: [
          { id: 'debug', label: 'Passo a passo', hint: 'Abre o Inspector: pausa em cada ação, destaca o elemento e você avança clicando "Step".' },
          { id: 'ui', label: 'Modo UI', hint: 'Depurador interativo: escolhe, assiste e volta no tempo.' },
          { id: 'report', label: 'Relatório', hint: 'Último relatório HTML com traces das falhas.' },
        ],
        specs: listE2ESpecs(),
      },
    },
  ]
}
