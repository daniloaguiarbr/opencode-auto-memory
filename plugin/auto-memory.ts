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
- [ ] CANAL 1 COMPLETO: Salvei no MCP Serena via \`write_memory\` ou \`edit_memory\`
- [ ] CANAL 2 COMPLETO: Salvei no MEMORY.md do projeto via \`Edit\` ou \`Write\`
- [ ] AMBOS os canais contêm as mesmas informações essenciais
- [ ] Etapas concretas estão documentadas (JAMAIS apenas objetivos vagos)

### APÓS completar AMBOS os canais com sucesso, finalize sua resposta com a tag literal:
${PERSISTENCE_MARKER}

Essa tag sinaliza ao Memory Guardian que a persistência foi concluída e
encerra o ciclo para esta sessão.`

const COMPACTING_CONTEXT = `[opencode-auto-memory] Before compacting: make sure ALL learnings, code changes, executed plans, and decisions from this session have ALREADY been persisted via MCP Serena (\`write_memory\`) AND in the project-local MEMORY.md. Compaction loses information — dual-write now or never.`

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
