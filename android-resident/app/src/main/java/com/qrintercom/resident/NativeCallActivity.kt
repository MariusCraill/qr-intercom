package com.qrintercom.resident

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.TextureView
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

class NativeCallActivity : AppCompatActivity() {
    companion object {
        private const val TAG = "NativeCall"
        private const val PERMISSION_REQUEST = 300
        private const val SAMPLE_RATE = 16000
        private const val CHANNEL_CONFIG_IN = AudioFormat.CHANNEL_IN_MONO
        private const val CHANNEL_CONFIG_OUT = AudioFormat.CHANNEL_OUT_MONO
        private const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        private const val FRAME_SIZE_MS = 20
        private const val BYTES_PER_SAMPLE = 2
    }

    private var visitorId: String? = null
    private var sessionId: String? = null

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private val isRecording = AtomicBoolean(false)
    private var recordingThread: Thread? = null
    private var txFrames = 0
    private var rxFrames = 0
    private var rxDispatchCount = 0

    private var startTime = 0L
    private val handler = Handler(Looper.getMainLooper())

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null

    private lateinit var imageRemoteVideo: ImageView

    private val durationRunnable = object : Runnable {
        override fun run() {
            if (startTime > 0) {
                val elapsed = ((System.currentTimeMillis() - startTime) / 1000).toInt()
                val min = elapsed / 60
                val sec = elapsed % 60
                findViewById<TextView>(R.id.textDuration).text =
                    String.format("%02d:%02d", min, sec)
                handler.postDelayed(this, 1000)
            }
        }
    }

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
                when (msg.optString("type")) {
                    "call-ended" -> runOnUiThread { finish() }
                }
            } catch (_: Exception) {}
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_native_call)

        visitorId = intent.getStringExtra("visitor_id")
        sessionId = intent.getStringExtra("session_id")
        imageRemoteVideo = findViewById(R.id.imageRemoteVideo)

        Log.d(TAG, "Call: visitor=$visitorId, session=$sessionId")

        findViewById<MaterialButton>(R.id.btnEndCall).setOnClickListener { endCall() }

        val perms = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.CAMERA)
        }

        if (perms.isEmpty()) {
            onReady()
        } else {
            ActivityCompat.requestPermissions(this, perms.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST) {
            onReady()
        }
    }

    private fun onReady() {
        startTime = System.currentTimeMillis()
        handler.post(durationRunnable)
        forceSpeakerphone()
        startAudio()
        forceSpeakerphone()
        startCamera()
    }

    private fun forceSpeakerphone() {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_IN_COMMUNICATION

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val speaker = am.availableCommunicationDevices
                    .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                if (speaker != null) {
                    am.setCommunicationDevice(speaker)
                } else {
                    @Suppress("DEPRECATION")
                    am.isSpeakerphoneOn = true
                }
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = true
            }
            Log.d(TAG, "Speakerphone forced ON (API ${Build.VERSION.SDK_INT})")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to force speakerphone", e)
        }

        handler.postDelayed({
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val speaker = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    if (speaker != null) {
                        am.setCommunicationDevice(speaker)
                    }
                }
            } catch (_: Exception) {}
        }, 700)
    }

    private fun startAudio() {
        val frameSize = SAMPLE_RATE * FRAME_SIZE_MS / 1000
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG_IN, AUDIO_FORMAT)
        val bufferSize = maxOf(minBuf, frameSize * BYTES_PER_SAMPLE * 8)

        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                CHANNEL_CONFIG_IN,
                AUDIO_FORMAT,
                bufferSize
            )

            var aec: AcousticEchoCanceler? = null
            var ns: NoiseSuppressor? = null
            val audioSessionId = audioRecord?.audioSessionId

            try {
                if (audioSessionId != null) {
                    Log.d(TAG, "AEC available=${AcousticEchoCanceler.isAvailable()} NS available=${NoiseSuppressor.isAvailable()} session=$audioSessionId")
                    aec = AcousticEchoCanceler.create(audioSessionId)
                    if (aec != null) {
                        aec.enabled = true
                        Log.d(TAG, "AEC create+enable -> enabled=${aec.enabled}")
                    } else {
                        Log.d(TAG, "AEC create returned null (platform handles, or unsupported)")
                    }
                    ns = NoiseSuppressor.create(audioSessionId)
                    if (ns != null) {
                        ns.enabled = true
                        Log.d(TAG, "NS create+enable -> enabled=${ns.enabled}")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to enable echo/audio effects", e)
            }

            val outBufSize = maxOf(minBuf, frameSize * BYTES_PER_SAMPLE * 12)
            audioTrack = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AUDIO_FORMAT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(CHANNEL_CONFIG_OUT)
                        .build()
                )
                .setSessionId(audioSessionId ?: 0)
                .setBufferSizeInBytes(outBufSize)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            audioRecord?.startRecording()
            audioTrack?.play()
            audioTrack?.setVolume(0.5f)
            try {
                if (aec != null) { aec.enabled = true; Log.d(TAG, "AEC post-start state enabled=${aec.enabled}") }
                if (ns != null) { ns.enabled = true; Log.d(TAG, "NS post-start state enabled=${ns.enabled}") }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to re-assert echo/audio effects", e)
            }
            isRecording.set(true)

            recordingThread = Thread({
                val frameBytes = frameSize * BYTES_PER_SAMPLE
                val pcm = ByteArray(frameBytes)
                while (isRecording.get()) {
                    val read = audioRecord?.read(pcm, 0, frameBytes) ?: 0
                    if (read > 0) {
                        val shortCount = read / BYTES_PER_SAMPLE
                        val shortBuf = java.nio.ByteBuffer.wrap(pcm, 0, read)
                            .order(java.nio.ByteOrder.LITTLE_ENDIAN)
                            .asShortBuffer()
                        for (i in 0 until shortCount) {
                            val s = shortBuf.get(i).toInt()
                            val g = (s * 3) / 2
                            shortBuf.put(
                                i,
                                (if (g > 32767) 32767 else if (g < -32768) -32768 else g).toShort()
                            )
                        }
                        val framed = ByteArray(read + 1)
                        framed[0] = 0x00
                        System.arraycopy(pcm, 0, framed, 1, read)
                        CallService.instance?.sendBinary(framed)
                        txFrames++
                        if (txFrames % 100 == 0) Log.d(TAG, "TX audio frames=$txFrames ($read B/frame)")
                    }
                }
            }, "AudioRecord-Thread").also { it.start() }

            CallService.instance?.audioCallback = { data -> handleIncomingBinary(data) }

            Log.d(TAG, "Audio started (frame=${frameSize * BYTES_PER_SAMPLE}b/20ms)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start audio", e)
        }
    }

    private fun handleIncomingBinary(data: ByteArray) {
        if (data.isEmpty()) return
        val type = data[0]
        val payload = data.copyOfRange(1, data.size)
        rxDispatchCount++
        if (rxDispatchCount % 100 == 0) Log.d(TAG, "RX dispatch=$rxDispatchCount bytes=${data.size} type=$type")
        when (type) {
            0x00.toByte() -> playAudio(payload)
            0x01.toByte() -> showVideoFrame(payload)
        }
    }

    private fun playAudio(data: ByteArray) {
        val shortCount = data.size / BYTES_PER_SAMPLE
        if (shortCount == 0) return
        val shorts = ShortArray(shortCount)
        for (i in 0 until shortCount) {
            shorts[i] = ((data[i * 2 + 1].toInt() shl 8) or (data[i * 2].toInt() and 0xFF)).toShort()
        }
        try {
            audioTrack?.write(shorts, 0, shortCount)
            rxFrames++
            if (rxFrames % 100 == 0) Log.d(TAG, "RX audio frames=$rxFrames ($shortCount samples)")
        } catch (e: Exception) {
            Log.e(TAG, "AudioTrack write failed", e)
        }
    }

    private fun showVideoFrame(jpegData: ByteArray) {
        try {
            val bitmap = BitmapFactory.decodeByteArray(jpegData, 0, jpegData.size)
            if (bitmap != null) {
                runOnUiThread {
                    imageRemoteVideo.setImageBitmap(bitmap)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decode video frame", e)
        }
    }

    @Suppress("DEPRECATION")
    private fun startCamera() {
        val textureView = findViewById<TextureView>(R.id.textureView) ?: return
        textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(surface: SurfaceTexture, w: Int, h: Int) {
                openCamera(surface)
            }
            override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, w: Int, h: Int) {}
            override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean { return true }
            override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
        }
        if (textureView.isAvailable) {
            val st = textureView.surfaceTexture
            if (st != null) openCamera(st)
        }
    }

    private fun openCamera(surfaceTexture: SurfaceTexture) {
        try {
            val cameraManager = getSystemService(CAMERA_SERVICE) as CameraManager
            val cameraId = cameraManager.cameraIdList.firstOrNull { id ->
                val chars = cameraManager.getCameraCharacteristics(id)
                chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
            } ?: cameraManager.cameraIdList.firstOrNull() ?: return

            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                return
            }

            val size = cameraManager.getCameraCharacteristics(cameraId)
                .get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?.getOutputSizes(SurfaceTexture::class.java)
                ?.firstOrNull { it.width <= 640 } ?: android.util.Size(640, 480)

            surfaceTexture.setDefaultBufferSize(size.width, size.height)
            val surface = Surface(surfaceTexture)

            cameraManager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    try {
                        val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                            addTarget(surface)
                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
                        }
                        camera.createCaptureSession(
                            listOf(surface),
                            object : CameraCaptureSession.StateCallback() {
                                override fun onConfigured(session: CameraCaptureSession) {
                                    captureSession = session
                                    session.setRepeatingRequest(request.build(), null, null)
                                }
                                override fun onConfigureFailed(session: CameraCaptureSession) {
                                    Log.e(TAG, "Camera config failed")
                                }
                            },
                            null
                        )
                    } catch (e: Exception) {
                        Log.e(TAG, "Camera setup failed", e)
                    }
                }
                override fun onDisconnected(camera: CameraDevice) { camera.close() }
                override fun onError(camera: CameraDevice, error: Int) { camera.close() }
            }, null)
        } catch (e: Exception) {
            Log.e(TAG, "Camera open failed", e)
        }
    }

    private fun endCall() {
        CallService.instance?.sendSignal(JSONObject().apply {
            put("type", "call-ended")
            put("to", visitorId)
        })
        finish()
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter("com.qrintercom.resident.SIGNAL")
        ContextCompat.registerReceiver(this, signalReceiver, filter, ContextCompat.RECEIVER_EXPORTED)
        CallService.instance?.audioCallback = { data -> handleIncomingBinary(data) }
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(signalReceiver) } catch (_: Exception) {}
    }

    override fun onDestroy() {
        handler.removeCallbacks(durationRunnable)
        isRecording.set(false)
        recordingThread?.join(500)

        try { audioRecord?.stop(); audioRecord?.release() } catch (_: Exception) {}
        try { audioTrack?.stop(); audioTrack?.release() } catch (_: Exception) {}
        audioRecord = null
        audioTrack = null

        try { captureSession?.close() } catch (_: Exception) {}
        try { cameraDevice?.close() } catch (_: Exception) {}
        captureSession = null
        cameraDevice = null

        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audioManager.mode = AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
        } catch (_: Exception) {}
        CallService.instance?.audioCallback = null
        Log.d(TAG, "Call activity destroyed")
        super.onDestroy()
    }
}
