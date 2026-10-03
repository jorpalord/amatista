package com.amatista.remote

import android.util.Base64
import android.util.Log
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

const val TAG = "AmatistaRemote"

/** El certificado que presento el servidor NO es el de la PC emparejada (otro equipo, o un intermediario). */
class PinMismatchException(message: String) : CertificateException(message)

/**
 * HTTPS hacia la PC con PINNING de clave publica. Nunca confia en ninguna autoridad publica ni en los certificados
 * del sistema: el unico certificado aceptado es el cuya clave publica (SubjectPublicKeyInfo) tiene el SHA-256 que
 * llego en el QR. La verificacion ocurre DURANTE el handshake TLS, antes de que salga un solo byte del pedido HTTP:
 * contra un impostor, ni el codigo de emparejamiento ni el token llegan a enviarse.
 */
class PinnedTransport(private val host: String, private val port: Int, private val pin: String) {

    private val trustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {
            throw CertificateException("La app no acepta certificados de cliente")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
            if (chain.isEmpty()) throw PinMismatchException("El servidor no presento ningun certificado")
            val actual = spkiPin(chain[0])
            if (!MessageDigest.isEqual(actual.toByteArray(), pin.toByteArray())) {
                Log.w(TAG, "PIN RECHAZADO: el servidor presento $actual y se esperaba $pin -- no se envia nada")
                throw PinMismatchException("El certificado de la PC no coincide con el emparejado")
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private val socketFactory: SSLSocketFactory =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), SecureRandom()) }.socketFactory

    // La identidad la prueba el pin; ademas, el host tiene que ser exactamente el emparejado.
    private val hostnameVerifier = HostnameVerifier { requested, _ -> requested == host }

    fun open(method: String, path: String, headers: Map<String, String> = emptyMap(), body: String? = null, readTimeoutMs: Int = 15_000): HttpsURLConnection {
        val conn = URL("https", host, port, path).openConnection() as HttpsURLConnection
        conn.sslSocketFactory = socketFactory
        conn.hostnameVerifier = hostnameVerifier
        conn.requestMethod = method
        conn.connectTimeout = 8_000
        conn.readTimeout = readTimeoutMs
        conn.useCaches = false
        conn.instanceFollowRedirects = false
        headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }
        return conn
    }

    /** Pedido corto con respuesta JSON: devuelve (codigo HTTP, cuerpo). */
    fun request(method: String, path: String, headers: Map<String, String> = emptyMap(), body: String? = null): Pair<Int, String> {
        val conn = open(method, path, headers, body)
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            return code to text
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        fun spkiPin(cert: X509Certificate): String =
            Base64.encodeToString(
                MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
            )

        /** El pinning fallo en algun punto de la cadena de causas (SSLHandshakeException envuelve la nuestra). */
        fun isPinMismatch(error: Throwable): Boolean {
            var e: Throwable? = error
            while (e != null) {
                if (e is PinMismatchException) return true
                e = e.cause
            }
            return false
        }
    }
}
