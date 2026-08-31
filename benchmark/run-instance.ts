// Fase 2 del benchmark (docs/_arch/verify_benchmark_harness.md): harness
// real para UNA instancia de SWE-Bench ProMax -- clona el repo real al
// base_commit real, corre un turno real contra Foundry con el
// problem_statement real (sin modificarlo ni agregarle contexto que un uso
// real no tendria), extrae el patch final via `git diff` externo (corrido
// por este harness, no por el agente -- Tarea 3 de verify_benchmark_harness.md
// confirmo que alcanza), y guarda resultado + telemetria en JSON.
//
// Alcance explicito de Fase 2: termina en "el agente produjo un patch, con
// su telemetria real". NO evalua si el patch resuelve el bug -- eso es
// Fase 3 (evaluacion en Docker vs. los tests reales de la instancia),
// deliberadamente no implementada todavia.
//
// Standalone, mismo patron que todos los scripts de verificacion de esta
// sesion: se bundlea con esbuild (`npm run bench:bundle`) y se corre con
// `node` puro. NO se ejecuta este archivo directo -- lo requiere
// benchmark/run-instance-wrapper.cjs, que fija AMATISTA_STORAGE_ROOT en
// process.env ANTES de requerir el bundle (necesario porque app-paths.ts lee
// esa env var UNA SOLA VEZ al cargar el modulo; un `import` estatico de
// ApiAgentRuntime/ToolRegistry en la cabecera de ESTE archivo se resuelve
// antes de que cualquier codigo de este archivo pueda correr, asi que fijar
// la env var aca adentro llegaria tarde).
//
// Variables de entorno esperadas (todas seteadas por el wrapper, nunca un
// literal hardcodeado -- mismo criterio de seguridad usado en toda la sesion
// para las API keys reales):
//   BENCH_TASK_PATH        -- ruta absoluta al task.json de la instancia
//   BENCH_RUN_DIR           -- carpeta aislada de esta corrida (clone +
//                              amatista-data + result.json, nunca compartida
//                              entre tareas ni con D:\AMATISTA\data real)
//   BENCH_AZURE_KEY         -- API key real de Azure (Foundry o Anthropic via
//                              Azure, mismo recurso, ambas rutas verificadas
//                              en Fase 1) -- requerida solo si
//                              BENCH_PROVIDER_KIND es 'foundry'/'anthropic-api'
//   BENCH_OPENAI_KEY        -- API key real de OpenAI DIRECTO (api.openai.com,
//                              sin Azure de por medio) -- requerida solo si
//                              BENCH_PROVIDER_KIND es 'openai-chat'
//   BENCH_PROVIDER_KIND     -- opcional, 'foundry' (default), 'anthropic-api',
//                              o 'openai-chat' -- ver comentario junto a
//                              `providerKind` mas abajo
//   BENCH_ENDPOINT          -- opcional, default el endpoint real segun
//                              BENCH_PROVIDER_KIND (foundry/anthropic-api ya
//                              verificados en Fase 1,
//                              docs/_arch/verify_benchmark_instrumentation.md;
//                              openai-chat default https://api.openai.com/v1)
//   BENCH_MODEL             -- default 'gpt-5.5' (foundry) o 'claude-opus-4-8'
//                              (anthropic-api) -- OBLIGATORIA para openai-chat,
//                              sin default: el modelo real disponible se
//                              confirma antes de cada corrida (ver mas abajo)
//   AMATISTA_MAX_TOOL_LOOP  -- opcional; si no esta seteada, este harness la
//                              fija en 150 (Tarea 2 de verify_benchmark_harness.md:
//                              60, el default de uso conversacional normal,
//                              puede quedarse corto para un refactor real
//                              multi-archivo de ProMax) -- solo para ESTE
//                              proceso, el default de la app instalada
//                              (60) no cambia.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ApiAgentRuntime } from '../src/main/api-agent-runtime'
import { ToolRegistry } from '../src/main/tool-registry'

const execFileAsync = promisify(execFile)

interface TaskSpec {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
}

interface RunResult {
  instance_id: string
  repo: string
  base_commit: string
  model: string
  startedAt: string
  latencyMs: number
  /** Exito/fracaso de la LLAMADA en si (el turno resolvio sin excepcion) --
   *  NO si el patch resuelve el bug, eso es Fase 3. Paso 10: MAX_TOOL_LOOP
   *  agotado cae en el catch de abajo, callSucceeded queda false -- nunca
   *  un "exito" silencioso parcial. */
  callSucceeded: boolean
  errorMessage?: string
  usage?: unknown
  toolCallLog: Record<string, number>
  patch: string
  patchIsEmpty: boolean
}

async function runGitPlain(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 })
  return stdout
}

async function main(): Promise<void> {
  const taskPath = process.env.BENCH_TASK_PATH
  const runDir = process.env.BENCH_RUN_DIR
  if (!taskPath || !runDir) {
    console.error('Falta BENCH_TASK_PATH/BENCH_RUN_DIR -- correr via run-instance-wrapper.cjs, no directo.')
    process.exit(1)
  }

  const task: TaskSpec = JSON.parse(readFileSync(taskPath, 'utf8'))
  const workspace = path.join(runDir, 'workspace')
  mkdirSync(runDir, { recursive: true })

  // BENCH_AZURE_KEY (foundry/anthropic-api, ambos via Azure, Fase 2 original)
  // o BENCH_OPENAI_KEY (openai-chat contra OpenAI DIRECTO, sin Azure -- esta
  // corrida) -- cual hace falta depende de BENCH_PROVIDER_KIND, resuelto mas
  // abajo. Nunca los dos a la vez en la practica, pero se leen ambos aca
  // porque providerKind todavia no se determino en este punto del archivo.
  const providerKind = (process.env.BENCH_PROVIDER_KIND || 'foundry') as 'foundry' | 'anthropic-api' | 'openai-chat'
  const apiKey = providerKind === 'openai-chat' ? process.env.BENCH_OPENAI_KEY : process.env.BENCH_AZURE_KEY
  if (!apiKey) {
    console.error(providerKind === 'openai-chat' ? 'Falta BENCH_OPENAI_KEY en el entorno.' : 'Falta BENCH_AZURE_KEY en el entorno.')
    process.exit(1)
  }
  // Proveedor real -- 'foundry' (default, diseno original de Fase 2) o
  // 'anthropic-api' (mismo endpoint de Azure, ruta Anthropic-compatible ya
  // verificada en Fase 1), ambos configurables via env porque la corrida
  // piloto real encontro un problema real y reproducible especifico del
  // cliente HTTP de Amatista contra el deployment de Foundry con payloads
  // grandes (ver docs/_arch/verify_benchmark_harness.md, seccion "Hallazgo
  // real Foundry vs curl") -- no es un bug del harness ni de portabilidad
  // Linux (se reprodujo identico en Windows), asi que anthropic-api sirvio
  // de alternativa real para no bloquear el resto de la verificacion.
  // 'openai-chat' (nuevo, esta corrida): mismo runtime HTTP que ya existia
  // para OpenRouter (Fase 15, sendOpenAiApi()) apuntado a OpenAI DIRECTO
  // (api.openai.com) en vez de Azure -- Chat Completions es el formato
  // nativo real de OpenAI, asi que ningun cambio de codigo de produccion
  // hizo falta, solo endpoint/apiKey distintos.
  const endpoint = process.env.BENCH_ENDPOINT || (
    providerKind === 'anthropic-api'
      ? 'https://q-assistant-resource.services.ai.azure.com/anthropic/v1'
      : providerKind === 'openai-chat'
        ? 'https://api.openai.com/v1'
        : 'https://q-assistant-resource.services.ai.azure.com/openai/v1'
  )
  // BENCH_MODEL es OBLIGATORIO para openai-chat -- a proposito, sin default
  // hardcodeado: el modelo real disponible se confirma antes de cada corrida
  // (GPT-5.2, el modelo exacto que evaluo el paper de ProMax, ya no esta
  // disponible -- ver docs/_arch/verify_benchmark_harness.md para el modelo
  // real confirmado disponible con la key de esta corrida).
  if (providerKind === 'openai-chat' && !process.env.BENCH_MODEL) {
    console.error('Falta BENCH_MODEL -- para openai-chat no hay default, el modelo real disponible se confirma antes de correr (ver verify_benchmark_harness.md).')
    process.exit(1)
  }
  const model = process.env.BENCH_MODEL || (providerKind === 'anthropic-api' ? 'claude-opus-4-8' : 'gpt-5.5')

  // Paso 10 (diseno): nunca reusar una carpeta de una corrida anterior --
  // evita que un workspace parcialmente editado de un intento previo
  // contamine el `git diff` de esta corrida.
  if (existsSync(workspace)) {
    throw new Error(`El workspace ${workspace} ya existe -- este harness nunca reusa una carpeta de una corrida anterior.`)
  }

  // Paso 1 -- clone real + checkout real del base_commit real, corrido por
  // el harness (este proceso), nunca por el agente.
  console.log(`[harness] clonando ${task.repo} en ${workspace} ...`)
  await execFileAsync('git', ['clone', `https://github.com/${task.repo}.git`, workspace], { maxBuffer: 200 * 1024 * 1024 })
  await runGitPlain(workspace, ['checkout', task.base_commit])
  console.log(`[harness] checkout a ${task.base_commit} listo.`)

  const toolRegistry = new ToolRegistry()
  const toolCallLog: Record<string, number> = {}
  // ExecuteContext (tool-registry.ts) no esta exportado -- este objeto
  // matchea su forma estructuralmente (workspace/confirm/sandbox), suficiente
  // para que ToolRegistry.execute() lo acepte sin necesitar el tipo importado.
  const ctx = {
    workspace,
    confirm: async () => true,
    // Paso 3 -- 'danger-full-access': resolveApproval() (tool-registry.ts)
    // aprueba directo, sin pedir confirm() -- el harness corre sin usuario
    // interactivo del otro lado.
    sandbox: 'danger-full-access' as const
  }

  const runtime = new ApiAgentRuntime()
  runtime.configure({
    kind: providerKind,
    provider: {
      id: `bench-${providerKind}`,
      name: `${providerKind} (benchmark)`,
      // ProviderType es solo etiqueta/UI (shared/types.ts) -- sendOpenAiApi()
      // nunca lee provider.type, solo endpoint/apiKey/model, asi que 'openrouter'
      // aca (el unico ProviderType real asociado a kind:'openai-chat') no
      // afecta el comportamiento aunque esta corrida sea OpenAI directo, no
      // OpenRouter.
      type: providerKind === 'anthropic-api' ? 'anthropic' as const : providerKind === 'openai-chat' ? 'openrouter' as const : 'foundry' as const,
      authMode: 'api-key' as const,
      endpoint,
      apiKey,
      enabled: true,
      models: []
    },
    model,
    workspace,
    sandbox: 'danger-full-access' as const,
    toolsEnabled: true,
    // Paso 7 -- toolCallLog: envoltorio propio sobre toolExecutor, no
    // depende de ninguna instrumentacion interna de ApiAgentRuntime --
    // cuenta cada tool call real, cualquiera sea el proveedor.
    toolExecutor: (name: string, args: unknown) => {
      toolCallLog[name] = (toolCallLog[name] ?? 0) + 1
      return toolRegistry.execute(name, args, ctx)
    }
  })

  const result: RunResult = {
    instance_id: task.instance_id,
    repo: task.repo,
    base_commit: task.base_commit,
    model,
    startedAt: new Date().toISOString(),
    latencyMs: 0,
    callSucceeded: false,
    toolCallLog,
    patch: '',
    patchIsEmpty: true
  }

  // Pasos 4/5/6 -- Date.now() antes/despues, problem_statement real tal cual,
  // sin modificarlo.
  const startedAt = Date.now()
  try {
    console.log('[harness] enviando problem_statement real, turno en curso...')
    const sendResult = await runtime.send(task.problem_statement)
    result.latencyMs = Date.now() - startedAt
    result.callSucceeded = true
    result.usage = sendResult.usage
    console.log(`[harness] turno resuelto (${result.latencyMs} ms). texto final del agente:\n${sendResult.text}`)
  } catch (error) {
    // Paso 10 -- reject explicito capturado aca, motivo real preservado
    // (incluye el mensaje real de "se alcanzo el limite de N iteraciones..."
    // si fue MAX_TOOL_LOOP) -- nunca se disfraza de exito.
    result.latencyMs = Date.now() - startedAt
    result.callSucceeded = false
    result.errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[harness] el turno fallo: ${result.errorMessage}`)
  }

  // Paso 8 -- git diff externo, plano, corrido aca (no por el agente).
  // Corre siempre, exitoso o no el turno: si el agente alcanzo a escribir
  // algo antes de que MAX_TOOL_LOOP cortara, ese patch parcial es evidencia
  // real igual.
  try {
    result.patch = await runGitPlain(workspace, ['diff'])
    result.patchIsEmpty = result.patch.trim().length === 0
  } catch (error) {
    const diffError = `git diff fallo: ${error instanceof Error ? error.message : String(error)}`
    result.errorMessage = result.errorMessage ? `${result.errorMessage} | ${diffError}` : diffError
  }

  // Paso 9 -- resultado estructurado, en runDir (aislado por tarea) para
  // que Fase 3 lo pueda consumir despues sin tener que volver a correr nada.
  const resultPath = path.join(runDir, 'result.json')
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')
  console.log(`[harness] resultado escrito en ${resultPath}`)
  console.log(`[harness] callSucceeded=${result.callSucceeded} patchIsEmpty=${result.patchIsEmpty} toolCallLog=${JSON.stringify(toolCallLog)}`)
}

main().catch(error => {
  console.error('[harness] fallo no manejado:', error)
  process.exitCode = 1
})
