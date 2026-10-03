package com.amatista.remote

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Mantiene vivo el stream de eventos con la app en segundo plano, para avisar cuando un turno termina en la PC.
 * Solo lectura: no hace nada mas que leer eventos.
 */
class ViewerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        RemoteSession.init(applicationContext)
        val notification = NotificationCompat.Builder(this, RemoteSession.CHANNEL_SERVICE)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("Amatista (solo lectura)")
            .setContentText("Siguiendo los chats de la PC emparejada")
            .setOngoing(true)
            .build()
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, 1, notification, type)
        RemoteSession.startStream()
        return START_STICKY
    }
}
