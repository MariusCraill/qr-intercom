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
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(signalReceiver) } catch (_: Exception) {}
    }
}
