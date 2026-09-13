// Servidor MCP standalone de Amatista -- LSP, alcance reducido de la
// implementacion completa de Fase 1 (docs/_arch/verify_mcp_server.md,
// verify_mcp_approval.md): SOLO find_definition/find_references/
// list_symbols/get_diagnostics, SIN aprobacion (las 4 son de solo lectura,
// confirmado en sus propias descriptions de tool-registry.ts).
//
// Spawneado por claude-cli/codex/agy como SU PROPIO proceso hijo, via la
// config MCP efimera armada en cli-agent-runtime.ts para CADA turno -- corre
// AFUERA de Electron, un proceso `node` (o el execPath de Electron con
// ELECTRON_RUN_AS_NODE, mismo patron real ya usado por geminiCommand()) por
// turno, mismo espiritu que sendClaude()/sendAntigravity() ya spawnean un
// proceso nuevo por turno.
//
// Reusa LspManager (lsp-manager.ts) TAL CUAL -- la misma clase ya construida
// y probada para los 4 runtimes API, instanciada aca scopeada al workspace
// real de ESE panel (leido por ENV, mismo patron que AMATISTA_STORAGE_ROOT/
// AMATISTA_PANEL_ID). Las 4 descriptions de tool son las MISMAS ya
// mejoradas de tool-registry.ts (competian activamente contra grep en el
// benchmark, ver docs/_arch/CONTRACT.md) -- reusadas literal, mas una frase
// extra por tool apostando (no garantizando, el propio benchmark confirmo
// que ni mejorar description ni sacar alternativas garantiza uso) a que un
// CLI headless las prefiera.
//
// Bundleado con esbuild a un .cjs standalone (out/main/mcp-lsp-server.cjs,
// ver package.json script "mcp:lsp:bundle") -- @modelcontextprotocol/sdk +
// zod quedan INLINEADOS en el bundle, node_modules no necesita existir en
// runtime para este archivo (a diferencia de typescript-language-server/
// pyright, que SI necesitan asarUnpack por ser binarios/CLIs reales que se
// spawnean aparte -- ver DISEÑO, confirmado que este caso es JS puro sin
// esa friccion).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { LspManager } from './lsp-manager'
import { languageServerConfigFor } from './lsp-client'

const workspaceRaw = process.env.AMATISTA_MCP_WORKSPACE?.trim()
if (!workspaceRaw) {
  process.stderr.write('[amatista-lsp-mcp] AMATISTA_MCP_WORKSPACE no esta seteada -- no se puede arrancar.\n')
  process.exit(1)
}
// path.resolve() normaliza separadores (\ vs /) -- el valor crudo de ENV no
// tiene garantia de venir ya normalizado (quien lo arma podria mezclar
// estilos), y resolveWithinWorkspace() de abajo compara contra ESTE valor
// via startsWith() -- sin normalizar aca, un mismatch de separador entre
// `workspace` y lo que path.resolve() devuelve mas abajo tira falsos
// "fuera del workspace" con paths que en realidad son el mismo real.
const workspace = path.resolve(workspaceRaw)

const MAX_OUTPUT_CHARS = 20_000
function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[salida recortada]` : text
}

/** Misma logica que resolveWithinWorkspace() (tool-registry.ts) -- duplicada
 *  a proposito, no importada: tool-registry.ts arrastra un arbol de imports
 *  ajeno a LSP (VCS, generacion de imagenes, lectura de documentos con
 *  dependencias nativas -- pdfjs-dist/officeparser/@napi-rs/canvas) que no
 *  vale la pena tironear a este bundle standalone por 2 funciones chicas. */
function resolveWithinWorkspace(relativePath: string): string {
  const clean = (relativePath || '.').trim() || '.'
  const resolved = path.resolve(workspace!, clean)
  const workspaceWithSep = workspace!.endsWith(path.sep) ? workspace! : workspace! + path.sep
  if (resolved !== workspace && !resolved.startsWith(workspaceWithSep)) {
    throw new Error(`Ruta fuera del workspace activo: ${relativePath}`)
  }
  return resolved
}

function relForDisplay(absolutePath: string): string {
  return path.relative(workspace!, absolutePath) || absolutePath
}

// Mismos labels reales del protocolo LSP (SymbolKind) ya usados en
// tool-registry.ts -- duplicados a proposito, mismo motivo que
// resolveWithinWorkspace() de arriba.
const LSP_SYMBOL_KIND_LABELS: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method',
  7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface',
  12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String', 16: 'Number',
  17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key', 21: 'Null',
  22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter'
}

const lspManager = new LspManager(workspace)

function textResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text }], isError }
}

const server = new McpServer({ name: 'amatista-lsp', version: '1.0.0' })

server.tool(
  'get_diagnostics',
  'Devuelve errores y warnings REALES (compilador/analizador de tipos, no lint) para archivos .ts/.tsx ' +
    '(TypeScript), .py (Python, via pyright), .rs (Rust, via rust-analyzer) o .go (Go, via gopls) ya escritos o ' +
    'editados en esta sesion con write_file/apply_patch — usa esto para confirmar que una edicion no rompio el ' +
    'tipado antes de darla por terminada, en vez de asumir que compilo bien. Cada lenguaje tiene su propio ' +
    'analizador corriendo en paralelo -- pedir diagnosticos de un .py nunca afecta ni depende de los .ts/.tsx, ' +
    '.rs o .go tocados, y viceversa. rust-analyzer/gopls son binarios EXTERNOS que el usuario instala aparte (a ' +
    'diferencia de TypeScript/Python, que vienen incluidos) -- si no estan instalados, o si arrancaron pero no ' +
    'pudieron analizar nada (ej. gopls sin el compilador `go` disponible), la respuesta lo dice explicito con el ' +
    'motivo real, en vez de fallar en silencio o mostrar "sin errores" cuando en realidad no se analizo nada. ' +
    'Sin "path", devuelve los diagnosticos de TODOS los archivos tocados en la sesion (de cualquier lenguaje ' +
    'soportado). Con "path", solo ese archivo. Si el archivo indicado (o ninguno todavia) fue tocado con ' +
    'write_file/apply_patch, no hay diagnosticos disponibles — esta tool NO analiza archivos que no pasaron por ' +
    'esas dos tools en esta sesion. La respuesta puede venir marcada como "no confirmado como la version mas ' +
    'reciente" si el analisis todavia esta en curso (espera acotada corta, nunca cuelga el turno) — en ese caso, ' +
    'repetir la consulta mas tarde si hace falta certeza total. Solo lectura, sin aprobacion.' +
    ' NOTA de este servidor MCP: no expone write_file/apply_patch, asi que "sin path" SIEMPRE devuelve "sin ' +
    'diagnosticos disponibles" aca -- a diferencia de la version completa de ToolRegistry, esta variante NUNCA ' +
    'suma los archivos abiertos por find_definition/find_references/list_symbols (esos los abre solo para ' +
    'navegar, no cuentan como "tocados" para esta tool). Para chequear un archivo real, pasa SIEMPRE "path" -- ' +
    'ahi si funciona sobre un archivo ya consultado antes con find_definition/find_references/list_symbols(path) ' +
    'en este mismo turno, sin necesidad de haberlo editado.',
  {
    path: z.string().optional().describe('Ruta relativa al workspace de un archivo puntual. Vacio = todos los archivos tocados en la sesion (cualquier lenguaje soportado).')
  },
  async ({ path: relPathArg }) => {
    const target = relPathArg?.trim() ? resolveWithinWorkspace(relPathArg.trim()) : undefined
    const results = await lspManager.getDiagnostics(target)

    if (results.length === 0) {
      const failure = target ? lspManager.startupFailureFor(target) : undefined
      if (failure) return textResult(failure)
      return textResult(
        relPathArg?.trim()
          ? `${relPathArg.trim()} no fue consultado todavia en este turno — sin diagnosticos disponibles.`
          : 'Ningun archivo de un lenguaje soportado (.ts/.tsx, .py, .rs, .go) fue consultado todavia en este turno — sin diagnosticos disponibles.'
      )
    }

    const lines: string[] = []
    for (const result of results) {
      const rel = relForDisplay(result.path)
      const staleNote = result.stale ? ' (no confirmado como la version mas reciente — el analisis podria seguir en curso)' : ''
      const realDiagnostics = result.diagnostics.filter(d => d.source !== 'go list')
      if (realDiagnostics.length === 0) {
        const operationalError = lspManager.operationalErrorFor(result.path)
        if (operationalError) {
          lines.push(`${rel}: no se pudo analizar -- ${operationalError}`)
          continue
        }
        lines.push(`${rel}: sin errores ni warnings${staleNote}`)
        continue
      }
      lines.push(`${rel}${staleNote}:`)
      for (const diagnostic of realDiagnostics) {
        const severityLabel =
          diagnostic.severity === 1 ? 'error'
            : diagnostic.severity === 2 ? 'warning'
              : diagnostic.severity === 3 ? 'info'
                : 'hint'
        const isTypeScript = languageServerConfigFor(result.path)?.languageId === 'typescript'
        const codeLabel = diagnostic.code !== undefined ? (isTypeScript ? ` TS${diagnostic.code}` : ` ${diagnostic.code}`) : ''
        lines.push(`  ${severityLabel} [${diagnostic.line}:${diagnostic.column}]${codeLabel}: ${diagnostic.message}`)
      }
    }
    return textResult(clip(lines.join('\n')))
  }
)

function validatePosition(line: number, column: number): string | null {
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) {
    return '"line" y "column" deben ser numeros enteros 1-indexados (>= 1).'
  }
  return null
}

server.tool(
  'find_definition',
  'Va a la definicion REAL (exacta, resuelta por el compilador/type-checker) de lo que hay en una posicion ' +
    'puntual de un archivo .ts/.tsx, .py, .rs o .go. Usa esto en vez de buscar el nombre del identificador con ' +
    'search_files: buscar por texto puede traerte una declaracion con el mismo nombre en OTRO archivo/clase/scope ' +
    '(dos funciones distintas llamadas igual), o no encontrar nada si el identificador llego via un import ' +
    'renombrado (import {X as Y}) -- esta tool resuelve la referencia real del lenguaje, sin ese riesgo de ' +
    'confusion ni de coincidencia perdida. Mismo language server real que get_diagnostics (TypeScript/pyright/' +
    'rust-analyzer/gopls), via "ir a la definicion" del protocolo LSP estandar (lo mismo que Ctrl+Click en un ' +
    'editor). A diferencia de get_diagnostics, SI funciona sobre archivos que todavia no fueron tocados con ' +
    'write_file/apply_patch en esta sesion -- los abre bajo demanda para poder consultarlos. Necesita una ' +
    'posicion EXACTA (linea y columna 1-indexadas, igual que se muestran en get_diagnostics/en un editor) sobre ' +
    'el identificador del que se quiere la definicion -- no busca por nombre de simbolo (para eso esta ' +
    'list_symbols). Devuelve la ruta real del archivo (puede ser otro distinto al consultado) y la posicion real ' +
    'de la definicion, o "sin resultados" si el servidor no encontro ninguna (una respuesta valida, no un ' +
    'error). Solo lectura, sin aprobacion.' +
    ' NOTA de este servidor MCP: este language server real ya esta corriendo para este workspace -- preferila ' +
    'sobre adivinar o leer el archivo entero para encontrar una definicion.',
  {
    path: z.string().describe('Ruta relativa al workspace del archivo desde donde se pregunta.'),
    line: z.number().describe('Numero de linea 1-indexado (igual que en get_diagnostics/un editor).'),
    column: z.number().describe('Numero de columna 1-indexada, sobre el identificador puntual.')
  },
  async ({ path: relPathArg, line, column }) => {
    const invalid = validatePosition(line, column)
    if (invalid) return textResult(invalid, true)
    const target = resolveWithinWorkspace(relPathArg.trim())
    if (!existsSync(target) || !statSync(target).isFile()) return textResult(`Archivo no encontrado: ${relPathArg}`, true)

    const result = await lspManager.findDefinition(target, line, column)
    if (result.reason) return textResult(result.reason)
    if (result.locations.length === 0) return textResult('Sin resultados: el servidor no encontro ninguna definicion para esa posicion.')
    const lines = result.locations.map(loc => `${relForDisplay(loc.path)}:${loc.line}:${loc.column}`)
    return textResult(clip(lines.join('\n')))
  }
)

server.tool(
  'find_references',
  'Antes de renombrar o eliminar algo, usa esto -- no search_files -- para confirmar TODOS los lugares reales ' +
    'donde se usa. Un grep por nombre puede confundir el identificador con otro igual en un contexto distinto ' +
    '(una variable local llamada igual que un metodo de clase, dos funciones con el mismo nombre en archivos ' +
    'distintos) y traerte resultados que no son usos reales, o dejar afuera un uso real si el identificador llego ' +
    'via un import renombrado -- esta tool resuelve las referencias reales del lenguaje, sin ese riesgo. Busca ' +
    'TODOS los usos reales de lo que hay en una posicion exacta de un archivo .ts/.tsx, .py, .rs o .go -- mismo ' +
    'mecanismo/servidores que find_definition ("buscar todas las referencias" del protocolo LSP estandar). ' +
    'Tambien abre archivos bajo demanda si hace falta, mismo criterio que find_definition. Solo lectura, sin ' +
    'aprobacion.' +
    ' NOTA de este servidor MCP: mismo language server real ya corriendo para este workspace que find_definition ' +
    '-- preferila sobre un grep por nombre cuando la pregunta es "donde se usa esto de verdad".',
  {
    path: z.string().describe('Ruta relativa al workspace del archivo desde donde se pregunta.'),
    line: z.number().describe('Numero de linea 1-indexado.'),
    column: z.number().describe('Numero de columna 1-indexada, sobre el identificador puntual.'),
    include_declaration: z.boolean().optional().describe('Si incluir la declaracion misma junto con los usos. Default true.')
  },
  async ({ path: relPathArg, line, column, include_declaration }) => {
    const invalid = validatePosition(line, column)
    if (invalid) return textResult(invalid, true)
    const target = resolveWithinWorkspace(relPathArg.trim())
    if (!existsSync(target) || !statSync(target).isFile()) return textResult(`Archivo no encontrado: ${relPathArg}`, true)

    const result = await lspManager.findReferences(target, line, column, include_declaration !== false)
    if (result.reason) return textResult(result.reason)
    if (result.locations.length === 0) return textResult('Sin resultados: el servidor no encontro ninguna referencia para esa posicion.')
    const lines = result.locations.map(loc => `${relForDisplay(loc.path)}:${loc.line}:${loc.column}`)
    return textResult(clip(lines.join('\n')))
  }
)

server.tool(
  'list_symbols',
  'Lista simbolos reales (funciones, clases, variables, etc.) via el language server real -- mas preciso que ' +
    'leer el archivo entero con read_file o gregear nombres con search_files para entender su estructura. DOS ' +
    'formas excluyentes, pasa exactamente una: con "path", los simbolos de ESE archivo puntual (funciona sobre ' +
    'archivos no tocados todavia en la sesion, los abre bajo demanda) -- usa esta forma, no "query", para la ' +
    'primera exploracion de un archivo nuevo: es la unica que siempre funciona, sin depender de que ya se haya ' +
    'tocado algo antes en ese lenguaje. Con "query", busca por NOMBRE en TODO el workspace -- el mas simple de ' +
    'usar (no necesita archivo ni posicion), pero con una limitacion real: solo encuentra simbolos de lenguajes ' +
    'cuyo language server ya arranco en esta sesion (por un find_definition/find_references/get_diagnostics/ ' +
    'list_symbols con "path" previo sobre un archivo de ese lenguaje) -- si "query" no encuentra algo que ' +
    'deberia existir, no es necesariamente que no exista: puede ser que el LSP de ese lenguaje todavia no ' +
    'arranco, no que el simbolo no este. Solo lectura, sin aprobacion.' +
    ' NOTA de este servidor MCP: usa "path" primero sobre un archivo real de este workspace para arrancar su ' +
    'language server antes de confiar en "query" -- si "query" viene vacio, puede ser solo que nada arranco ' +
    'todavia, no que el simbolo no exista.',
  {
    path: z.string().optional().describe('Ruta relativa al workspace de un archivo puntual. Excluyente con "query".'),
    query: z.string().optional().describe('Nombre (o fragmento) de simbolo a buscar en todo el workspace. Excluyente con "path".')
  },
  async ({ path: relPathArg, query }) => {
    const relPath = relPathArg?.trim() ?? ''
    const q = query?.trim() ?? ''
    if (relPath && q) return textResult('"path" y "query" son excluyentes -- pasa uno u otro, no los dos.', true)
    if (!relPath && !q) return textResult('Hace falta "path" (simbolos de un archivo) o "query" (busqueda por nombre en el workspace).', true)

    const result = relPath
      ? await (async () => {
          const target = resolveWithinWorkspace(relPath)
          if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Archivo no encontrado: ${relPath}`)
          return lspManager.listSymbolsInFile(target)
        })().catch(error => { throw error })
      : await lspManager.searchSymbols(q)

    if (result.reason) return textResult(result.reason)
    if (result.symbols.length === 0) {
      const scopeNote = result.queriedLanguages
        ? (result.queriedLanguages.length
            ? ` (lenguajes consultados: ${result.queriedLanguages.join(', ')})`
            : ' (ningun language server esta corriendo todavia en esta sesion -- tocar un archivo primero, o usar "path" en vez de "query")')
        : ''
      return textResult(`Sin resultados${scopeNote}.`)
    }
    const lines = result.symbols.map(sym => {
      const kindLabel = LSP_SYMBOL_KIND_LABELS[sym.kind] ?? `kind ${sym.kind}`
      const location = sym.path ? `${relForDisplay(sym.path)}:${sym.line}:${sym.column}` : `${sym.line}:${sym.column}`
      return `${kindLabel} ${sym.name} — ${location}`
    })
    return textResult(clip(lines.join('\n')))
  }
)

// Orquestacion por suscripcion (docs/_arch/verify_subscription_orchestrator_design.md):
// send_to_window/parallel_ask expuestas por el MISMO servidor MCP que ya
// existe para LSP -- reusa el canal ya probado (mcp-approval-pipe.ts), no
// inventa uno nuevo. SOLO se registran si este proceso arranco con
// AMATISTA_PANEL_ID (el panel real de origen, mismo patron ENV que
// AMATISTA_MCP_WORKSPACE) Y AMATISTA_IS_PRINCIPAL==='1' (decidido por
// cli-agent-runtime.ts ANTES del spawn, con isPrincipalChat() calculado del
// lado de main en agent:connect) -- primera linea de defensa, la tool ni
// siquiera existe para un panel no-principal. La UNICA autoridad real es el
// gate que mcp-approval-pipe.ts vuelve a verificar el mismo por cada
// mensaje (nunca confia en que este proceso no mienta) -- ver el comentario
// completo alla.
//
// Este archivo NUNCA importa nada de main (sessionRegistry/chat-store/
// parallel-orchestrator no son alcanzables desde aca, y no deberian serlo:
// bajo ELECTRON_RUN_AS_NODE, 'electron' no es el modulo real de Electron,
// cualquier import transitivo de codigo que toque BrowserWindow/app
// rompería en este proceso) -- toda la logica real vive del otro lado del
// pipe. Este proceso solo arma requests NDJSON, los manda, y traduce la
// respuesta a texto para el modelo.
const panelId = process.env.AMATISTA_PANEL_ID?.trim()
const isPrincipalPanel = process.env.AMATISTA_IS_PRINCIPAL === '1'

/** Mismo valor real que MCP_APPROVAL_PIPE_PATH (mcp-approval-pipe.ts) --
 *  duplicado a proposito, no importado: ese archivo importa chat-store.ts/
 *  runtime-state.ts (Electron main real), exactamente el tipo de import
 *  transitivo peligroso que el comentario de arriba explica. Es un string
 *  constante, cero riesgo de que la duplicacion se desincronice en la
 *  practica (cambiar la ruta del pipe implica tocar los 2 archivos a
 *  proposito, no es un valor que varie en runtime). */
const MCP_APPROVAL_PIPE_PATH =
  process.platform === 'win32' ? '\\\\.\\pipe\\amatista-mcp-approval' : '/tmp/amatista-mcp-approval.sock'

/** Una conexion por request, una linea en cada direccion -- mismo framing
 *  exacto que mcp-approval-pipe.ts implementa del otro lado. Sin reintentos
 *  ni timeout propio: si main no responde (proceso principal caido, named
 *  pipe no arranco), la Promise nunca resuelve y el tool call del CLI queda
 *  colgado hasta que el propio binario claude/agy lo corte por su --max-turns/
 *  timeout real -- mismo riesgo que ya acepta requestSessionToolApproval()
 *  para el camino de aprobacion original (bloqueo sin polling, ninguna otra
 *  pieza de este codebase le pone timeout tampoco).
 */
function callApprovalPipe<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(MCP_APPROVAL_PIPE_PATH)
    let buffer = ''
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) return
      const line = buffer.slice(0, newlineIndex)
      socket.end()
      try {
        resolve(JSON.parse(line) as T)
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', reject)
  })
}

interface ConfirmResponse { approved: boolean; error?: string }
interface SendToWindowResponse { ok: boolean; text?: string; error?: string }
interface ParallelPlanAssignment {
  subtask: string
  panelId: string
  panelLabel: string
  providerId: string
  modelId: string
  modelLabel: string
  approvedChatId: string
  approvedWorkspace: string | null
}
interface PlanParallelAskResponse { ok: boolean; assignments?: ParallelPlanAssignment[]; error?: string }
interface ParallelAskOutcomeShape { subtask: string; panelLabel: string; modelLabel: string; ok: boolean; text?: string; error?: string }
interface RunParallelAskResponse { ok: boolean; outcomes?: ParallelAskOutcomeShape[]; error?: string }

if (panelId && isPrincipalPanel) {
  server.tool(
    'send_to_window',
    // Descripcion reusada literal de tool-registry.ts (mismo texto que ve
    // un runtime API) -- mas una nota real de este servidor MCP, mismo
    // patron que las 4 tools de LSP de arriba.
    'Manda un mensaje a OTRO chat de AMATISTA (identificado por su titulo tal como aparece en el panel ' +
      'lateral, NO un id tecnico) y corre un turno real ahi -- si ese chat esta abierto en otra ventana lo usa, ' +
      'si no hay ninguna ventana mostrandolo se abre una nueva automaticamente. El resultado vuelve a ESTE chat ' +
      'como un mensaje del asistente marcado visualmente como recibido de otra ventana. Requiere SIEMPRE ' +
      'aprobacion explicita del usuario (sin excepcion, sin importar el modo de sandbox activo) -- el dialogo ' +
      'muestra el destino y el mensaje completo antes de mandarlo. El chat destino tiene que haber tenido YA AL ' +
      'MENOS UN turno real antes (asi se sabe con que modelo/proveedor conectarlo si hace falta auto-conectarlo) ' +
      '-- si nunca se uso, esta tool devuelve un error claro en vez de adivinar con que conectarlo: pedile al ' +
      'usuario que lo abra y lo conecte el mismo primero.' +
      ' NOTA de este servidor MCP: solo disponible si este chat es el "principal" de su grupo de paneles -- un ' +
      'panel secundario (titulo con sufijo "— Panel N") nunca ve esta tool.',
    {
      destino: z.string().describe(
        'Titulo EXACTO del chat destino, tal como aparece en el panel lateral de AMATISTA -- o el alias corto ' +
          '("Panel 2", "2", "principal", "1") si el destino es del mismo workspace.'
      ),
      mensaje: z.string().describe('Texto completo del mensaje/pedido a mandarle a ese chat.')
    },
    async ({ destino, mensaje }) => {
      const d = destino.trim()
      const m = mensaje.trim()
      if (!d || !m) return textResult('Faltan "destino" y/o "mensaje".', true)

      const confirmResult = await callApprovalPipe<ConfirmResponse>({
        panelId,
        action: 'confirm',
        toolName: 'send_to_window',
        title: `Enviar mensaje a "${d}"`,
        detail: m
      })
      if (!confirmResult.approved) {
        return textResult(confirmResult.error ?? 'El usuario rechazo el envio del mensaje a otra ventana.')
      }

      const result = await callApprovalPipe<SendToWindowResponse>({ panelId, action: 'sendToWindow', destino: d, mensaje: m })
      return result.ok
        ? textResult(`Mensaje entregado a "${d}". Respuesta:\n${result.text}`)
        : textResult(result.error ?? 'Fallo desconocido enviando el mensaje.', true)
    }
  )

  server.tool(
    'parallel_ask',
    // Mismo criterio que send_to_window de arriba -- descripcion reusada
    // literal de tool-registry.ts.
    'Reparte N sub-tareas INDEPENDIENTES entre otros paneles de AMATISTA ya conectados e inactivos ahora mismo, ' +
      'las corre EN PARALELO real (Amatista decide a que panel/modelo va cada una segun disponibilidad -- vos NO ' +
      'elegis destino, a diferencia de send_to_window), y te devuelve UN UNICO resultado agregado con la respuesta ' +
      'de cada sub-tarea etiquetada por el panel/modelo real que la resolvio. Pensada para sub-tareas que NO se ' +
      'pisen entre si (ej. investigar temas distintos, no editar el mismo archivo a la vez) -- si 2 sub-tareas ' +
      'tocan el mismo archivo, la proteccion existente contra escrituras concurrentes puede hacer que una de las ' +
      'dos falle limpio con un error explicito, sin corromper nada. Si hay mas sub-tareas que paneles disponibles, ' +
      'un mismo panel toma varias en SECUENCIA (nunca 2 turnos a la vez en el mismo panel). No auto-abre paneles ' +
      'nuevos -- si no hay ningun panel conectado e inactivo, esta tool devuelve un error claro en vez de intentar ' +
      'abrir uno. Requiere SIEMPRE aprobacion explicita del usuario (gasta una llamada real por cada sub-tarea, N ' +
      'veces) -- el dialogo muestra cada sub-tarea junto con el panel/modelo real que se le va a asignar, ANTES de ' +
      'disparar nada. Una sub-tarea que falla o no responde NUNCA aborta a las demas -- el resultado agregado ' +
      'marca cual fallo y por que, las que funcionaron se devuelven igual.' +
      ' NOTA de este servidor MCP: solo disponible si este chat es el "principal" de su grupo de paneles, mismo ' +
      'criterio que send_to_window. Cancelar este turno desde Amatista NO cancela sub-tareas ya despachadas a ' +
      'otros paneles (limitacion real de este puente, ver PENDING.md).',
    {
      subtasks: z
        .array(z.string())
        .describe('Lista de sub-tareas independientes entre si, una por elemento -- texto completo de cada una (no un resumen ni un titulo).')
    },
    async ({ subtasks }) => {
      const clean = subtasks.map(s => s.trim()).filter(Boolean)
      if (clean.length === 0) return textResult('Falta "subtasks" (lista de sub-tareas, al menos una).', true)

      const plan = await callApprovalPipe<PlanParallelAskResponse>({ panelId, action: 'planParallelAsk', subtasks: clean })
      if (!plan.ok || !plan.assignments) return textResult(plan.error ?? 'No se pudo planificar el reparto.', true)

      // Mismo formato real que formatParallelPlanDetail() (tool-registry.ts)
      // -- duplicado a proposito, mismo motivo de siempre en este archivo.
      const detail = plan.assignments.map((a, i) => `${i + 1}. [${a.panelLabel} -- ${a.modelLabel}] ${a.subtask}`).join('\n\n')
      const panelCount = new Set(plan.assignments.map(a => a.panelId)).size

      const confirmResult = await callApprovalPipe<ConfirmResponse>({
        panelId,
        action: 'confirm',
        toolName: 'parallel_ask',
        title: `Repartir ${clean.length} sub-tarea(s) en paralelo entre ${panelCount} panel(es)`,
        detail
      })
      if (!confirmResult.approved) {
        return textResult(confirmResult.error ?? 'El usuario rechazo repartir las sub-tareas en paralelo.')
      }

      const run = await callApprovalPipe<RunParallelAskResponse>({ panelId, action: 'runParallelAsk', assignments: plan.assignments })
      if (!run.ok || !run.outcomes) return textResult(run.error ?? 'Fallo desconocido repartiendo las sub-tareas.', true)

      // Mismo formato real que formatParallelAskOutput() (tool-registry.ts).
      const blocks = run.outcomes.map((outcome, index) => {
        const header = outcome.ok
          ? `## Sub-tarea ${index + 1} -- resuelta por ${outcome.panelLabel} (${outcome.modelLabel})`
          : `## Sub-tarea ${index + 1} -- FALLO (${outcome.panelLabel} -- ${outcome.modelLabel})`
        const body = outcome.ok ? (outcome.text ?? '') : (outcome.error ?? 'Error desconocido.')
        return `${header}\n${body}`
      })
      return textResult(`Resultados de ${run.outcomes.length} sub-tarea(s) en paralelo:\n\n${blocks.join('\n\n')}`)
    }
  )
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(error => {
  process.stderr.write(`[amatista-lsp-mcp] fallo fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})

// Cierre limpio de los language servers reales al morir este proceso --
// mismo principio que disconnectAgent() (runtime-state.ts) llama
// lspManager.stopAll() al desconectar una sesion real.
process.on('exit', () => lspManager.stopAll())
