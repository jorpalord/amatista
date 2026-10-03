package com.amatista.remote

import android.graphics.Bitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer

/** Decodifica un QR desde una imagen (captura de pantalla o foto elegida). La camara usa el lector de zxing-android-embedded. */
object QrDecoder {
    fun decode(bitmap: Bitmap): String? {
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        val reader = MultiFormatReader().apply {
            setHints(mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true))
        }
        return runCatching { reader.decodeWithState(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(width, height, pixels)))).text }.getOrNull()
    }
}
