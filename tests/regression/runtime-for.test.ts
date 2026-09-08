// Test de regresion real (candidato #6, docs/_arch/verify_regression_test_infra_design.md):
// runtimeFor() unificado (shared/runtime-for.ts). YA causo una regresion
// silenciosa real una vez (2 copias casi identicas en main/renderer
// divergieron -- OpenRouter se autocorrompia a 'gemini-api' en cada
// reinicio real de la app, docs/_arch/verify_runtime_for_openrouter_fix.md).
// Funcion pura, sin ninguna dependencia -- ni bundle ni stub de electron
// hacen falta para que esto sea codigo de produccion real, sin mocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runtimeFor } from '../../src/shared/runtime-for'

test('runtimeFor() real -- tabla completa de combinaciones reales alcanzables desde la UI', () => {
  // Codex/ChatGPT: SOLO suscripcion (newProvider('openai-codex','subscription'),
  // confirmado con grep real que la UI nunca crea 'openai-codex' con
  // authMode 'api-key').
  assert.equal(runtimeFor('openai-codex', 'subscription'), 'codex-subscription')

  // Foundry: siempre 'foundry', sin ramificar por authMode.
  assert.equal(runtimeFor('foundry', 'api-key'), 'foundry')

  // OpenAI directo / OpenAI-compatible: los 2 van a 'openai-chat' (Chat
  // Completions HTTP directo) -- migrados desde 'codex-api' porque
  // codex-cli confirmado real que NUNCA lee provider.endpoint (el boton
  // "Compatible" ignoraba en silencio cualquier endpoint custom).
  assert.equal(runtimeFor('openai', 'api-key'), 'openai-chat')
  assert.equal(runtimeFor('openai-compatible', 'api-key'), 'openai-chat')

  // Anthropic/Claude: unico tipo que se ramifica realmente por authMode --
  // 'api-key' es HTTP directo, 'subscription' spawnea el CLI real.
  assert.equal(runtimeFor('anthropic', 'api-key'), 'anthropic-api')
  assert.equal(runtimeFor('anthropic', 'subscription'), 'claude-cli')

  // Antigravity: siempre 'antigravity-cli' sin ramificar -- suscripcion y
  // API key spawnean el mismo binario `agy`, la diferencia real vive en
  // buildEnv() (cli-agent-runtime.ts), no en el runtime elegido.
  assert.equal(runtimeFor('antigravity', 'subscription'), 'antigravity-cli')
  assert.equal(runtimeFor('antigravity', 'api-key'), 'antigravity-cli')

  // OpenRouter: siempre api-key, siempre 'openai-chat' -- el caso real que
  // motivo el fix original (divergencia entre main/renderer).
  assert.equal(runtimeFor('openrouter', 'api-key'), 'openai-chat')

  // Google/Gemini: siempre 'gemini-api' (HTTP directo) -- gemini-cli
  // standalone fue retirado por completo.
  assert.equal(runtimeFor('google', 'api-key'), 'gemini-api')
})
