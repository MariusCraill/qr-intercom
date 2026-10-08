package com.qrintercom.resident

import android.Manifest
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.WindowManager
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import org.json.JSONObject

class IncomingCallActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "IncomingCall"
        private const val PERM_REQUEST = 200
    }

    private var visitorId: String? = null
    private var sessionId: String? = null

    private var ringtone: android.media.Ringtone? = null
    private var vibrator: Vibrator? = null
    private val vibratePattern = longArrayOf(0, 500, 250, 500)

    private val signalReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val sendUid = intent.getIntExtra("sender-uid", -1)
            if (sendUid != android.os.Process.myUid()) {
                Log.w(TAG, "Ignoring foreign sender uid=$sendUid")
                return
            }
            val msgStr = intent.getStringExtra("msg") ?: return
            try {
                val msg = JSONObject(msgStr)
                Log.d(TAG, "Received broadcast type=${msg.optString("type")}")
                when (msg.optString("type")) {
                    "call-ended", "call-declined" -> {
                        stopRingtone()
                        finish()
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "RECEIVER-ERR", e)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }

        @Suppress("DEPRECATION")
        val wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "intercom:call")
        wakeLock.acquire(10_000L)

        setContentView(R.layout.activity_incoming_call)

        visitorId = intent.getStringExtra("visitor_id")
        sessionId = intent.getStringExtra("session_id")

        Log.d(TAG, "Incoming call: visitor=$visitorId, session=$sessionId")

        findViewById<TextView>(R.id.textCallerInfo).text = getString(R.string.visitor_calling)

        val btnAccept = findViewById<MaterialButton>(R.id.btnAccept)
        val btnDecline = findViewById<MaterialButton>(R.id.btnDecline)

        btnAccept.setOnClickListener {
            stopRingtone()
            CallService.instance?.sendSignal(JSONObject().apply {
                put("type", "call-accepted")
                put("to", visitorId)
            })
            requestPermissionsAndStartCall()
        }

        btnDecline.setOnClickListener {
            stopRingtone()
            CallService.instance?.sendSignal(JSONObject().apply {
                put("type", "call-declined")
                put("to", visitorId)
            })
            finish()
        }

        startRingtone()
    }

    private fun requestPermissionsAndStartCall() {
        val perms = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.CAMERA)
        }

        if (perms.isEmpty()) {
            launchCallActivity()
        } else {
            Log.d(TAG, "Requesting permissions: $perms")
            ActivityCompat.requestPermissions(this, perms.toTypedArray(), PERM_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST) {
            val granted = grantResults.count { it == PackageManager.PERMISSION_GRANTED }
            Log.d(TAG, "Permissions: $granted/${permissions.size} granted")
            launchCallActivity()
        }
    }

    private fun launchCallActivity() {
        startActivity(Intent(this, NativeCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra("visitor_id", visitorId)
            putExtra("session_id", sessionId)
        })
        finish()
    }

    private fun startRingtone() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(this, uri)
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
        val filter = IntentFilter("com.qrintercom.resident.SIGNAL")
        ContextCompat.registerReceiver(this, signalReceiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(signalReceiver) } catch (_: Exception) {}
    }

    override fun onDestroy() {
        stopRingtone()
        super.onDestroy()
    }
}
