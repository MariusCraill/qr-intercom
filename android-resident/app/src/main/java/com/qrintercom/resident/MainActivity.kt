package com.qrintercom.resident

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {
    companion object {
        private const val PERM_REQUEST = 200
    }

    private lateinit var textName: TextView
    private lateinit var textUnit: TextView
    private lateinit var chipStatus: Chip
    private lateinit var layoutIdle: LinearLayout
    private lateinit var layoutCallActive: LinearLayout
    private lateinit var textCallerInfo: TextView
    private lateinit var btnEndCall: MaterialButton
    private lateinit var btnLogout: MaterialButton
    private lateinit var qrContainer: LinearLayout
    private lateinit var imageQr: ImageView
    private lateinit var textQrAddress: TextView
    private lateinit var btnGateDevice: MaterialButton
    private lateinit var textGateInfo: TextView

    /** Set while the eWeLink sign-in page is open in the browser. */
    private var awaitingEwelinkSignIn = false
    private var gateStatus: GateApi.Status? = null

    private val signalReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val msgStr = intent.getStringExtra("msg") ?: return
            try {
                val msg = JSONObject(msgStr)
                when (msg.optString("type")) {
                    "call-request" -> {
                        layoutIdle.visibility = LinearLayout.GONE
                        layoutCallActive.visibility = LinearLayout.VISIBLE
                        textCallerInfo.text = getString(R.string.visitor_calling)
                    }
                    "call-ended", "call-declined" -> {
                        layoutIdle.visibility = LinearLayout.VISIBLE
                        layoutCallActive.visibility = LinearLayout.GONE
                    }
                }
            } catch (_: Exception) {}
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        textName = findViewById(R.id.textResidentName)
        textUnit = findViewById(R.id.textResidentUnit)
        chipStatus = findViewById(R.id.chipStatus)
        layoutIdle = findViewById(R.id.layoutIdle)
        layoutCallActive = findViewById(R.id.layoutCallActive)
        textCallerInfo = findViewById(R.id.textCallerInfo)
        btnEndCall = findViewById(R.id.btnEndCall)
        btnLogout = findViewById(R.id.btnLogout)
        qrContainer = findViewById(R.id.qrContainer)
        imageQr = findViewById(R.id.imageQr)
        textQrAddress = findViewById(R.id.textQrAddress)

        val btnShareQr = findViewById<Button>(R.id.btnShareQr)
        btnShareQr.setOnClickListener { shareQrCode() }

        lifecycleScope.launch {
            val name = Prefs.getResidentName(this@MainActivity) ?: ""
            val unit = Prefs.getResidentUnit(this@MainActivity) ?: ""
            textName.text = name
            textUnit.text = "Address: $unit"
            chipStatus.text = getString(R.string.status_online)
        }

        textName.setOnClickListener { showQrCode() }
        qrContainer.setOnClickListener { qrContainer.visibility = View.GONE }

        btnGateDevice = findViewById(R.id.btnGateDevice)
        textGateInfo = findViewById(R.id.textGateInfo)
        btnGateDevice.setOnClickListener { onGateDeviceClicked() }
        findViewById<MaterialButton>(R.id.btnShowQr).setOnClickListener { showQrCode() }

        btnLogout.setOnClickListener {
            CallService.stop(this)
            lifecycleScope.launch { Prefs.clear(this@MainActivity) }
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
        }

        requestCallPermissions()
    }

    private fun showQrCode() {
        lifecycleScope.launch {
            val residentId = Prefs.getResidentId(this@MainActivity)
            val unit = Prefs.getResidentUnit(this@MainActivity).orEmpty()
            if (residentId != null) {
                val url = Urls.visitor(residentId)
                val bitmap = QRCodeUtils.generate(url, 360)
                if (bitmap != null) {
                    currentQrBitmap = bitmap
                    imageQr.setImageBitmap(bitmap)
                    textQrAddress.text = "Address: $unit"
                    qrContainer.visibility = View.VISIBLE
                }
            }
        }
    }

    private var currentQrBitmap: android.graphics.Bitmap? = null

    private fun shareQrCode() {
        val bitmap = currentQrBitmap ?: return
        lifecycleScope.launch {
            val uri = withContext(Dispatchers.IO) {
                try {
                    val dir = File(cacheDir, "qr_share")
                    if (!dir.exists()) dir.mkdirs()
                    val file = File(dir, "qr_intercom.png")
                    FileOutputStream(file).use { out ->
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)
                    }
                    FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
                } catch (e: Exception) {
                    null
                }
            }
            if (uri == null) {
                Toast.makeText(this@MainActivity, "Could not create share image", Toast.LENGTH_SHORT).show()
                return@launch
            }
            val share = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(share, "Share QR code"))
        }
    }

    private fun requestCallPermissions() {
        val perms = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.CAMERA)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (perms.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, perms.toTypedArray(), PERM_REQUEST)
        } else {
            startServiceAfterPermission()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERM_REQUEST) {
            startServiceAfterPermission()
        }
    }

    private fun startServiceAfterPermission() {
        val micGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (micGranted) {
            CallService.start(this)
        }
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter("com.qrintercom.resident.SIGNAL")
        ContextCompat.registerReceiver(this, signalReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        refreshGateStatus()
    }

    // ── eWeLink gate device ──────────────────────────────────────────

    private fun refreshGateStatus() {
        lifecycleScope.launch {
            val status = try { GateApi.status(this@MainActivity) } catch (_: Exception) { null }
            gateStatus = status
            // The section always shows, so it is clear why the button is or is
            // not usable, instead of silently disappearing.
            val (info, label, enabled) = when {
                status == null -> Triple("Couldn't reach the intercom server.", "Try again", true)
                !status.configured -> Triple(
                    "Not available yet: your building admin still has to switch on eWeLink for the intercom.",
                    "Connect eWeLink", false)
                !status.linked -> Triple(
                    "Connect your eWeLink account and choose the device that opens your gate. " +
                        "During a call you'll get an Open Gate button.",
                    "Connect eWeLink", true)
                status.deviceName == null -> Triple(
                    "eWeLink is connected. Choose the device that opens your gate.",
                    "Choose gate device", true)
                else -> Triple(
                    "Calls show an Open Gate button that switches on \"${status.deviceName}\".",
                    "Change gate device", true)
            }
            textGateInfo.text = info
            btnGateDevice.text = label
            btnGateDevice.isEnabled = enabled
            // Back from the eWeLink sign-in page: go straight to picking a device.
            if (awaitingEwelinkSignIn && status?.linked == true) {
                awaitingEwelinkSignIn = false
                pickGateDevice()
            }
        }
    }

    private fun onGateDeviceClicked() {
        val status = gateStatus
        when {
            status == null -> refreshGateStatus()
            !status.configured -> Unit
            !status.linked -> startEwelinkSignIn()
            status.deviceName == null -> pickGateDevice()
            else -> androidx.appcompat.app.AlertDialog.Builder(this)
                .setTitle("Gate device")
                .setMessage("Calls show an Open Gate button that switches on \"${status.deviceName}\".")
                .setPositiveButton("Change device") { _, _ -> pickGateDevice() }
                .setNeutralButton("Disconnect eWeLink") { _, _ -> disconnectEwelink() }
                .setNegativeButton("Close", null)
                .show()
        }
    }

    /** eWeLink's own sign-in page, in the browser: the password never touches this app. */
    private fun startEwelinkSignIn() {
        lifecycleScope.launch {
            try {
                val url = GateApi.authorizeUrl(this@MainActivity)
                awaitingEwelinkSignIn = true
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun pickGateDevice() {
        lifecycleScope.launch {
            val devices = try {
                GateApi.devices(this@MainActivity)
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
                return@launch
            }
            if (devices.isEmpty()) {
                Toast.makeText(this@MainActivity, "No devices on this eWeLink account", Toast.LENGTH_LONG).show()
                return@launch
            }
            // One entry per channel of a multi-channel relay, so the right one is chosen.
            val choices = devices.flatMap { d ->
                if (d.outlets.size <= 1) listOf(d to null as Int?)
                else d.outlets.map { d to it as Int? }
            }
            val labels = choices.map { (d, outlet) ->
                val name = if (outlet == null) d.name else "${d.name} – channel ${outlet + 1}"
                if (d.online) name else "$name (offline)"
            }.toTypedArray()
            androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                .setTitle("Which device opens your gate?")
                .setItems(labels) { _, which ->
                    val (device, outlet) = choices[which]
                    lifecycleScope.launch {
                        try {
                            GateApi.chooseDevice(this@MainActivity, device, outlet)
                            Toast.makeText(this@MainActivity, "Gate device saved", Toast.LENGTH_SHORT).show()
                        } catch (e: Exception) {
                            Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
                        }
                        refreshGateStatus()
                    }
                }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    private fun disconnectEwelink() {
        lifecycleScope.launch {
            try {
                GateApi.disconnect(this@MainActivity)
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            }
            refreshGateStatus()
        }
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(signalReceiver) } catch (_: Exception) {}
    }
}
