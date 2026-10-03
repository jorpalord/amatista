package com.amatista.remote

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Credenciales del visor. El TOKEN del dispositivo nunca se guarda en claro: se cifra con AES-256-GCM usando una
 * clave que vive en el Android Keystore (StrongBox si el telefono lo tiene, si no el entorno de ejecucion seguro del
 * procesador) y que no se puede exportar. En SharedPreferences queda solo el texto cifrado + IV.
 * PC emparejada (direccion, puerto, pin, deviceId) y el ultimo id de evento no son secretos.
 */
class SecureStore(context: Context) {
    data class Pairing(val host: String, val port: Int, val pin: String, val deviceId: String)

    private val prefs = context.getSharedPreferences("amatista_remote", Context.MODE_PRIVATE)

    fun savePairing(pairing: Pairing, token: String) {
        prefs.edit()
            .putString("host", pairing.host)
            .putInt("port", pairing.port)
            .putString("pin", pairing.pin)
            .putString("deviceId", pairing.deviceId)
            .putString("token_ct", encrypt(token))
            .remove("lastEventId")
            .apply()
    }

    fun pairing(): Pairing? {
        val host = prefs.getString("host", null) ?: return null
        val pin = prefs.getString("pin", null) ?: return null
        val deviceId = prefs.getString("deviceId", null) ?: return null
        return Pairing(host, prefs.getInt("port", 0), pin, deviceId)
    }

    fun token(): String? = prefs.getString("token_ct", null)?.let { runCatching { decrypt(it) }.getOrNull() }

    var lastEventId: String?
        get() = prefs.getString("lastEventId", null)
        set(value) { prefs.edit().apply { if (value == null) remove("lastEventId") else putString("lastEventId", value) }.apply() }

    /** "Olvidar esta PC": borra todo, incluida la clave del Keystore. */
    fun clear() {
        prefs.edit().clear().apply()
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    /** Nivel de proteccion real de la clave (para la verificacion y la pantalla de estado). */
    fun keyProtection(): String {
        val key = key()
        val info = SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE).getKeySpec(key, KeyInfo::class.java) as KeyInfo
        return if (Build.VERSION.SDK_INT >= 31) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "StrongBox (chip seguro dedicado)"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TEE (entorno seguro del procesador)"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software (sin hardware seguro: tipico de un emulador)"
                else -> "desconocido (${info.securityLevel})"
            }
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) "hardware seguro" else "software"
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun key(): SecretKey {
        (keyStore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
        fun generate(strongBox: Boolean): SecretKey {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .apply { if (Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(strongBox) }
                .build()
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply { init(spec) }.generateKey()
        }
        return if (Build.VERSION.SDK_INT >= 28) {
            try { generate(strongBox = true) } catch (_: StrongBoxUnavailableException) { generate(strongBox = false) }
        } else {
            generate(strongBox = false)
        }
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." + Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val (iv, ct) = stored.split(".").let { Base64.decode(it[0], Base64.NO_WRAP) to Base64.decode(it[1], Base64.NO_WRAP) }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
        return String(cipher.doFinal(ct), Charsets.UTF_8)
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "amatista_remote_token_key"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
