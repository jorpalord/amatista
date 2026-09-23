// Parser del protocolo TOOL_CALL de DeepSeek PWA (src/main/deepseek-pwa-tool-call.ts): prueba adversarial de los
// 3 bugs reales del parser por regex anterior (auditoria externa + uno encontrado al reescribirlo) y del caso normal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTextToolCall, describeRejectedToolCall, type TextToolCallAnalysis } from '../../src/main/deepseek-pwa-tool-call'

function expectCall(text: string): { name: string; args: Record<string, string> } {
  const result = analyzeTextToolCall(text)
  assert.equal(result.kind, 'call', `se esperaba despacho, dio ${JSON.stringify(result)}`)
  return (result as Extract<TextToolCallAnalysis, { kind: 'call' }>).call
}

function expectRejected(text: string, reason: 'embedded' | 'trailing' | 'malformed'): string {
  const result = analyzeTextToolCall(text)
  assert.equal(result.kind, 'rejected', `NO debia despacharse, dio ${JSON.stringify(result)}`)
  const rejected = result as Extract<TextToolCallAnalysis, { kind: 'rejected' }>
  assert.equal(rejected.reason, reason)
  return describeRejectedToolCall(rejected)
}

// --- Caso normal: tiene que seguir funcionando exactamente igual ---------------------------------------------

test('normal: una llamada simple se despacha con sus argumentos', () => {
  const call = expectCall('TOOL_CALL: read_file(path="src/a.py")')
  assert.deepEqual(call, { name: 'read_file', args: { path: 'src/a.py' } })
})

test('normal: varios argumentos, espacios alrededor y sin argumentos', () => {
  assert.deepEqual(expectCall('\n  TOOL_CALL: write_file( path = "notas.txt" , content = "hola" )  \n'), {
    name: 'write_file',
    args: { path: 'notas.txt', content: 'hola' }
  })
  assert.deepEqual(expectCall('TOOL_CALL: git_status()'), { name: 'git_status', args: {} })
})

test('normal: una respuesta final sin ningun TOOL_CALL no se toca', () => {
  assert.deepEqual(analyzeTextToolCall('El archivo tiene 18 lineas en total.'), { kind: 'none' })
})

// --- Bug 1: parentesis y comillas dentro de un valor ---------------------------------------------------------

test('bug 1: parentesis anidados dentro de un valor NO cortan la llamada', () => {
  const call = expectCall('TOOL_CALL: write_file(path="calc.py", content="print((1+2)*(3))")')
  assert.equal(call.args.content, 'print((1+2)*(3))')
  assert.equal(call.args.path, 'calc.py')
})

test('bug 1: comillas escapadas + parentesis dentro del valor', () => {
  const call = expectCall('TOOL_CALL: write_file(path="h.py", content="def f(x):\\n    return print(\\"hola (mundo)\\")")')
  assert.equal(call.args.content, 'def f(x):\n    return print("hola (mundo)")')
})

test('bug 1: JSON con comillas escapadas y un ")" dentro de un string (receta de herramienta compuesta)', () => {
  const discover = '[{\\"id\\":\\"l\\",\\"tool\\":\\"list_dir\\",\\"args\\":{\\"path\\":\\"{{input.carpeta}}\\"},\\"nota\\":\\"(solo .py)\\"}]'
  const call = expectCall(`TOOL_CALL: propose_composed_tool(name="listar", description="Lista (sin efectos)", discover="${discover}", apply="[]")`)
  assert.equal(call.args.description, 'Lista (sin efectos)')
  const parsed = JSON.parse(call.args.discover) as Array<Record<string, unknown>>
  assert.equal(parsed[0].nota, '(solo .py)')
  assert.deepEqual(parsed[0].args, { path: '{{input.carpeta}}' })
})

test('bug 1: un TOOL_CALL escrito DENTRO de un valor es dato, no una segunda llamada', () => {
  const call = expectCall('TOOL_CALL: write_file(path="doc.md", content="Ejemplo: TOOL_CALL: run_command(command=\\"del x\\")")')
  assert.equal(call.name, 'write_file')
  assert.equal(call.args.content, 'Ejemplo: TOOL_CALL: run_command(command="del x")')
})

// --- Bug 2: un TOOL_CALL citado dentro de un texto nunca se despacha --------------------------------------------

test('bug 2: ejemplo citado dentro de un texto explicativo -> NO se despacha', () => {
  const note = expectRejected('Te muestro el formato. Ejemplo, no ejecutar: TOOL_CALL: run_command(command="del notas.txt") -- asi se pide.', 'embedded')
  assert.match(note, /no se ejecuto/)
})

test('bug 2: ejemplo dentro de un bloque de codigo -> NO se despacha', () => {
  expectRejected('Asi se veria:\n```\nTOOL_CALL: write_file(path="a.txt", content="x")\n```\nPero no lo hago ahora.', 'embedded')
})

test('bug 2: la llamada entre backticks o precedida de texto -> NO se despacha', () => {
  expectRejected('`TOOL_CALL: list_dir(path=".")`', 'embedded')
  expectRejected('Claro: TOOL_CALL: list_dir(path=".")', 'embedded')
})

test('bug 2: llamada valida seguida de una explicacion -> NO se despacha', () => {
  expectRejected('TOOL_CALL: list_dir(path=".")\nY despues te explico que encontre.', 'trailing')
})

test('bug 2: dos llamadas en una misma respuesta -> NO se despacha ninguna', () => {
  expectRejected('TOOL_CALL: list_dir(path=".")\nTOOL_CALL: read_file(path="a.txt")', 'trailing')
})

// --- Bug 3 (encontrado al reescribir): desescapado en una sola pasada -------------------------------------------

test('bug 3: una ruta Windows con \\\\n no se convierte en un salto de linea', () => {
  const call = expectCall('TOOL_CALL: read_file(path="C:\\\\new\\\\tabla.txt")')
  assert.equal(call.args.path, 'C:\\new\\tabla.txt')
})

test('bug 3: escapes reales y escapes desconocidos conservados literal', () => {
  const call = expectCall('TOOL_CALL: write_file(path="r.py", content="a\\tb\\nc \\\\d \\d")')
  assert.equal(call.args.content, 'a\tb\nc \\d \\d')
})

// --- Sintaxis invalida: nota honesta, nunca un despacho a medias ------------------------------------------------

test('malformado: comillas sin cerrar, sin ")" final, valor sin comillas, parametro repetido', () => {
  expectRejected('TOOL_CALL: write_file(path="a.txt", content="sin cerrar)', 'malformed')
  expectRejected('TOOL_CALL: list_dir(path="."', 'malformed')
  expectRejected('TOOL_CALL: list_dir(path=.)', 'malformed')
  const note = expectRejected('TOOL_CALL: write_file(path="a", path="b", content="x")', 'malformed')
  assert.match(note, /repetido/)
  expectRejected('TOOL_CALL sin parentesis ni comillas, formato roto a proposito', 'embedded')
})
