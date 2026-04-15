import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"

/**
 * opencode-auto-memory
 *
 * Auto-persistence hook for opencode. Ports the Claude Code
 * `memory-guardian.sh` pattern to opencode's plugin SDK.
 *
 * Forces dual-write of memory (MCP Serena + project-local MEMORY.md)
 * whenever the agent finishes a substantive response or the session is
 * about to be compacted.
 *
 * Triggers:
 *   1. `session.idle`: at end of each turn, if substantive work occurred,
 *      injects an obligatory dual-write prompt via client.session.send().
 *      Anti-loop: stops once the last message contains <memory-persisted/>.
 *   2. `experimental.session.compacting`: appends persistence reminder to
 *      the compaction prompt so information is saved before compression.
 *
 * Per-project state: `.opencode-auto-memory.state.json` (add to .gitignore).
 */

const STATE_FILE = ".opencode-auto-memory.state.json"
const PERSISTENCE_MARKER = "<memory-persisted/>"
const MIN_RESPONSE_CHARS = 1500
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
  "notebookedit",
])

interface AutoMemoryState {
  persistedSessions: Record<string, { messageID: string; at: string }>
}

function loadState(directory: string): AutoMemoryState {
  const path = join(directory, STATE_FILE)
  if (!existsSync(path)) return { persistedSessions: {} }
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return { persistedSessions: {} }
  }
}

function saveState(directory: string, state: AutoMemoryState): void {
  const path = join(directory, STATE_FILE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8")
}

const DUAL_WRITE_INSTRUCTIONS = `## REGRA ABSOLUTA — DUAL-WRITE OBRIGATÓRIO. NENHUMA EXCEÇÃO.

VOCÊ DEVE OBRIGATORIAMENTE persistir memória em AMBOS os canais ANTES de encerrar.
JAMAIS persista em apenas um. JAMAIS omita um canal. JAMAIS encerre sem completar AMBOS.

### CANAL 1 — MCP Serena (OBRIGATÓRIO)
- Se projeto Serena ativo: execute \`write_memory\` ou \`edit_memory\` com tópico/subtópico descritivo.
- Se Serena NÃO ativo: execute \`activate_project\` ANTES. JAMAIS pule por preguiça.
- Se Serena INDISPONÍVEL (erro técnico): REGISTRE EXPLICITAMENTE que não foi possível e POR QUÊ. JAMAIS omita silenciosamente.

### CANAL 2 — MEMORY.md local do projeto (OBRIGATÓRIO)
- Execute \`Edit\` no MEMORY.md do projeto. NENHUMA EXCEÇÃO.
- Se MEMORY.md não existe: execute \`Write\` para criá-lo. JAMAIS pule.

### PROIBIÇÕES — VIOLAÇÃO CRÍTICA IMEDIATA
- PROIBIDO persistir em apenas UM canal. Persistência parcial É FALHA CRÍTICA.
- PROIBIDO encerrar sessão sem completar AMBOS os canais. NENHUMA EXCEÇÃO.
- PROIBIDO omitir etapas executadas. Saber O QUE sem saber COMO é inútil.
- PROIBIDO resumir vagamente. SEJA ESPECÍFICO: arquivos, funções, comandos, resultados.
- PROIBIDO atualizar MEMORY.md e "esquecer" Serena. ESTA É A FALHA MAIS COMUM. JAMAIS repita.

---

### PROIBIÇÃO ABSOLUTA — DADOS SENSÍVEIS E SECRETS
Memória é PERSISTENTE, indexável e compartilhável entre sessões.
Qualquer secret escrito AQUI é vazado PARA SEMPRE. NENHUMA EXCEÇÃO.

PROIBIDO persistir QUALQUER item abaixo, em prosa, code block, JSON, YAML,
diff, log, transcript, trace, output de tool ou qualquer outro formato.
Se precisar registrar que um secret EXISTE, use placeholder genérico:
\`<REDACTED:tipo>\`, \`<TOKEN>\`, \`<PASSWORD>\`, \`<PRIVATE_KEY>\`.

#### Categoria A — Credenciais de nuvem
- Chaves AWS: \`AKIA...\`, \`ASIA...\`, \`aws_secret_access_key\`, tokens STS temporários
- GCP: service account JSON completo, chaves privadas P12, tokens OAuth de SA
- Azure: connection strings (\`DefaultEndpointsProtocol=...;AccountKey=...\`), SAS tokens
- DigitalOcean, Linode, Hetzner, Vultr: PATs e API tokens
- Cloudflare: API keys globais, tokens de DNS/Workers/R2

#### Categoria B — Tokens de API e plataformas
- GitHub PAT (\`ghp_...\`, \`github_pat_...\`), GitLab (\`glpat-...\`), Bitbucket app passwords
- OpenAI (\`sk-...\`), Anthropic (\`sk-ant-...\`), Context7 (\`ctx7sk-...\`), Gemini API keys
- Slack (\`xoxb-...\`, \`xoxp-...\`, \`xapp-...\`), webhook URLs com secret, Discord bot tokens
- Stripe (\`sk_live_...\`, \`rk_live_...\`), Twilio auth tokens, SendGrid API keys
- QUALQUER \`Authorization: Bearer ...\`, JWT completo (header.payload.signature)
- Webhooks com secret embutido na URL (\`hooks.slack.com/services/T.../B.../...\`)

#### Categoria C — Credenciais de banco e serviços
- Strings de conexão com senha inline: \`postgres://user:senha@host\`, \`mongodb+srv://user:senha@...\`, \`mysql://...\`, \`redis://:senha@...\`
- Senhas de DB em qualquer formato (Postgres, MySQL, MongoDB, Redis \`requirepass\`)
- Credenciais SMTP (Gmail App Password, SendGrid SMTP, AWS SES SMTP, Mailgun)
- URLs com basic-auth embutido: \`https://user:pass@host/path\`
- Credenciais de message broker (RabbitMQ user:pass, Kafka SASL)

#### Categoria D — PII e segredos pessoais
- CPF, RG, CNH, passaporte, cartão de crédito (PAN, CVV, validade, nome impresso)
- Chaves privadas: QUALQUER conteúdo entre \`-----BEGIN ... PRIVATE KEY-----\` e \`-----END ... PRIVATE KEY-----\`
- Conteúdo de \`~/.ssh/id_*\` (exceto arquivos \`.pub\`), \`~/.gnupg/\`, \`.env\`, \`.env.local\`, \`secrets.yaml\`, \`secrets.yml\`
- Arquivos \`~/.aws/credentials\`, \`~/.config/gcloud/\`, kubeconfig com tokens, \`~/.netrc\`
- 2FA seeds TOTP, OTP secrets, backup codes, recovery phrases (seed phrases) de carteiras crypto
- Endereços residenciais, números de telefone pessoais, dados médicos

#### Protocolo de redação quando o secret APARECEU na sessão
1. NUNCA copie o valor literal para Serena NEM para MEMORY.md
2. Se precisar registrar que o secret foi manipulado, descreva APENAS:
   - QUAL serviço/recurso ele protege (ex: "token do GitHub com scope \`repo\`")
   - ONDE ele vive (ex: "variável \`GH_TOKEN\` em \`~/.bashrc\` linha 42")
   - COMO foi usado (ex: "passado via env para \`gh pr create\`")
3. SUBSTITUA o valor por placeholder tipado: \`<REDACTED:github_pat>\`, \`<REDACTED:aws_access_key>\`, \`<REDACTED:db_password>\`
4. Se o secret já foi exposto em transcripts anteriores, ISSO NÃO AUTORIZA repetir. Trate CADA escrita como nova violação.

#### Heurística OBRIGATÓRIA de varredura antes de escrever
ANTES de chamar \`write_memory\`, \`edit_memory\`, \`Edit\` ou \`Write\` em MEMORY.md,
VARRA MENTALMENTE o payload. Se QUALQUER um destes sinais aparecer: REMOVA
e substitua por placeholder tipado.
- Strings de 20+ caracteres alfanuméricos sem espaço que parecem tokens opacos
- Prefixos conhecidos: \`sk-\`, \`sk-ant-\`, \`ghp_\`, \`github_pat_\`, \`glpat-\`, \`xox\`, \`AKIA\`, \`ASIA\`, \`ctx7sk-\`, \`sk_live_\`, \`rk_live_\`
- Base64 longos (40+ chars) sem contexto claro de ser hash público
- URLs contendo \`:senha@\`, \`?apikey=\`, \`?api_key=\`, \`&token=\`, \`&access_token=\`
- Blocos PEM (\`-----BEGIN\`) em QUALQUER variante
- Campos nomeados contendo valor: \`password\`, \`passwd\`, \`secret\`, \`api_key\`, \`apikey\`, \`token\`, \`auth\`, \`bearer\`, \`client_secret\`, \`private_key\`
- Conteúdo lido de \`.env*\`, \`~/.ssh/\`, \`~/.aws/\`, \`~/.gnupg/\`, \`~/.config/gcloud/\`, \`~/.netrc\`, \`credentials*\`

---

### CATEGORIA 1 — Planos e Tarefas Executadas
Se um plano foi criado E executado (total ou parcialmente), documente:
- **Objetivo**: QUAL era o problema ou necessidade
- **Etapas executadas**: liste CADA passo concreto realizado, na ordem:
  - Quais arquivos foram lidos como referência
  - Quais times/agents foram criados e com quais papéis
  - Quais tarefas foram delegadas e para quem
  - Quais arquivos foram criados, editados ou deletados
  - Quais comandos de validação foram executados e seus resultados
- **Padrão seguido**: se baseado em arquivo/código existente, QUAL e POR QUE
- **Resultado final**: sucesso, parcial ou falha — com evidência

### CATEGORIA 2 — Conhecimento Técnico Adquirido
Se você aprendeu, pesquisou ou aplicou algo técnico, documente O QUE aprendeu e COMO se aplica:
- Sobre linguagens, bibliotecas/crates, sistema operacional, hardware, erros/bugs, ferramentas

### CATEGORIA 3 — Código e Arquivos Modificados
Se qualquer arquivo foi criado, editado ou deletado, documente:
- QUAL arquivo, ONDE está, QUANTAS linhas, O QUE faz, QUAIS funções/structs alterados, QUAL padrão seguiu

### CATEGORIA 4 — Configurações e Infraestrutura
Se configurações foram aplicadas, testadas ou revertidas:
- QUAL configuração, ONDE aplicada, POR QUE, COMO, RESULTADO

---

### FORMATO OBRIGATÓRIO — MCP Serena (\`write_memory\`)
\`\`\`
## [Título descritivo]
- **Conhecimento**: [contexto técnico do subsistema envolvido]
- **Problema**: [o que precisava ser feito ou resolvido]
- **Etapas**: [lista numerada dos passos executados]
- **Solução**: [resultado final com detalhes úteis para futuras sessões]
\`\`\`

### FORMATO OBRIGATÓRIO — MEMORY.md
Resumo conciso incluindo etapas-chave, arquivos afetados e resultados de validação.

---

### CHECKLIST OBRIGATÓRIO — CONFIRME CADA ITEM ANTES DE ENCERRAR
PROIBIDO encerrar com QUALQUER item pendente. NENHUMA EXCEÇÃO.

- [ ] Revisei TODAS as 4 categorias acima
- [ ] Identifiquei TODO conteúdo relevante desta sessão
- [ ] VARREDURA DE SECRETS: apliquei a heurística da seção DADOS SENSÍVEIS em CADA payload
- [ ] Nenhum valor literal das Categorias A/B/C/D está presente em nenhum dos dois canais
- [ ] Qualquer secret necessário ao contexto foi substituído por placeholder tipado \`<REDACTED:tipo>\`
- [ ] CANAL 1 COMPLETO: Salvei no MCP Serena via \`write_memory\` ou \`edit_memory\`
- [ ] CANAL 2 COMPLETO: Salvei no MEMORY.md do projeto via \`Edit\` ou \`Write\`
- [ ] AMBOS os canais contêm as mesmas informações essenciais
- [ ] Etapas concretas estão documentadas (JAMAIS apenas objetivos vagos)

### APÓS completar AMBOS os canais com sucesso, finalize sua resposta com a tag literal:
${PERSISTENCE_MARKER}

Essa tag sinaliza ao Memory Guardian que a persistência foi concluída e
encerra o ciclo para esta sessão.`

const COMPACTING_CONTEXT = `[opencode-auto-memory] Before compacting: make sure ALL learnings, code changes, executed plans, and decisions from this session have ALREADY been persisted via MCP Serena (\`write_memory\`) AND in the project-local MEMORY.md. Compaction loses information — dual-write now or never.

[SECRETS REDACTION — MANDATORY] Before writing to Serena or MEMORY.md, SCAN the payload for credentials and PII (AWS/GCP/Azure keys, GitHub/OpenAI/Anthropic tokens, DB connection strings with inline passwords, PEM private keys, \`.env\` contents, CPF/credit card, OAuth bearers, JWTs). If ANY is found, REPLACE the literal value with a typed placeholder like \`<REDACTED:github_pat>\`, \`<REDACTED:aws_access_key>\`, \`<REDACTED:db_password>\`. Never persist raw secret values — memory is permanent and indexable. Previous exposure in transcripts does NOT authorize copying. When in doubt, redact.`

export const AutoMemoryPlugin: Plugin = async ({ directory, client }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const sessionID = (event as any).properties?.sessionID
      if (!sessionID) return

      let session: any
      try {
        session = await client.session.get({ id: sessionID })
      } catch {
        return
      }

      const messages: any[] = session?.messages ?? session?.data?.messages ?? []
      if (messages.length < 2) return

      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.info?.role === "assistant" || m.role === "assistant")
      if (!lastAssistant) return

      const info = lastAssistant.info ?? lastAssistant
      const parts: any[] = lastAssistant.parts ?? info.parts ?? []

      const textContent = parts
        .filter((p) => p?.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")

      const state = loadState(directory)

      if (textContent.includes(PERSISTENCE_MARKER)) {
        state.persistedSessions[sessionID] = {
          messageID: info.id ?? "",
          at: new Date().toISOString(),
        }
        saveState(directory, state)
        await client.app.log({
          service: "opencode-auto-memory",
          level: "info",
          message: `persistence confirmed for session ${sessionID}`,
        })
        return
      }

      const already = state.persistedSessions[sessionID]
      if (already && already.messageID === (info.id ?? "")) return

      const allParts: any[] = messages.flatMap(
        (m) => m.parts ?? m.info?.parts ?? []
      )
      const hasWrites = allParts.some(
        (p) =>
          p?.type === "tool" &&
          typeof p.tool === "string" &&
          WRITE_TOOLS.has(p.tool.toLowerCase())
      )

      if (!hasWrites && textContent.length < MIN_RESPONSE_CHARS) return

      await client.app.log({
        service: "memory-guardian",
        level: "info",
        message: `injecting dual-write prompt in session ${sessionID} (hasWrites=${hasWrites}, chars=${textContent.length})`,
      })

      try {
        await client.session.send({
          id: sessionID,
          text: DUAL_WRITE_INSTRUCTIONS,
        })
      } catch (err) {
        await client.app.log({
          service: "opencode-auto-memory",
          level: "error",
          message: `failed to inject dual-write prompt: ${err}`,
        })
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(COMPACTING_CONTEXT)
    },
  }
}
