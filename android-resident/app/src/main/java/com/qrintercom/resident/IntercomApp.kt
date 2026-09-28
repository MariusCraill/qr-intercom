package com.qrintercom.resident

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class IntercomApp : Application() {
    companion object {
        const val CHANNEL_CALLS = "incoming_calls"
        const val CHANNEL_SERVICE = "service"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        ServiceKeepAliveWorker.enqueue(this)
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        val callsChannel = NotificationChannel(
            CHANNEL_CALLS,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = getString(R.string.notification_channel_desc)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 500, 250, 500)
            setShowBadge(true)
        }

        val serviceChannel = NotificationChannel(
            CHANNEL_SERVICE,
            getString(R.string.notification_service_title),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Background call listener"
            setShowBadge(false)
        }

        manager.createNotificationChannels(listOf(callsChannel, serviceChannel))
    }
}
