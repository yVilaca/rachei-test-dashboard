# Rachei · Painel de Testes

Uma tela local, bonita e reativa para **rodar e visualizar os testes** dos dois
repos num só lugar: backend (Django), frontend (Vitest) e E2E (Playwright).

Botões para rodar cada suíte (ou tudo), **saída ao vivo**, **contadores em tempo
real**, **lista por teste** (clique numa falha para ver o erro/stack), filtro
"só falhas", histórico e tema claro/escuro.

### Acompanhar o Playwright (E2E)

Ao selecionar o card **E2E**, aparece uma barra de controles:

- **Modo** — `Headless` (rápido, sem janela) ou **`Assistir`** (`--headed`: abre o
  Chromium e você vê cada passo enquanto os resultados chegam no painel).
- **Velocidade** — (só no modo Assistir) desacelera cada ação via `PW_SLOWMO`
  (`Normal`/`Devagar`/`Bem devagar`/`Passo lento`) para dar pra **seguir clique a clique**.
- **Fluxo** — rodar todos ou só um `.spec.ts` (a lista é descoberta sozinha, com a
  contagem de testes de cada arquivo).
- **Filtro por texto** — passa `-g` para rodar só os testes cujo título casa.
- **Passo a passo** — abre o **Inspector** (`playwright test --debug`): pausa em
  cada ação, destaca o elemento na tela e você avança clicando "Step".
- **Modo UI** — abre o depurador interativo do Playwright (`playwright test --ui`)
  em janela própria: escolhe, assiste, volta no tempo e inspeciona o DOM.
- **Relatório** — abre o último relatório HTML (`playwright show-report`) com os
  **traces** das falhas (trace/vídeo/screenshot são gravados em falhas).

## Como usar

```bash
cd test-dashboard
node server.mjs
```
Abra **http://localhost:4477** no navegador. Clique em **Rodar** num card ou em
**Rodar tudo**.

> Não precisa instalar nada — o servidor é Node puro, sem dependências. Requer
> apenas o Node (já usado pelo projeto) e que os repos `rachei`/`rachei-backend`
> estejam ao lado desta pasta.

## O que cada card roda

| Card | Comando | Pré-requisitos |
|------|---------|----------------|
| **Backend** | `python manage.py test --settings=config.settings_test` | Postgres no ar |
| **Frontend** | `vitest run` | — |
| **E2E** | `playwright test` | banco `rachei_e2e` + `npx playwright install chromium` (ver `rachei/e2e/README.md`) |

## Como funciona (resumo)

- `server.mjs` — servidor HTTP + SSE. Ao clicar em Rodar, executa o comando real
  da suíte e transmite a saída linha a linha para a tela.
- `suites.mjs` — define as suítes e faz o parsing dos resultados: JSON do
  Vitest/Playwright e a saída de texto do Django. Contadores vêm do rodapé
  autoritativo de cada runner; a lista por teste é para o detalhamento.
- `public/index.html` — a UI (sem build).

## Estender

Para adicionar uma suíte nova, basta um item em `buildSuites()` no `suites.mjs`
(comando + como parsear). Testes novos dentro de suítes existentes aparecem
sozinhos — o painel só re-executa o runner.

> Ferramenta de desenvolvimento — nunca vai para produção.
