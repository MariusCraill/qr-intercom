package com.qrintercom.resident

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * The resident's eWeLink gate device, through the intercom server.
 *
 * eWeLink sign-in, the app secret and the device commands all stay on the
 * server; this only calls /api/ewelink/... with the resident's own login.
 */
object GateApi {
    data class Device(val id: String, val name: String, val online: Boolean, val outlets: List<Int>)
    data class Status(val configured: Boolean, val linked: Boolean, val deviceName: String?)

    class GateException(message: String) : Exception(message)

    private val client = TrustAllCerts.createClient()
    private val json = "application/json".toMediaType()

    private suspend fun request(
        context: Context,
        method: String,
        path: String,
        body: JSONObject? = null,
    ): JSONObject = withContext(Dispatchers.IO) {
        val token = Prefs.getToken(context) ?: throw GateException("Not signed in")
        val builder = Request.Builder()
            .url(Urls.rest(path))
            .header("Authorization", "Bearer $token")
        val reqBody = (body ?: JSONObject()).toString().toRequestBody(json)
        when (method) {
            "GET" -> builder.get()
            "DELETE" -> builder.delete()
            "PUT" -> builder.put(reqBody)
            else -> builder.post(reqBody)
        }
        client.newCall(builder.build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val obj = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
            if (!res.isSuccessful) {
                throw GateException(obj.optString("error").ifEmpty { "Server error (HTTP ${res.code})" })
            }
            obj
        }
    }

    suspend fun status(context: Context): Status {
        val o = request(context, "GET", "/ewelink/status")
        val device = o.optJSONObject("device")
        return Status(
            configured = o.optBoolean("configured"),
            linked = o.optBoolean("linked"),
            deviceName = device?.optString("name")?.takeIf { it.isNotEmpty() },
        )
    }

    /** The eWeLink sign-in page to open in the browser. */
    suspend fun authorizeUrl(context: Context): String =
        request(context, "GET", "/ewelink/authorize-url").getString("url")

    suspend fun devices(context: Context): List<Device> {
        val arr = request(context, "GET", "/ewelink/devices").optJSONArray("devices") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val d = arr.getJSONObject(i)
            val outs = d.optJSONArray("outlets")
            Device(
                id = d.getString("id"),
                name = d.optString("name"),
                online = d.optBoolean("online"),
                outlets = if (outs == null) emptyList() else (0 until outs.length()).map { outs.getInt(it) },
            )
        }
    }

    suspend fun chooseDevice(context: Context, device: Device, outlet: Int?) {
        val name = if (outlet == null) device.name else "${device.name} (channel ${outlet + 1})"
        request(context, "PUT", "/ewelink/device", JSONObject().apply {
            put("id", device.id)
            put("name", name)
            put("outlet", outlet ?: JSONObject.NULL)
        })
    }

    suspend fun disconnect(context: Context) {
        request(context, "DELETE", "/ewelink")
    }

    /** Opens the gate. The server only allows this while a call is up. */
    suspend fun open(context: Context): String =
        request(context, "POST", "/ewelink/open").optString("device")
}
