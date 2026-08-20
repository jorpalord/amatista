import { EventEmitter } from 'node:events'

export class ClaudeSubscriptionRuntime extends EventEmitter {
  async start(): Promise<never> {
    throw new Error(
      'Claude Code está contemplado como autenticación por suscripción, pero la V0.3 todavía no implementa el puente de herramientas/streaming compatible con nuestra interfaz. Se detecta el CLI y se muestra el estado, pero no se simula como operativo.'
    )
  }
}
