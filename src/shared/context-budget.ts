// Unica fuente de verdad del presupuesto de contexto que antes vivia
// triplicado por coincidencia: RUNTIME_HISTORY_LIMIT y RUNTIME_SUMMARY_TRIGGER
// en App.tsx, MAX_HISTORY_MESSAGES en context-envelope.ts — los tres en 18,
// sin que ninguno importara al otro. Ver docs/_arch/CONTRACT.md → "Contrato
// de memoria/contexto" v2.
//
// El umbral se basa en tamano ESTIMADO de texto (heuristica chars/4), no en
// conteo de mensajes: un historial de 18 mensajes de una linea pesa mucho
// menos que 18 mensajes con pegotes de codigo — contar mensajes no reflejaba
// el riesgo real de reventar el contexto del modelo. No se agrega una
// libreria de tokenizacion real (no hay ninguna en package.json y no se
// justifica solo para esto).

/** Estimador conservador: ~4 caracteres por token en texto mixto (prosa +
 *  codigo). Sobreestima un poco en ingles puro, subestima un poco en texto
 *  denso en simbolos — suficiente para una heuristica de presupuesto, no
 *  para facturacion. */
export const CHARS_PER_TOKEN_ESTIMATE = 4

/**
 * Presupuesto de tokens estimados, usado con TRES roles que antes eran tres
 * numeros separados coincidiendo en valor:
 *  1. Techo duro de lo que se manda VERBATIM en un turno (normalizeHistory
 *     en context-envelope.ts) — independiente de cuanto haya resumido la
 *     compactacion todavia (ver Tarea 5 / caso de backfill).
 *  2. Umbral de disparo de la compactacion asincrona: si lo no-resumido
 *     (posterior al watermark) supera este numero, vale la pena compactar
 *     (compaction-engine.ts).
 *  3. Tamano del bloque mas viejo que se compacta por pasada — nunca se
 *     manda todo el backlog de una sola vez a la llamada de compactacion.
 * Un solo numero, tres usos consistentes, en vez de tres declaraciones
 * independientes que solo por casualidad de mantenimiento coincidian.
 */
export const CONTEXT_TOKEN_BUDGET = 6000

/** chars.length / CHARS_PER_TOKEN_ESTIMATE, redondeado hacia arriba. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}
