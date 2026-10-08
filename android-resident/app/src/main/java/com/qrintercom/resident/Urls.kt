package com.qrintercom.resident

/**
 * Central URL construction for the QR Intercom system.
 *
 * The public server is exposed via a Tailscale Funnel at this fixed base URL.
 * All REST, WebSocket (signaling + relayed audio) and visitor links are
 * derived from this single base so the whole app follows the same origin.
 */
object Urls {
    const val BASE = "https://desktop-obtdcvt.tail973ab1.ts.net"

    /** REST endpoint. path is like "/auth/resident-login". */
    fun rest(path: String): String = "$BASE/api$path"

    /** WebSocket (signaling + audio relay) endpoint. */
    fun ws(): String = BASE
        .replaceFirst("https://", "wss://")
        .replaceFirst("http://", "ws://") + "/ws"

    /** Visitor link (rendered into QR codes and the call WebView). */
    fun visitor(residentId: String, extraQuery: String = ""): String {
        var url = "$BASE/visit/$residentId?call=$residentId"
        if (extraQuery.isNotEmpty()) url += "&$extraQuery"
        return url
    }
}
