package com.amatista.remote

import java.net.URI
import java.net.URLDecoder

/**
 * Contenido del QR que muestra Amatista: `https://<ip>:<puerto>/pair#c=<codigo>&k=<pin>`.
 * El codigo de un solo uso y el pin (SHA-256 de la clave publica del certificado de la PC, base64url) viajan en el
 * FRAGMENTO (#): la app los lee del QR y nunca los manda en una URL.
 */
data class PairingLink(val host: String, val port: Int, val code: String, val pin: String) {
    companion object {
        private val BASE64URL = Regex("^[A-Za-z0-9_-]{16,64}$")

        fun parse(text: String): PairingLink? {
            val uri = runCatching { URI(text.trim()) }.getOrNull() ?: return null
            if (uri.scheme != "https" || uri.path != "/pair") return null
            val host = uri.host ?: return null
            val port = uri.port.takeIf { it in 1..65535 } ?: return null
            val fragment = uri.rawFragment ?: return null
            val params = fragment.split("&").mapNotNull { part ->
                val i = part.indexOf('=')
                if (i <= 0) null else part.substring(0, i) to URLDecoder.decode(part.substring(i + 1), "UTF-8")
            }.toMap()
            val code = params["c"] ?: return null
            val pin = params["k"] ?: return null
            if (!BASE64URL.matches(code) || !BASE64URL.matches(pin)) return null
            return PairingLink(host, port, code, pin)
        }
    }
}
