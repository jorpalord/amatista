package com.amatista.remote

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.security.MessageDigest

data class ChatSummary(val id: String, val title: String, val project: String?, val updatedAt: String)
data class ChatMessage(val id: String, val role: String, val text: String, val createdAt: String, val attachments: List<String>)
data class ActivityInfo(val title: String, val startedAt: Long)
data class LiveTurn(val text: String = "", val status: String? = null, val running: Boolean = true)

sealed interface Phase {
    data object Unpaired : Phase
    data class Verifying(val detail: String) : Phase
    data class AwaitingConfirmation(val sas: String) : Phase
    data class Failed(val message: String) : Phase
    data object Paired : Phase
}

enum class LinkState { STOPPED, CONNECTING, CONNECTED, RECONNECTING, PIN_MISMATCH, REVOKED }

/**
 * Estado del visor (solo lectura) + la conexion con la PC. Un solo objeto para la app y el servicio en segundo plano.
 * Nunca manda nada que cambie algo en la PC: los unicos pedidos son el emparejamiento, GET /api/v0/chats,
 * GET /api/v0/projects y el stream GET /api/v0/events (ver CONTRACT.md §8 de la PC).
 */
@SuppressLint("StaticFieldLeak") // guarda el applicationContext, nunca una Activity
object RemoteSession {
    private lateinit var context: Context
    private lateinit var store: SecureStore
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var streamJob: Job? = null
    private var refreshJob: Job? = null

    private val _phase = MutableStateFlow<Phase>(Phase.Unpaired)
    val phase: StateFlow<Phase> = _phase
    private val _link = MutableStateFlow(LinkState.STOPPED)
    val link: StateFlow<LinkState> = _link
    private val _chats = MutableStateFlow<List<ChatSummary>>(emptyList())
    val chats: StateFlow<List<ChatSummary>> = _chats
    private val _messages = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val messages: StateFlow<Map<String, List<ChatMessage>>> = _messages
    private val _projects = MutableStateFlow<List<String>>(emptyList())
    val projects: StateFlow<List<String>> = _projects
    private val _activity = MutableStateFlow<Map<String, ActivityInfo>>(emptyMap())
    val activity: StateFlow<Map<String, ActivityInfo>> = _activity
    private val _live = MutableStateFlow<Map<String, LiveTurn>>(emptyMap())
    val live: StateFlow<Map<String, LiveTurn>> = _live
    private val _approvals = MutableStateFlow<Map<String, String>>(emptyMap())
    val approvals: StateFlow<Map<String, String>> = _approvals
    private val _flags = MutableStateFlow<Map<String, String>>(emptyMap())
    val flags: StateFlow<Map<String, String>> = _flags
    private val _keyProtection = MutableStateFlow<String?>(null)
    val keyProtection: StateFlow<String?> = _keyProtection

    fun init(appContext: Context) {
        if (::context.isInitialized) return
        context = appContext.applicationContext
        store = SecureStore(context)
        createChannels()
        if (store.pairing() != null && store.token() != null) {
            _phase.value = Phase.Paired
            _keyProtection.value = runCatching { store.keyProtection() }.getOrNull()
        }
    }

    fun pairedPc(): SecureStore.Pairing? = store.pairing()

    // ---------------------------------------------------------------- emparejamiento
    fun startPairing(link: PairingLink, deviceName: String) {
        scope.launch {
            try {
                _phase.value = Phase.Verifying("Verificando el certificado de la PC…")
                Log.i(TAG, "EMPAREJAR: QR leido -> ${link.host}:${link.port}, pin ${link.pin}")
                val transport = PinnedTransport(link.host, link.port, link.pin)
                // El primer pedido ya va por TLS con el pin: si el certificado no es el del QR, el handshake falla
                // y el codigo de un solo uso nunca sale del telefono.
                val body = JSONObject().put("code", link.code).put("deviceName", deviceName).toString()
                val (code, text) = transport.request("POST", "/api/v0/pair", body = body)
                if (code != 200) {
                    _phase.value = Phase.Failed("La PC rechazo el codigo (${JSONObject(text).optString("error", "HTTP $code")}). Pedi un QR nuevo.")
                    return@launch
                }
                val answer = JSONObject(text)
                val secret = answer.getString("pairingSecret")
                val sas = answer.getString("sas")
                Log.i(TAG, "EMPAREJAR: codigo aceptado, 6 digitos = $sas -- esperando confirmacion en la PC")
                _phase.value = Phase.AwaitingConfirmation(sas)
                val deadline = System.currentTimeMillis() + 150_000
                while (System.currentTimeMillis() < deadline) {
                    delay(1_500)
                    val (pc, pt) = transport.request("GET", "/api/v0/pair/status", mapOf("Authorization" to "Pairing $secret"))
                    val status = if (pc == 200) JSONObject(pt).optString("status") else "unknown"
                    when (status) {
                        "awaiting-confirmation" -> continue
                        "approved" -> {
                            val result = JSONObject(pt)
                            val token = result.getString("token")
                            store.savePairing(SecureStore.Pairing(link.host, link.port, link.pin, result.getString("deviceId")), token)
                            _keyProtection.value = runCatching { store.keyProtection() }.getOrNull()
                            if (BuildConfig.DEBUG) Log.d(TAG, "EMPAREJAR: token guardado cifrado; sha256 del token = ${sha256Hex(token).take(16)}…")
                            Log.i(TAG, "EMPAREJAR: confirmado en la PC. Clave del Keystore: ${_keyProtection.value}")
                            _phase.value = Phase.Paired
                            refreshChats()
                            startStream()
                            return@launch
                        }
                        "rejected" -> { _phase.value = Phase.Failed("La PC rechazo el emparejamiento."); return@launch }
                        else -> { _phase.value = Phase.Failed("La solicitud vencio o no existe. Pedi un QR nuevo."); return@launch }
                    }
                }
                _phase.value = Phase.Failed("No se confirmo a tiempo en la PC. Pedi un QR nuevo.")
            } catch (e: Exception) {
                if (PinnedTransport.isPinMismatch(e)) {
                    _phase.value = Phase.Failed("El certificado de la PC NO coincide con el del QR. No se envio nada.")
                } else {
                    Log.w(TAG, "EMPAREJAR fallo: ${e.javaClass.simpleName}: ${e.message}")
                    _phase.value = Phase.Failed("No se pudo conectar con la PC (${e.javaClass.simpleName}). ¿Estan en la misma red Wi-Fi?")
                }
            }
        }
    }

    fun resetPairingError() {
        if (_phase.value is Phase.Failed) _phase.value = Phase.Unpaired
    }

    // ---------------------------------------------------------------- lecturas (los 2 endpoints permitidos)
    private fun transport(): PinnedTransport? = store.pairing()?.let { PinnedTransport(it.host, it.port, it.pin) }

    fun refreshChats() {
        val transport = transport() ?: return
        val token = store.token() ?: return
        val (code, text) = transport.request("GET", "/api/v0/chats", mapOf("Authorization" to "Bearer $token"))
        if (code == 401) { onRevoked(); return }
        if (code != 200) throw IOException("GET /api/v0/chats -> HTTP $code")
        val json = JSONObject(text)
        val sessions = json.getJSONArray("sessions")
        val list = (0 until sessions.length()).map { i ->
            val s = sessions.getJSONObject(i)
            ChatSummary(s.getString("id"), s.optString("title", "(sin titulo)"), s.optString("workspaceName").ifEmpty { null }, s.optString("updatedAt"))
        }.sortedByDescending { it.updatedAt }
        val byChat = json.getJSONObject("messages")
        val messages = byChat.keys().asSequence().associateWith { chatId ->
            val arr = byChat.getJSONArray(chatId)
            (0 until arr.length()).map { i ->
                val m = arr.getJSONObject(i)
                val attachments = m.optJSONArray("attachments")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).optString("name") } } ?: emptyList()
                ChatMessage(m.getString("id"), m.optString("role"), m.optString("text"), m.optString("createdAt"), attachments)
            }
        }
        _chats.value = list
        _messages.value = messages
        Log.i(TAG, "CHATS: ${list.size} chats leidos (${messages.values.sumOf { it.size }} mensajes)")
        val (pcode, ptext) = transport.request("GET", "/api/v0/projects", mapOf("Authorization" to "Bearer $token"))
        if (pcode == 200) {
            val arr = JSONObject(ptext).getJSONArray("projects")
            _projects.value = (0 until arr.length()).map { arr.getString(it) }
        }
    }

    private fun scheduleRefresh() {
        refreshJob?.cancel()
        refreshJob = scope.launch { delay(1_500); runCatching { refreshChats() } }
    }

    // ---------------------------------------------------------------- stream de eventos (SSE)
    fun startStream() {
        if (streamJob?.isActive == true) return
        streamJob = scope.launch { streamLoop() }
    }

    fun stopStream() {
        streamJob?.cancel()
        streamJob = null
        _link.value = LinkState.STOPPED
    }

    private suspend fun streamLoop() {
        var backoff = 1_000L
        while (kotlin.coroutines.coroutineContext.isActive) {
            val pairing = store.pairing() ?: return
            val token = store.token() ?: return
            val transport = PinnedTransport(pairing.host, pairing.port, pairing.pin)
            try {
                if (_chats.value.isEmpty()) refreshChats()
                val ids = _chats.value.take(50).map { it.id }
                val query = ids.joinToString("&") { "chat=" + URLEncoder.encode(it, "UTF-8") }
                val path = "/api/v0/events" + if (query.isEmpty()) "" else "?$query"
                val headers = mutableMapOf("Authorization" to "Bearer $token", "Accept" to "text/event-stream")
                val resumeFrom = store.lastEventId
                if (resumeFrom != null) {
                    headers["Last-Event-ID"] = resumeFrom
                    Log.i(TAG, "RECONEXION: pidiendo lo posterior a Last-Event-ID=$resumeFrom")
                    _link.value = LinkState.RECONNECTING
                } else {
                    Log.i(TAG, "CONEXION nueva (sin Last-Event-ID)")
                    _link.value = LinkState.CONNECTING
                }
                val conn = transport.open("GET", path, headers, readTimeoutMs = 70_000) // latido cada 25 s: 70 s sin nada = conexion muerta
                val code = conn.responseCode
                if (code == 401) { conn.disconnect(); onRevoked(); return }
                if (code != 200) { conn.disconnect(); throw IOException("HTTP $code") }
                _link.value = LinkState.CONNECTED
                backoff = 1_000L
                readEvents(conn)
                conn.disconnect()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (PinnedTransport.isPinMismatch(e)) {
                    Log.w(TAG, "STREAM: certificado distinto al emparejado -- conexion bloqueada, no se envio el token")
                    _link.value = LinkState.PIN_MISMATCH
                    delay(10_000)
                    continue
                }
                Log.w(TAG, "STREAM cortado: ${e.javaClass.simpleName}: ${e.message}")
                _link.value = LinkState.RECONNECTING
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(15_000L)
        }
    }

    /** Lee eventos hasta que el stream se corta. Un "resync" corta a proposito para volver a pedir la foto. */
    private fun readEvents(conn: HttpURLConnection) {
        val reader = conn.inputStream.bufferedReader(Charsets.UTF_8)
        var id: String? = null
        var event = "message"
        val data = StringBuilder()
        while (true) {
            val line = reader.readLine() ?: return
            if (line.isEmpty()) {
                if (data.isNotEmpty() || event != "message") {
                    if (dispatch(id, event, data.toString())) return
                }
                id = null; event = "message"; data.setLength(0)
                continue
            }
            when {
                line.startsWith(":") -> Unit // latido
                line.startsWith("id: ") -> id = line.substring(4)
                line.startsWith("event: ") -> event = line.substring(7)
                line.startsWith("data: ") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.substring(6)) }
            }
        }
    }

    /** true = la PC pidio "resync": se descarta el Last-Event-ID y se vuelve a conectar desde la foto actual. */
    private fun dispatch(id: String?, event: String, data: String): Boolean {
        when (event) {
            "hello" -> {
                val json = JSONObject(data)
                _activity.value = parseActivity(json.optJSONObject("activity"))
                Log.i(TAG, "HELLO: arranque ${json.optString("bootId")} en la secuencia ${json.optLong("seq")}")
            }
            "resync" -> {
                Log.i(TAG, "RESYNC: la PC no puede reanudar desde ${store.lastEventId} (reinicio o hueco) -- se recarga todo")
                store.lastEventId = null
                runCatching { refreshChats() }
                return true
            }
            "backlog" -> {
                val json = JSONObject(data)
                applyEvent(json.getString("chatId"), json.getString("channel"), json.optJSONObject("payload"), "backlog")
            }
            else -> {
                val json = JSONObject(data)
                val chatId = if (json.isNull("chatId")) null else json.optString("chatId")
                applyEvent(chatId, event, json.optJSONObject("payload"), id)
                if (id != null) store.lastEventId = id
            }
        }
        return false
    }

    private fun parseActivity(chats: JSONObject?): Map<String, ActivityInfo> {
        if (chats == null) return emptyMap()
        return chats.keys().asSequence().associateWith { key ->
            val info = chats.getJSONObject(key)
            ActivityInfo(info.optString("chatTitle", key), info.optLong("startedAt"))
        }
    }

    private fun applyEvent(chatId: String?, channel: String, payload: JSONObject?, id: String?) {
        val method = payload?.optString("method").orEmpty()
        val params = payload?.optJSONObject("params")
        Log.i(TAG, "EVENTO id=$id canal=$channel chat=$chatId metodo=$method delta=${params?.optString("delta").orEmpty()}")
        when (channel) {
            "remote:activity" -> {
                val next = parseActivity(payload?.optJSONObject("chats"))
                val finished = _activity.value.filterKeys { it !in next.keys }
                _activity.value = next
                finished.forEach { (chat, info) -> notifyFinished(chat, info.title) }
            }
            "agent:event" -> {
                if (chatId == null) return
                val current = _live.value[chatId] ?: LiveTurn()
                val updated = when (method) {
                    "turn/started" -> LiveTurn(running = true)
                    "item/agentMessage/delta" -> current.copy(text = current.text + params?.optString("delta").orEmpty())
                    "item/toolCall/status" -> {
                        val name = params?.optString("name").orEmpty()
                        current.copy(status = if (params?.optString("phase") == "start") "Usando $name…" else "$name ${if (params?.optBoolean("ok") == true) "✓" else "✗"}")
                    }
                    "turn/completed", "turn/cancelled" -> {
                        scheduleRefresh()
                        _approvals.value = _approvals.value - chatId
                        current.copy(running = false, status = if (method == "turn/cancelled") "Cancelado en la PC" else null)
                    }
                    else -> current
                }
                _live.value = _live.value + (chatId to updated)
            }
            "agent:toolApproval" -> if (chatId != null) {
                _approvals.value = _approvals.value + (chatId to payload?.optString("title").orEmpty())
            }
            "agent:computerUse", "agent:browserControl", "agent:planMode", "agent:toolTrust" -> if (chatId != null) {
                val active = payload?.optBoolean("active") ?: payload?.optBoolean("enabled") ?: false
                val label = when (channel) {
                    "agent:computerUse" -> "Control de escritorio"
                    "agent:browserControl" -> "Navegador"
                    "agent:planMode" -> "Modo plan"
                    else -> "Confianza de sesion"
                }
                _flags.value = if (active) _flags.value + (chatId to "$label activo en la PC") else _flags.value - chatId
            }
        }
    }

    private fun onRevoked() {
        Log.w(TAG, "REVOCADO: la PC rechazo el token (401) -- se borran las credenciales locales")
        _link.value = LinkState.REVOKED
        store.clear()
        _phase.value = Phase.Failed("Esta PC revoco el acceso de este telefono. Para volver, emparejalo de nuevo.")
    }

    fun forget() {
        stopStream()
        store.clear()
        _chats.value = emptyList(); _messages.value = emptyMap(); _activity.value = emptyMap(); _live.value = emptyMap()
        _approvals.value = emptyMap(); _flags.value = emptyMap(); _projects.value = emptyList()
        _phase.value = Phase.Unpaired
    }

    // ---------------------------------------------------------------- notificaciones
    const val CHANNEL_TURNS = "turnos"
    const val CHANNEL_SERVICE = "conexion"

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_TURNS, "Turnos terminados", NotificationManager.IMPORTANCE_DEFAULT))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_SERVICE, "Conexion con la PC", NotificationManager.IMPORTANCE_LOW))
    }

    private fun notifyFinished(chatId: String, title: String) {
        Log.i(TAG, "NOTIFICACION: termino \"$title\"")
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val notification = NotificationCompat.Builder(context, CHANNEL_TURNS)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("Termino en la PC")
            .setContentText(title)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(chatId.hashCode(), notification)
    }

    private fun sha256Hex(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
