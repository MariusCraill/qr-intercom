package com.qrintercom.resident

import android.content.Context
import android.util.Log
import androidx.work.*

class ServiceKeepAliveWorker(
    context: Context,
    params: WorkerParameters
) : Worker(context, params) {

    companion object {
        private const val TAG = "KeepAlive"
        private const val WORK_NAME = "intercom_keep_alive"

        fun enqueue(context: Context) {
            val request = PeriodicWorkRequestBuilder<ServiceKeepAliveWorker>(
                15, java.util.concurrent.TimeUnit.MINUTES
            ).setConstraints(
                Constraints.Builder()
                    .setRequiresBatteryNotLow(false)
                    .build()
            ).build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
            Log.d(TAG, "Keep-alive work enqueued")
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }

    override fun doWork(): Result {
        val loggedIn = kotlinx.coroutines.runBlocking {
            Prefs.isLoggedIn(applicationContext)
        }
        if (!loggedIn) {
            Log.d(TAG, "Not logged in, skipping")
            return Result.success()
        }

        Log.d(TAG, "Checking service status")
        CallService.start(applicationContext)
        return Result.success()
    }
}
