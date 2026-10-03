package com.amatista.remote

import android.Manifest
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        RemoteSession.init(applicationContext)
        handleDebugIntent(intent)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(modifier = Modifier.fillMaxSize()) { ViewerApp(onQrText = ::onQrText) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleDebugIntent(intent)
    }

    private fun onQrText(text: String) {
        val link = PairingLink.parse(text)
        if (link == null) {
            Log.w(TAG, "QR: el contenido no es un QR de emparejamiento de Amatista")
            return
        }
        RemoteSession.startPairing(link, "${Build.MANUFACTURER} ${Build.MODEL}")
    }

    /**
     * Solo en builds de depuracion, para la verificacion automatizada en el emulador (sin camara real):
     * `--es qr_image <archivo>` decodifica una CAPTURA del QR real (dejada en la carpeta propia de la app) con el mismo
     * decodificador que "Elegir una imagen del QR"; `--es qr_text <url>` usa el texto ya leido.
     */
    private fun handleDebugIntent(intent: Intent?) {
        if (!BuildConfig.DEBUG || intent == null) return
        intent.getStringExtra("qr_image")?.let { name ->
            val file = File(getExternalFilesDir(null), name)
            val bitmap = BitmapFactory.decodeFile(file.absolutePath)
            val text = bitmap?.let { QrDecoder.decode(it) }
            Log.i(TAG, "QR (depuracion): imagen ${file.name} ${if (bitmap == null) "no se pudo leer" else "${bitmap.width}x${bitmap.height}"} -> ${if (text == null) "sin QR" else "QR decodificado"}")
            text?.let { onQrText(it) }
        }
        intent.getStringExtra("qr_text")?.let { onQrText(it) }
    }
}

@Composable
private fun ViewerApp(onQrText: (String) -> Unit) {
    val phase by RemoteSession.phase.collectAsState()
    when (phase) {
        is Phase.Paired -> PairedApp()
        else -> PairScreen(phase, onQrText)
    }
}

// ------------------------------------------------------------------------------------------------ emparejar
@Composable
private fun PairScreen(phase: Phase, onQrText: (String) -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scan = rememberLauncherForActivityResult(ScanContract()) { result -> result.contents?.let(onQrText) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        val bitmap = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        bitmap?.let { QrDecoder.decode(it) }?.let(onQrText)
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Amatista", style = MaterialTheme.typography.headlineMedium)
        Text("Ver los chats de tu PC desde el teléfono. Solo lectura: desde acá no se puede enviar, aprobar ni cambiar nada.", color = Color(0xFFB0B0B0))
        when (phase) {
            is Phase.Verifying -> Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.padding(end = 12.dp)); Text(phase.detail)
            }
            is Phase.AwaitingConfirmation -> {
                Text("Confirmá en la PC que ves este mismo código:")
                Text("${phase.sas.take(3)} ${phase.sas.drop(3)}", fontSize = 44.sp, fontFamily = FontFamily.Monospace, color = Color(0xFFF0C48A))
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.padding(end = 12.dp)); Text("Esperando la confirmación en la PC…")
                }
            }
            is Phase.Failed -> {
                Text(phase.message, color = Color(0xFFFF8A80))
                TextButton(onClick = { RemoteSession.resetPairingError() }) { Text("Volver a intentar") }
            }
            else -> {
                Text("En la PC: Configuración → Acceso remoto → Emparejar teléfono. Después escaneá el QR.", color = Color(0xFFB0B0B0))
                Button(onClick = {
                    scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Escaneá el QR que muestra Amatista").setBeepEnabled(false).setOrientationLocked(false))
                }, modifier = Modifier.fillMaxWidth()) { Text("Escanear el QR de Amatista") }
                OutlinedButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, modifier = Modifier.fillMaxWidth()) {
                    Text("Elegir una imagen del QR")
                }
            }
        }
    }
}

// ------------------------------------------------------------------------------------------------ emparejado
@Composable
private fun PairedApp() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        ContextCompat.startForegroundService(context, Intent(context, ViewerService::class.java))
        RemoteSession.startStream()
    }
    var openChat by remember { mutableStateOf<String?>(null) }
    val current = openChat
    if (current == null) ChatListScreen(onOpen = { openChat = it }) else ChatScreen(current, onBack = { openChat = null })
}

@Composable
private fun LinkBadge() {
    val link by RemoteSession.link.collectAsState()
    val (text, color) = when (link) {
        LinkState.CONNECTED -> "● Conectado" to Color(0xFF81C784)
        LinkState.CONNECTING -> "● Conectando…" to Color(0xFFFFD54F)
        LinkState.RECONNECTING -> "● Reconectando…" to Color(0xFFFFD54F)
        LinkState.PIN_MISMATCH -> "● Certificado distinto: conexión bloqueada" to Color(0xFFFF8A80)
        LinkState.REVOKED -> "● Revocado por la PC" to Color(0xFFFF8A80)
        LinkState.STOPPED -> "● Detenido" to Color(0xFF9E9E9E)
    }
    Text(text, color = color, fontSize = 13.sp)
}

@Composable
private fun ChatListScreen(onOpen: (String) -> Unit) {
    val chats by RemoteSession.chats.collectAsState()
    val activity by RemoteSession.activity.collectAsState()
    val approvals by RemoteSession.approvals.collectAsState()
    val projects by RemoteSession.projects.collectAsState()
    val keyProtection by RemoteSession.keyProtection.collectAsState()
    val pc = RemoteSession.pairedPc()
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
        Text("Amatista · solo lectura", style = MaterialTheme.typography.titleLarge)
        LinkBadge()
        Text("PC ${pc?.host}:${pc?.port} · token en Keystore: ${keyProtection ?: "…"}", color = Color(0xFF9E9E9E), fontSize = 12.sp)
        if (projects.isNotEmpty()) Text("Proyectos: ${projects.joinToString(", ")}", color = Color(0xFF9E9E9E), fontSize = 12.sp)
        if (activity.isNotEmpty()) Text("${activity.size} trabajando en la PC ahora", color = Color(0xFFC5935F), modifier = Modifier.padding(top = 6.dp))
        Spacer(Modifier.height(8.dp))
        LazyColumn(Modifier.weight(1f)) {
            items(chats, key = { it.id }) { chat ->
                Column(Modifier.fillMaxWidth().clickable { onOpen(chat.id) }.padding(vertical = 10.dp)) {
                    Text(chat.title, fontWeight = FontWeight.SemiBold)
                    Text(listOfNotNull(chat.project, chat.updatedAt.take(16).replace('T', ' ')).joinToString(" · "), color = Color(0xFF9E9E9E), fontSize = 12.sp)
                    if (activity.containsKey(chat.id)) Text("● trabajando en la PC", color = Color(0xFFC5935F), fontSize = 12.sp)
                    approvals[chat.id]?.let { Text("Aprobación pendiente en la PC: $it", color = Color(0xFFFFD54F), fontSize = 12.sp) }
                }
                HorizontalDivider()
            }
        }
        TextButton(onClick = { RemoteSession.forget() }) { Text("Olvidar esta PC") }
    }
}

@Composable
private fun ChatScreen(chatId: String, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val chats by RemoteSession.chats.collectAsState()
    val messages by RemoteSession.messages.collectAsState()
    val live by RemoteSession.live.collectAsState()
    val approvals by RemoteSession.approvals.collectAsState()
    val flags by RemoteSession.flags.collectAsState()
    val chat = chats.firstOrNull { it.id == chatId }
    val list = messages[chatId].orEmpty()
    val turn = live[chatId]
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("← Chats") }
            Text(chat?.title ?: chatId, style = MaterialTheme.typography.titleMedium)
        }
        LinkBadge()
        flags[chatId]?.let { Text(it, color = Color(0xFFFF8A80), fontSize = 12.sp) }
        approvals[chatId]?.let { Text("Aprobación pendiente en la PC: $it (se responde en la PC)", color = Color(0xFFFFD54F), fontSize = 13.sp) }
        LazyColumn(Modifier.weight(1f).padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(list, key = { it.id }) { message -> MessageBubble(message.role, message.text, message.attachments) }
            if (turn != null && (turn.running || turn.text.isNotEmpty())) {
                item(key = "live") {
                    Column(Modifier.fillMaxWidth().background(Color(0xFF2B2520), RoundedCornerShape(10.dp)).padding(10.dp)) {
                        Text(if (turn.running) "En curso en la PC…" else "Recién terminado (se ve completo cuando la PC lo guarde)", color = Color(0xFFC5935F), fontSize = 12.sp)
                        turn.status?.let { Text(it, color = Color(0xFF9E9E9E), fontSize = 12.sp) }
                        if (turn.text.isNotEmpty()) Text(turn.text)
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(role: String, text: String, attachments: List<String>) {
    val mine = role == "user"
    Column(Modifier.fillMaxWidth().background(if (mine) Color(0xFF26303A) else Color(0xFF242424), RoundedCornerShape(10.dp)).padding(10.dp)) {
        Text(if (mine) "Vos" else if (role == "assistant") "Amatista" else role, color = Color(0xFF9E9E9E), fontSize = 12.sp)
        Text(text)
        if (attachments.isNotEmpty()) Text("Adjuntos: ${attachments.joinToString(", ")}", color = Color(0xFF9E9E9E), fontSize = 12.sp)
    }
}
