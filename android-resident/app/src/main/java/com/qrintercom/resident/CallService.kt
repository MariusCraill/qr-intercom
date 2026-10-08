package com.qrintercom.resident

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import okhttp3.*
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CallService : Service() {
    companion object {
        private const val TAG = "CallService"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_INCOMING = "com.qrintercom.resident.SIGNAL"

        var instance: CallService? = null
            private set

        fun start(context: Context) {
            // Android 14 (targetSdk 34) requires RECORD_AUDIO to be granted before
            // promoting a "microphone" foreground service, otherwise startForeground()
            // throws SecurityException and kills the app. Only start once granted.
            val hasMic = ContextCompat.checkSelfPermission(
                context, Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
            if (!hasMic) {
                Log.w(TAG, "RECORD_AUDIO not granted, deferring service start until granted")
                return
            }
            val intent = Intent(context, CallService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallService::class.java))
        }
    }

    private val client = TrustAllCerts.createClient().newBuilder()
        .pingInterval(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var ws: WebSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var residentId: String? = null
    private var token: String? = null
    private var serverHost: String = Urls.BASE
    private var isConnecting = false
    private var healthCheckJob: Job? = null

    var audioCallback: ((ByteArray) -> Unit)? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val selfProbe = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val sendUid = intent.getIntExtra("sender-uid", -1)
            if (sendUid != android.os.Process.myUid()) {
                Log.w(TAG, "SELF-PROBE rejected foreign sender uid=$sendUid")
                return
            }
            val msgStr = intent.getStringExtra("msg")
            Log.w(TAG, "SELF-PROBE received msg=${msgStr?.take(80)} action=${intent.action}")
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        registerNetworkCallback()
        val filter = IntentFilter(ACTION_INCOMING)
        if (Build.VERSION.SDK_INT >= 33) {
            ContextCompat.registerReceiver(this, selfProbe, filter, ContextCompat.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(selfProbe, filter)
        }
        Log.d(TAG, "Service created (self-probe registered)")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            startForeground(NOTIFICATION_ID, buildServiceNotification())
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed (permission revoked?), stopping: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }

        scope.launch {
            residentId = Prefs.getResidentId(this@CallService)
            token = Prefs.getToken(this@CallService)
            serverHost = Prefs.getServer(this@CallService)

            if (residentId == null || token == null) {
                Log.w(TAG, "Missing credentials, stopping")
                stopSelf()
                return@launch
            }

            connectWebSocket()
            startHealthCheck()
        }

        return START_STICKY
    }

    private fun startHealthCheck() {
        healthCheckJob?.cancel()
        healthCheckJob = scope.launch {
            while (isActive) {
                delay(30_000)
                val currentWs = ws
                if (currentWs == null && residentId != null && token != null) {
                    Log.w(TAG, "Health check: WebSocket is null, reconnecting")
                    isConnecting = false
                    connectWebSocket()
                }
            }
        }
    }

    private fun connectWebSocket() {
        if (isConnecting) return
        if (ws != null) return

        isConnecting = true
        val wsUrl = Urls.ws()
        Log.d(TAG, "Connecting to $wsUrl")

        val request = Request.Builder()
            .url(wsUrl)
            .build()

        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "WebSocket connected")
                isConnecting = false
                updateNotification(true)

                val registerMsg = JSONObject().apply {
                    put("type", "register")
                    put("payload", "resident")
                    put("residentId", residentId)
                }
                webSocket.send(registerMsg.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    Log.d(TAG, "RX text len=${text.length} head=${text.take(80)}")
                    val msg = JSONObject(text)
                    handleMessage(msg)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to parse message: $text", e)
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val data = bytes.toByteArray()
                Log.d(TAG, "RX binary len=${data.size} cb=${audioCallback != null} head=${data.take(6).joinToString(","){it.toString()}}")
                audioCallback?.invoke(data) ?: run {
                    val fwdIntent = Intent(ACTION_INCOMING).apply {
                        putExtra("binary", data)
                    }
                    sendBroadcast(fwdIntent)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closing: $code $reason")
                webSocket.close(1000, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}")
                isConnecting = false
                ws = null
                updateNotification(false)
                scope.launch {
                    delay(3000)
                    residentId = Prefs.getResidentId(this@CallService)
                    token = Prefs.getToken(this@CallService)
                    serverHost = Prefs.getServer(this@CallService)
                    if (residentId != null && token != null) {
                        connectWebSocket()
                    }
                }
            }
        })
    }

    private fun handleMessage(msg: JSONObject) {
        when (msg.optString("type")) {
            "call-request" -> {
                val from = msg.optString("from")
                val sessionId = msg.optJSONObject("payload")?.optString("visitorSessionId") ?: from
                Log.d(TAG, "Incoming call from $from")

                val callPendingIntent = PendingIntent.getActivity(
                    this, System.currentTimeMillis().toInt(),
                    Intent(this, IncomingCallActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        putExtra("visitor_id", from)
                        putExtra("session_id", sessionId)
                    },
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                val notification = NotificationCompat.Builder(this, IntercomApp.CHANNEL_CALLS)
                    .setContentTitle("Incoming Call")
                    .setContentText("Visitor calling you")
                    .setSmallIcon(android.R.drawable.ic_menu_call)
                    .setContentIntent(callPendingIntent)
                    .setAutoCancel(true)
                    .setVibrate(longArrayOf(0, 500, 250, 500))
                    .setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE))
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .build()

                val manager = getSystemService(android.app.NotificationManager::class.java)
                manager.notify(System.currentTimeMillis().toInt(), notification)

                val callIntent = Intent(this, IncomingCallActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
putExtra("visitor_id", from)
                        putExtra("session_id", sessionId)
                    }
                    startActivity(callIntent)
            }

            "offer", "ice-candidate", "answer", "call-ended", "call-accepted", "call-declined" -> {
                Log.d(TAG, "Broadcasting ${msg.optString("type")} to $ACTION_INCOMING")
                val fwdIntent = Intent(ACTION_INCOMING).apply {
                    putExtra("msg", msg.toString())
                    putExtra("sender-uid", android.os.Process.myUid())
                }
                val r = sendBroadcast(fwdIntent)
                Log.d(TAG, "sendBroadcast(${msg.optString("type")}) done r=$r")
            }
        }
    }

    fun sendSignal(msg: JSONObject) {
        val text = msg.toString()
        Log.d(TAG, "Sending signal: $text")
        val currentWs = ws
        if (currentWs != null && currentWs.send(text)) {
            Log.d(TAG, "Signal sent successfully")
        } else {
            Log.w(TAG, "Failed to send signal (ws=${currentWs != null})")
        }
    }

    fun sendBinary(data: ByteArray) {
        val currentWs = ws
        if (currentWs != null) {
            currentWs.send(data.toByteString(0, data.size))
        }
    }

    fun isOnline(): Boolean = ws != null

    private fun buildServiceNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, IntercomApp.CHANNEL_SERVICE)
            .setContentTitle(getString(R.string.notification_service_title))
            .setContentText(getString(R.string.notification_service_text))
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(online: Boolean) {
        val text = if (online) getString(R.string.status_online) else getString(R.string.status_offline)
        val notification = NotificationCompat.Builder(this, IntercomApp.CHANNEL_SERVICE)
            .setContentTitle(getString(R.string.notification_service_title))
            .setContentText("Status: $text")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()

        val manager = getSystemService(android.app.NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
    }

    override fun onDestroy() {
        try { unregisterReceiver(selfProbe) } catch (_: Exception) {}
        instance = null
        audioCallback = null
        healthCheckJob?.cancel()
        unregisterNetworkCallback()
        ws?.close(1000, "Service stopped")
        ws = null
        scope.cancel()
        Log.d(TAG, "Service destroyed")
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.d(TAG, "Task removed, scheduling restart")
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            if (residentId != null && token != null) {
                CallService.start(this)
            }
        }, 2000)
    }

    private fun registerNetworkCallback() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.d(TAG, "Network available, checking WebSocket")
                    scope.launch {
                        delay(1000)
                        if (ws == null && residentId != null && token != null) {
                            Log.d(TAG, "Reconnecting after network change")
                            connectWebSocket()
                        }
                    }
                }

                override fun onLost(network: Network) {
                    Log.d(TAG, "Network lost")
                }
            }

            cm.registerNetworkCallback(request, networkCallback!!)
            Log.d(TAG, "Network callback registered")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register network callback", e)
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            if (networkCallback != null) {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.unregisterNetworkCallback(networkCallback!!)
                networkCallback = null
                Log.d(TAG, "Network callback unregistered")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unregister network callback", e)
        }
    }
}
