# OWNR Habitat

**Agents generate change. OWNR decides what survives.**

Plano de controle de evolução em circuito fechado. O software evoluído (o **organismo**) vive no seu próprio repositório git; o Habitat só o referencia por configuração e nunca vive dentro dele. O primeiro organismo é o OWNR Replay (`../ownr-replay`).

```text
OWNR Habitat (este repo)                      Organismo (ex.: ../ownr-replay)
Mission · Envelope · Evaluators · Selector    código, testes, instrumentos
Recorder · MutationProvider · Cockpit    ──►  baseline = rev-parse <baselineRef>
         controla / observa                   candidates = worktrees + refs/habitat/candidates/*
```

```bash
bun install
bun run habitat serve                              # Cockpit em http://127.0.0.1:3100 (só loopback)
bun run habitat observe                            # mede a baseline do organismo num worktree isolado
bun run habitat evolve <proposta>                  # candidate isolado → avaliadores → decisão
bun run habitat reevaluate <candidate>             # repete a mudança sobre a baseline atual
bun run habitat accept <candidate> --by <nome>     # ato humano: fast-forward da baseline do organismo
bun run habitat revise-mission --by <nome>         # ato humano: adota uma definição de missão alterada
bun run habitat status
bun test && bunx tsc --noEmit
```

Configuração (todas opcionais): `HABITAT_RUNNER` (`sandbox` | `trusted-local`), `HABITAT_PORT`, `HABITAT_DB` (`habitat.sqlite`), `HABITAT_WORKTREES` (`~/.cache/ownr-habitat/worktrees`), `HABITAT_ORGANISM` (`replay`). Organismo Replay: `REPLAY_REPOSITORY` (`../ownr-replay`), `REPLAY_BASELINE_REF` (`main`), `REPLAY_EVENTS_DB` (`repo-replay.sqlite`, relativo ao organismo), `REPLAY_PROPOSALS` (`proposals/replay`).

- **Organismo**: `Organism { repositoryPath, baselineRef, allowedPaths }`. A baseline é sempre `git rev-parse <baselineRef>^{commit}` no repositório do organismo — commits no Habitat não a movem.
- **Missão** `replay-ttvo-m1`, envelope, fitness (proxies × outcomes) e métricas protegidas: `src/replay/organism.ts`. Snapshot em `habitat.sqlite`; mudar a definição exige `revise-mission`.
- **Avaliadores**: path policy (antes de tudo), instrumentos do organismo (`bun scripts/measure.ts curriculum|bundle`, JSON validado), `tsc`, `bun test`. A identidade de cada avaliador é derivada: hash dos arquivos que o implementam + hash da configuração (argv, timeout, parser, parâmetros).
- **Sandbox** (padrão `HABITAT_RUNNER=sandbox`): comandos do organismo rodam sem rede, em raiz read-only com só o checkout gravável (`/work`), `/tmp` privado, limites cgroup v2 (2 GB, 512 PIDs, 2 CPUs), timeout que mata o cgroup inteiro, usuário nobody sem capabilities, ambiente allowlist e seccomp default-deny (syscall proibida = processo morto por SIGSYS = violação do sandbox).
- **Dependências herméticas**: cada revisão usa a árvore que seus `package.json` + `bun.lock` commitados determinam (`HABITAT_DEPENDENCIES`, padrão `~/.cache/ownr-habitat/dependencies`), com hash de conteúdo, read-only, re-verificada antes e depois de cada job; árvore alterada é reconstruída e precisa reproduzir o hash, senão a avaliação é recusada. O `node_modules` do organismo não é usado.
- **Um job por vez entre processos**: CLI e servidor compartilham um lease em `habitat.sqlite`; processo morto libera na hora, host remoto expira sem heartbeat. `trusted-local` só por opção explícita.
- **Proveniência**: cada evidência registra comandos executados e o hash do ambiente (bun medido dentro do runner, runner + limites, lockfile, árvore de dependências, versão do TypeScript). Ambiente diferente → STALE.
- **Trust**: telemetria bruta ≠ evidência. `Mission.evidence` declara a única fonte confiável de cada métrica e o instrumento (arquivos do organismo) de cada fonte; valores só se comparam com instrumento idêntico dos dois lados (senão `untrusted`); instrumentos ficam fora dos caminhos que candidates podem alterar.
- **Evidência vinculada** a baseline SHA e SHA avaliado do organismo, missão, envelope, ambiente de execução e identidade dos avaliadores. Se algo muda → **STALE** → reavaliar. A revisão do Habitat não faz parte do vínculo.
- **Vereditos**: INELIGIBLE · STALE · REGRESSED · TRADEOFF · NEUTRAL · PROXY_IMPROVED · EXPERIMENT_READY · OUTCOME_IMPROVED · MISSION_MET (vetor de métricas, sem score único; proxies melhores param em EXPERIMENT_READY).
- **Candidate Evidence** (Cockpit): intent, o que mudou (diff + linhas que os próprios instrumentos relatam diferentes), hipótese da missão, arquivos/componentes, blast radius, riscos, envelope HARD/SOFT, evidência proxy × outcome, proveniência e o porquê do veredito — tudo de dados gravados, cada item marcado EVIDÊNCIA / HEURÍSTICA / ALEGAÇÃO; alegações do MutationProvider num quadro separado que a decisão não usa. Componentes vêm de `Organism.components` (regras de caminho, heurística). A escada Proxy ≠ Outcome ≠ Missão mostra até onde a evidência chega.
- **Aceitar** é humano: fast-forward do `baselineRef` do organismo (merge `--ff-only` se estiver em checkout, senão `update-ref` com compare-and-swap). Sem push, sem deploy.
- **Propostas** (entrada de qualquer origem): `proposals/<organismo>/<id>/{proposal.json,change.patch}`.
- O sandbox compartilha o kernel do host (próximo passo: VM/gVisor). Em `trusted-local` os comandos rodam no host com os direitos do usuário: **não é fronteira de segurança**.
