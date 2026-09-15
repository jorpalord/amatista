// Helper real de UI Automation para Familia A (mouse_click/keyboard_type de
// Amatista) -- docs/_arch/verify_flaui_helper_viability.md, ya confirmado y
// aprobado. Proceso persistente, arrancado por Amatista main
// (src/main/flaui-client.ts) con --stdio, protocolo NDJSON (un JSON por
// linea, en cada direccion), UNA instancia de UIA3Automation creada al
// arrancar y reusada para todos los comandos de toda la sesion (mismo
// principio real que codex-client.ts reusa un solo `codex app-server`).
//
// 2 bugs reales ya encontrados y corregidos en la investigacion, presentes
// desde el dia 1 de este archivo (no reintroducidos):
//  1. BOM UTF-8 real en la primera linea que llega por stdin (antepuesto por
//     el lado que escribe) -- TrimStart('﻿') defensivo en cada linea.
//  2. Acceder a una propiedad UIA no soportada podia tirar antes de terminar
//     de parsear el "id" real del pedido, rompiendo la correlacion pedido/
//     respuesta del lado de Node -- el "id" se parsea PRIMERO, siempre, y
//     cada acceso a una propiedad UIA individual pasa por SafeStr()/SafeRect()
//     (try/catch propio), nunca una excepcion sin capturar a mitad de camino.
//
// Cancelacion (Tarea 3 de la investigacion, "trocear type"): CADA linea
// entrante se despacha en su propio Task.Run -- esto es lo que permite que
// un comando "cancel" real llegue y se procese MIENTRAS un "type" largo
// sigue en curso en otro hilo. `type` chequea el CancellationToken ANTES de
// cada caracter (mismo principio de micro-pasos que ya usa
// computer-use-actions.ts del lado de Node con nut-js) -- ningun otro
// comando necesita esto (son atomicos, medidos en 32-96ms en la
// investigacion). find_element/click/hit_test/get_tree usan en cambio un
// timeout blando (Task.WhenAny + Task.Delay): si una llamada UIA real se
// cuelga (posible, confirmado real en la investigacion que .NET moderno no
// tiene forma de matar un hilo bloqueado en una llamada COM desde adentro,
// Thread.Abort() fue removido), el helper responde timeout y sigue vivo
// para el resto de los pedidos -- el hilo bloqueado queda abandonado hasta
// que la llamada real eventualmente retorne o el proceso muera. Limitacion
// real conocida, documentada, no un bug de este archivo.
using System.Collections.Concurrent;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using FlaUI.UIA3;

namespace AmatistaFlaUIHelper;

internal static class Program
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private static readonly object StdoutLock = new();
    private static readonly ConcurrentDictionary<long, CancellationTokenSource> Pending = new();
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };
    private static StreamWriter _stdout = null!;

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 0 || args[0] != "--stdio")
        {
            Console.Error.WriteLine("Uso: FlaUIHelper.exe --stdio");
            return 1;
        }

        var automation = new UIA3Automation();
        _stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false };
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        var running = new ConcurrentBag<Task>();
        string? line;
        while ((line = await stdin.ReadLineAsync().ConfigureAwait(false)) != null)
        {
            var trimmed = line.TrimStart('﻿').Trim();
            if (trimmed.Length == 0) continue;
            var captured = trimmed;
            running.Add(Task.Run(() => HandleLine(captured, automation)));
        }

        await Task.WhenAll(running.Where(t => !t.IsCompleted)).ConfigureAwait(false);
        return 0;
    }

    private static void HandleLine(string line, UIA3Automation automation)
    {
        long id = 0;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt64() : 0;
            var cmd = root.TryGetProperty("cmd", out var cmdEl) ? cmdEl.GetString() ?? "" : "";

            if (cmd == "cancel")
            {
                var targetId = root.TryGetProperty("targetId", out var t) ? t.GetInt64() : 0;
                if (Pending.TryGetValue(targetId, out var targetCts)) targetCts.Cancel();
                WriteResponse(new { id, ok = true });
                return;
            }

            var cts = new CancellationTokenSource();
            Pending[id] = cts;
            try
            {
                WriteResponse(Dispatch(id, cmd, root, automation, cts.Token));
            }
            finally
            {
                Pending.TryRemove(id, out _);
            }
        }
        catch (Exception ex)
        {
            WriteResponse(new { id, ok = false, error = ex.Message });
        }
    }

    private static object Dispatch(long id, string cmd, JsonElement root, UIA3Automation automation, CancellationToken token) => cmd switch
    {
        "get_tree" => RunWithTimeout(id, () => HandleGetTree(id, automation, root)),
        "find_element" => RunWithTimeout(id, () => HandleFindElement(id, automation, root)),
        "click" => RunWithTimeout(id, () => HandleClick(id, automation, root)),
        "hit_test" => RunWithTimeout(id, () => HandleHitTest(id, automation, root)),
        "type" => HandleType(id, automation, root, token),
        _ => new { id, ok = false, error = $"Comando desconocido: {cmd}" }
    };

    /// <summary>
    /// Opcion (a) de la Tarea 3 de la investigacion: la llamada UIA real
    /// corre en su propio Task, este metodo la corre contra un timeout de
    /// 8s -- si no volvio a tiempo, responde timeout YA MISMO (el helper
    /// sigue respondiendo otros pedidos) y abandona el Task original (sigue
    /// vivo en el threadpool hasta que la llamada real retorne o el proceso
    /// muera -- no hay forma soportada de matarlo desde adentro, confirmado
    /// real en la investigacion: Thread.Abort() fue removido de .NET
    /// moderno).
    /// </summary>
    private static object RunWithTimeout(long id, Func<object> work, int timeoutMs = 8000)
    {
        var task = Task.Run(work);
        var finished = Task.WaitAny(new Task[] { task }, timeoutMs) == 0;
        if (finished) return task.Result;
        return new
        {
            id,
            ok = false,
            error = $"timeout ({timeoutMs}ms) esperando una llamada UIA real que no respondio -- limitacion real conocida (ver docs/_arch/PENDING.md), no significa que el elemento no exista."
        };
    }

    private static AutomationElement? ResolveForegroundWindow(UIA3Automation automation)
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return null;
        try { return automation.FromHandle(hwnd); } catch { return null; }
    }

    private static string? GetStr(JsonElement el, string prop) =>
        el.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string SafeStr(Func<string?> getter)
    {
        try { return getter() ?? ""; } catch { return ""; }
    }

    private static (double X, double Y, double Width, double Height) SafeRect(AutomationElement el)
    {
        try
        {
            var r = el.BoundingRectangle;
            return (r.X, r.Y, r.Width, r.Height);
        }
        catch { return (0, 0, 0, 0); }
    }

    private static object Describe(AutomationElement el)
    {
        var rect = SafeRect(el);
        return new
        {
            automationId = SafeStr(() => el.AutomationId),
            name = SafeStr(() => el.Name),
            controlType = SafeStr(() => el.ControlType.ToString()),
            className = SafeStr(() => el.ClassName),
            x = rect.X,
            y = rect.Y,
            width = rect.Width,
            height = rect.Height
        };
    }

    /// <summary>Mismo formato real que el resolver del navegador embebido
    /// (embedded-browser.ts, resolverScript() -- listCandidates()) para
    /// not_found/ambiguous -- consistencia deliberada entre los 2
    /// mecanismos de resolucion semantica que tiene Amatista.</summary>
    private static string[] DescribeList(IEnumerable<AutomationElement> els) =>
        els.Take(20)
            .Select(el => $"{SafeStr(() => el.ControlType.ToString())}: \"{SafeStr(() => el.Name)}\" (automationId={SafeStr(() => el.AutomationId)})")
            .ToArray();

    /// <summary>Busqueda real por criterios (automationId/name/controlType/
    /// className, cualquier combinacion, todas opcionales salvo que hace
    /// falta al menos una). automationId/controlType/className son exactos;
    /// name usa el mismo criterio real que resolverScript() del navegador
    /// embebido -- exacto primero (case-insensitive), substring solo si CERO
    /// matches exactos. Devuelve ademas un "pool" real (todos los elementos
    /// CON nombre real en el scope, sin filtrar por el criterio que fallo) --
    /// mismo espiritu que el "candidates" que resolverScript() del navegador
    /// embebido devuelve en not_found/ambiguous: una lista real de que SI
    /// hay disponible para que el modelo reintente con mejor descripcion, en
    /// vez de una lista vacia sin valor.</summary>
    private static (List<AutomationElement> Matches, List<AutomationElement> Pool) FindCandidates(AutomationElement? scope, JsonElement criteria)
    {
        if (scope == null) return (new List<AutomationElement>(), new List<AutomationElement>());
        var automationId = GetStr(criteria, "automationId");
        var name = GetStr(criteria, "name");
        var controlType = GetStr(criteria, "controlType");
        var className = GetStr(criteria, "className");

        var all = scope.FindAllDescendants();
        var filtered = all.Where(el =>
        {
            if (automationId != null && !string.Equals(SafeStr(() => el.AutomationId), automationId, StringComparison.Ordinal)) return false;
            if (controlType != null && !string.Equals(SafeStr(() => el.ControlType.ToString()), controlType, StringComparison.OrdinalIgnoreCase)) return false;
            if (className != null && !string.Equals(SafeStr(() => el.ClassName), className, StringComparison.OrdinalIgnoreCase)) return false;
            return true;
        }).ToList();
        var namedPool = all.Where(el => !string.IsNullOrEmpty(SafeStr(() => el.Name))).ToList();

        if (name == null) return (filtered, namedPool);

        var withName = filtered.Where(el => !string.IsNullOrEmpty(SafeStr(() => el.Name))).ToList();
        var exact = withName.Where(el => string.Equals(SafeStr(() => el.Name), name, StringComparison.OrdinalIgnoreCase)).ToList();
        var matches = exact.Count > 0 ? exact : withName.Where(el => SafeStr(() => el.Name).Contains(name, StringComparison.OrdinalIgnoreCase)).ToList();
        return (matches, namedPool);
    }

    private static object HandleGetTree(long id, UIA3Automation automation, JsonElement root)
    {
        var hasCriteria = root.TryGetProperty("automationId", out _) || root.TryGetProperty("name", out _)
            || root.TryGetProperty("controlType", out _) || root.TryGetProperty("className", out _);

        AutomationElement? scopeRoot;
        if (hasCriteria)
        {
            var (matches, pool) = FindCandidates(ResolveForegroundWindow(automation), root);
            if (matches.Count == 0) return new { id, ok = true, status = "not_found", candidates = DescribeList(pool) };
            if (matches.Count > 1) return new { id, ok = true, status = "ambiguous", candidates = DescribeList(matches) };
            scopeRoot = matches[0];
        }
        else
        {
            scopeRoot = ResolveForegroundWindow(automation);
        }

        if (scopeRoot == null) return new { id, ok = false, error = "No se pudo resolver la ventana real en primer plano." };
        var children = scopeRoot.FindAllChildren();
        return new { id, ok = true, status = "ok", root = Describe(scopeRoot), children = children.Select(Describe).ToArray() };
    }

    private static object HandleFindElement(long id, UIA3Automation automation, JsonElement root)
    {
        var scope = ResolveForegroundWindow(automation);
        if (scope == null) return new { id, ok = false, error = "No se pudo resolver la ventana real en primer plano." };
        var (matches, pool) = FindCandidates(scope, root);
        if (matches.Count == 0) return new { id, ok = true, status = "not_found", candidates = DescribeList(pool) };
        if (matches.Count > 1) return new { id, ok = true, status = "ambiguous", candidates = DescribeList(matches) };
        var el = matches[0];
        var rect = SafeRect(el);
        return new
        {
            id,
            ok = true,
            status = "ok",
            automationId = SafeStr(() => el.AutomationId),
            name = SafeStr(() => el.Name),
            controlType = SafeStr(() => el.ControlType.ToString()),
            className = SafeStr(() => el.ClassName),
            x = rect.X,
            y = rect.Y,
            width = rect.Width,
            height = rect.Height
        };
    }

    /// <summary>click(criteria) real, atomico -- resuelve (FindCandidates,
    /// contra la ventana real en primer plano, en ESTE instante) y clickea
    /// (el.Click()/el.RightClick(), llamada UIA real que internamente
    /// recalcula el punto clickeable ACTUAL del elemento) en el MISMO
    /// round-trip, sin exponer coordenadas del lado que orquesta -- mismo
    /// principio real que resolverScript() del navegador embebido (resolver
    /// y accionar en el mismo instante, inmune a que la ventana se haya
    /// movido/redimensionado entre que el modelo decide el target y este
    /// comando corre).</summary>
    private static object HandleClick(long id, UIA3Automation automation, JsonElement root)
    {
        var scope = ResolveForegroundWindow(automation);
        if (scope == null) return new { id, ok = false, error = "No se pudo resolver la ventana real en primer plano." };
        var (matches, pool) = FindCandidates(scope, root);
        if (matches.Count == 0) return new { id, ok = true, status = "not_found", candidates = DescribeList(pool) };
        if (matches.Count > 1) return new { id, ok = true, status = "ambiguous", candidates = DescribeList(matches) };
        var el = matches[0];
        var button = GetStr(root, "button") ?? "left";
        try
        {
            if (string.Equals(button, "right", StringComparison.OrdinalIgnoreCase)) el.RightClick();
            else el.Click();
        }
        catch (Exception ex)
        {
            return new { id, ok = true, status = "error", error = ex.Message };
        }
        return new
        {
            id,
            ok = true,
            status = "ok",
            automationId = SafeStr(() => el.AutomationId),
            name = SafeStr(() => el.Name),
            controlType = SafeStr(() => el.ControlType.ToString())
        };
    }

    /// <summary>hit_test(x,y) real via FromPoint -- resuelve QUE elemento
    /// real (si hay alguno semantico) esta bajo un punto absoluto de
    /// pantalla, en ESTE instante. Bonus real de la investigacion (ningun
    /// paquete npm de UIA evaluado antes lo exponia) -- disponible como
    /// fallback real para cuando mouse_click/keyboard_type caen a
    /// coordenadas puras (contenido no-semantico real, ej. el canvas de
    /// Paint): antes de ejecutar el click ciego por coordenadas,
    /// computer-use-actions.ts lo usa para enriquecer el resultado real que
    /// vuelve al modelo con que fue lo que realmente estaba ahi (o
    /// confirmar que no habia nada semantico) -- diagnostico real, nunca
    /// reemplaza al click por coordenadas ya verificado.</summary>
    private static object HandleHitTest(long id, UIA3Automation automation, JsonElement root)
    {
        if (!root.TryGetProperty("x", out var xEl) || !root.TryGetProperty("y", out var yEl))
            return new { id, ok = false, error = "Faltan \"x\"/\"y\"." };
        var x = xEl.GetInt32();
        var y = yEl.GetInt32();
        try
        {
            var el = automation.FromPoint(new Point(x, y));
            if (el == null) return new { id, ok = true, found = false };
            var rect = SafeRect(el);
            return new
            {
                id,
                ok = true,
                found = true,
                automationId = SafeStr(() => el.AutomationId),
                name = SafeStr(() => el.Name),
                controlType = SafeStr(() => el.ControlType.ToString()),
                className = SafeStr(() => el.ClassName),
                x = rect.X,
                y = rect.Y,
                width = rect.Width,
                height = rect.Height
            };
        }
        catch (Exception ex)
        {
            return new { id, ok = false, error = ex.Message };
        }
    }

    /// <summary>type(criteria, text) real -- resuelve y enfoca UNA vez,
    /// despues escribe caracter por caracter con Keyboard.Type(char) (mismo
    /// mecanismo de bajo nivel que usa TextBox.Enter() internamente, pero
    /// trocedo a mano para poder chequear cancelacion ENTRE cada caracter --
    /// mismo principio real de micro-pasos que ya usa computer-use-actions.ts
    /// del lado de Node con nut-js, Tarea 3 de la investigacion: "trocear
    /// type si es directo"). El CancellationToken se dispara real desde
    /// afuera via un comando "cancel" NDJSON mientras este comando sigue en
    /// curso -- solo es posible porque HandleLine() despacha cada linea en
    /// su propio Task.Run, permitiendo que "cancel" se procese en paralelo
    /// sin esperar a que "type" termine.</summary>
    private static object HandleType(long id, UIA3Automation automation, JsonElement root, CancellationToken token)
    {
        var text = GetStr(root, "text");
        if (string.IsNullOrEmpty(text)) return new { id, ok = false, error = "Falta \"text\"." };

        var scope = ResolveForegroundWindow(automation);
        if (scope == null) return new { id, ok = false, error = "No se pudo resolver la ventana real en primer plano." };
        var (matches, pool) = FindCandidates(scope, root);
        if (matches.Count == 0) return new { id, ok = true, status = "not_found", candidates = DescribeList(pool) };
        if (matches.Count > 1) return new { id, ok = true, status = "ambiguous", candidates = DescribeList(matches) };
        var el = matches[0];

        try
        {
            el.Focus();
        }
        catch (Exception ex)
        {
            return new { id, ok = true, status = "error", error = $"No se pudo enfocar el elemento real: {ex.Message}" };
        }

        var charsTyped = 0;
        var interrupted = false;
        foreach (var c in text)
        {
            if (token.IsCancellationRequested) { interrupted = true; break; }
            Keyboard.Type(c);
            charsTyped++;
        }

        return new
        {
            id,
            ok = true,
            status = "ok",
            interrupted,
            charsTyped,
            totalChars = text.Length,
            automationId = SafeStr(() => el.AutomationId),
            name = SafeStr(() => el.Name),
            controlType = SafeStr(() => el.ControlType.ToString())
        };
    }

    private static void WriteResponse(object response)
    {
        var json = JsonSerializer.Serialize(response, response.GetType(), JsonOptions);
        lock (StdoutLock)
        {
            _stdout.Write(json);
            _stdout.Write('\n');
            _stdout.Flush();
        }
    }
}
