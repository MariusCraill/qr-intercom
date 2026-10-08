package com.qrintercom.resident

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.View
import android.webkit.*
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class WebViewCallActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "WebViewCall"
        private const val PERMISSION_REQUEST = 100
    }

    private lateinit var webView: WebView
    private lateinit var textStatus: TextView
    private lateinit var btnEndCall: MaterialButton
    private lateinit var progressLoading: ProgressBar

    private var visitorId: String? = null
    private var sessionId: String? = null
    private var pageLoaded = false
    private val pendingSignals = mutableListOf<Pair<String, String>>()

    private var ringtone: android.media.Ringtone? = null
    private var vibrator: Vibrator? = null
    private val vibratePattern = longArrayOf(0, 500, 250, 500)

    private val signalReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            try {
                val sendUid = intent.getIntExtra("sender-uid", -1)
                if (sendUid != android.os.Process.myUid()) {
                    Log.w(TAG, "Ignoring foreign sender uid=$sendUid action=${intent.action}")
                    return
                }
                val msgStr = intent.getStringExtra("msg")
                if (msgStr == null) {
                    Log.w(TAG, "RECEIVER-CALLED no-msg-extra action=${intent.action}")
                    return
                }
                val msg = JSONObject(msgStr)
                Log.d(TAG, "Received broadcast type=${msg.optString("type")} active=$pageLoaded")
                when (msg.optString("type")) {
                    "call-ended" -> {
                        stopRingtone()
                        finish()
                    }
                    "call-accepted" -> {
                        Log.d(TAG, "Forwarding call-accepted to WebView")
                        forwardToWebView("call-accepted", msg)
                    }
                    "call-declined" -> {
                        Log.d(TAG, "Forwarding call-declined to WebView")
                        forwardToWebView("call-declined", msg)
                    }
                    "offer" -> {
                        Log.d(TAG, "Forwarding offer to WebView")
                        forwardToWebView("offer", msg)
                    }
                    "answer" -> {
                        Log.d(TAG, "Forwarding answer to WebView")
                        forwardToWebView("answer", msg)
                    }
                    "ice-candidate" -> {
                        forwardToWebView("ice-candidate", msg)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "RECEIVER-ERR", e)
            }
        }
    }

    private fun forwardToWebView(type: String, msg: JSONObject) {
        val json = msg.toString()
        val encoded = android.util.Base64.encodeToString(json.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP)
        if (!pageLoaded) {
            Log.d(TAG, "Page not loaded yet, buffering signal: $type")
            pendingSignals.add(Pair(type, encoded))
            return
        }
        deliverToWebView(type, encoded)
    }

    private fun deliverToWebView(type: String, encodedJson: String) {
        val js = "javascript:window.handleNativeSignal && window.handleNativeSignal('$type', atob('$encodedJson'))"
        runOnUiThread {
            webView.evaluateJavascript(js, null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_webview_call)

        webView = findViewById(R.id.webView)
        textStatus = findViewById(R.id.textCallStatus)
        btnEndCall = findViewById(R.id.btnEndCall)
        progressLoading = findViewById(R.id.progressLoading)

        visitorId = intent.getStringExtra("visitor_id")
        sessionId = intent.getStringExtra("session_id")

        Log.d(TAG, "Call: visitor=$visitorId, session=$sessionId")

        btnEndCall.setOnClickListener {
            CallService.instance?.sendSignal(JSONObject().apply {
                put("type", "call-ended")
                put("to", visitorId)
            })
            stopRingtone()
            finish()
        }

        setupWebView()

        val perms = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.CAMERA)
        }

        if (perms.isEmpty()) {
            onPermissionsReady()
        } else {
            ActivityCompat.requestPermissions(this, perms.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST) {
            onPermissionsReady()
        }
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            mediaPlaybackRequiresUserGesture = false
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            databaseEnabled = true
            setSupportMultipleWindows(false)
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        webView.addJavascriptInterface(CallBridge(), "AndroidBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.d(TAG, "Page finished: $url")
                progressLoading.visibility = View.GONE
                pageLoaded = true
                forceSpeakerphone()
                for ((type, encoded) in pendingSignals) {
                    Log.d(TAG, "Delivering buffered signal: $type")
                    deliverToWebView(type, encoded)
                }
                pendingSignals.clear()
                // Start media only after the page is fully interactive; doing it
                // earlier yields NotReadableError on WebView/Samsung (mic busy).
                startResidentMedia()
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: android.net.http.SslError?) {
                // If the dev CA is trusted via network_security_config this must NOT fire.
                // When it fires, getUserMedia is blocked because the origin is not secure.
                Log.e(TAG, "SslError on ${error?.url}: ${error?.primaryError} ${error?.certificate}")
                handler?.proceed()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                Log.d(TAG, "onPermissionRequest: ${request?.resources?.toList()}")
                runOnUiThread {
                    request?.grant(request.resources)
                }
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d(TAG, "JS: ${consoleMessage?.message()} [${consoleMessage?.messageLevel()}]")
                return true
            }
        }
    }

    inner class CallBridge {
        @JavascriptInterface
        fun sendSignal(json: String) {
            try {
                val msg = JSONObject(json)
                Log.d(TAG, "Bridge sendSignal: ${msg.optString("type")}")
                CallService.instance?.sendSignal(msg)
            } catch (e: Exception) {
                Log.e(TAG, "Bridge sendSignal failed", e)
            }
        }
    }

    private fun forceSpeakerphone() {
        // Deliberately does NOT touch AudioManager modes. Setting
        // MODE_IN_COMMUNICATION / setCommunicationDevice during a WebView call
        // makes getUserMedia fail with NotReadableError on Samsung devices
        // (mic path gets locked to the call audio device set). Loudspeaker
        // routing for the WebRTC stream is handled in JS via remoteAudio.setSinkId().
    }

    private fun onPermissionsReady() {
        // Call was already accepted in IncomingCallActivity — do not ring again.
        forceSpeakerphone()
        loadCallPage()
    }

    private fun loadCallPage() {
        lifecycleScope.launch {
            val residentId = Prefs.getResidentId(this@WebViewCallActivity) ?: visitorId ?: ""
            val url = Urls.visitor(
                residentId,
                "session=$visitorId&android=1&audioOnly=1&nativeBridge=1"
            )
            Log.d(TAG, "Loading: $url")
            webView.loadUrl(url)
        }
    }

    private fun startResidentMedia() {
        // Retried/re-triggered from the page itself (guard inside JS).
        webView.postDelayed({
            webView.evaluateJavascript("javascript:window.startResidentMedia && window.startResidentMedia()", null)
        }, 300)
    }

    private fun startRingtone() {
        try {
            val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(this, ringtoneUri)
            ringtone?.audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            ringtone?.play()

            vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(VIBRATOR_SERVICE) as Vibrator
            }
            vibrator?.vibrate(VibrationEffect.createWaveform(vibratePattern, 0))
        } catch (e: Exception) {
            Log.e(TAG, "Ringtone failed", e)
        }
    }

    private fun stopRingtone() {
        ringtone?.stop()
        ringtone = null
        vibrator?.cancel()
        vibrator = null
    }

    override fun onResume() {
        super.onResume()
        forceSpeakerphone()
        if (pageLoaded) startResidentMedia()
        val filter = IntentFilter("com.qrintercom.resident.SIGNAL")
        ContextCompat.registerReceiver(this, signalReceiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(signalReceiver) } catch (_: Exception) {}
    }

    override fun onDestroy() {
        stopRingtone()
        webView.destroy()
        super.onDestroy()
    }
}
