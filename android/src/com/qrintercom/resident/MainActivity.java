package com.qrintercom.resident;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

/**
 * Opens the intercom's resident page in a WebView and gives it the camera and
 * microphone. The server address is asked for on first launch.
 *
 * The intercom serves HTTPS with a self-signed certificate, which a WebView
 * rejects outright. Rather than ignore certificate errors (which would let
 * anyone on the Wi-Fi impersonate the server), the app shows the certificate's
 * fingerprint once, remembers it if the user trusts it, and from then on only
 * accepts that exact certificate for that server.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "intercom";
    private static final String KEY_SERVER = "server";
    private static final String KEY_PIN_PREFIX = "pin:";
    private static final String RESIDENT_PATH = "/resident/";
    private static final int REQ_MEDIA = 1;

    private WebView webView;
    private SharedPreferences prefs;
    private PermissionRequest pendingRequest;
    private AlertDialog certDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // A ringing call should not be lost to the screen timing out mid-conversation.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);
        configureWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else if (serverUrl() == null) {
            askForServer(false);
        } else {
            loadResidentPage();
        }
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the resident page keeps its login token in localStorage
        s.setMediaPlaybackRequiresUserGesture(false); // ringtone and remote video autoplay
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            // The String overload: the WebResourceRequest one needs API 24.
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (isOurServer(uri)) return false;
                // Anything that is not the intercom opens in the normal browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // no app can open it
                }
                return true;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handleCertificate(handler, error);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only the configured intercom gets the camera and microphone.
                if (!isOurServer(request.getOrigin())) {
                    request.deny();
                    return;
                }
                if (hasMediaPermissions()) {
                    grantMedia(request);
                } else {
                    pendingRequest = request;
                    requestPermissions(new String[] {
                        Manifest.permission.CAMERA,
                        Manifest.permission.RECORD_AUDIO
                    }, REQ_MEDIA);
                }
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (request == pendingRequest) pendingRequest = null;
            }
        });
    }

    // ---------- server address ----------

    private String serverUrl() {
        return prefs.getString(KEY_SERVER, null);
    }

    private void loadResidentPage() {
        webView.loadUrl(serverUrl() + RESIDENT_PATH);
    }

    private boolean isOurServer(Uri uri) {
        String server = serverUrl();
        if (server == null || uri == null) return false;
        Uri base = Uri.parse(server);
        return eq(base.getScheme(), uri.getScheme())
            && eq(base.getHost(), uri.getHost())
            && effectivePort(base) == effectivePort(uri);
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() != -1) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equalsIgnoreCase(b);
    }

    /** Accepts "192.168.1.20:3143", "https://host:3143/resident/" and the like. */
    static String normalizeServer(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        Uri uri = Uri.parse(s);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        String port = uri.getPort() == -1 ? "" : ":" + uri.getPort();
        return scheme + "://" + uri.getHost() + port;
    }

    private void askForServer(final boolean cancelable) {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://192.168.1.20:3143");
        if (serverUrl() != null) input.setText(serverUrl());

        AlertDialog.Builder b = new AlertDialog.Builder(this)
            .setTitle("Intercom server")
            .setMessage("Enter the HTTPS address shown in the server window (port 3143 by default).")
            .setView(input)
            .setCancelable(cancelable)
            .setPositiveButton("Connect", null);
        if (cancelable) b.setNegativeButton("Cancel", null);

        final AlertDialog dialog = b.create();
        dialog.setOnShowListener(new DialogInterface.OnShowListener() {
            @Override
            public void onShow(DialogInterface d) {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new android.view.View.OnClickListener() {
                    @Override
                    public void onClick(android.view.View v) {
                        String url = normalizeServer(input.getText().toString());
                        if (url == null) {
                            input.setError("Not a valid address");
                            return;
                        }
                        prefs.edit().putString(KEY_SERVER, url).apply();
                        if (url.startsWith("http://")) {
                            Toast.makeText(MainActivity.this,
                                "Camera and microphone only work over HTTPS", Toast.LENGTH_LONG).show();
                        }
                        dialog.dismiss();
                        loadResidentPage();
                    }
                });
            }
        });
        dialog.show();
    }

    // ---------- self-signed certificate pinning ----------

    private void handleCertificate(final SslErrorHandler handler, SslError error) {
        Uri uri = Uri.parse(error.getUrl());
        final String fingerprint = fingerprint(error.getCertificate());
        if (!isOurServer(uri) || fingerprint == null) {
            handler.cancel();
            return;
        }

        final String pinKey = KEY_PIN_PREFIX + uri.getHost() + ":" + effectivePort(uri);
        String pinned = prefs.getString(pinKey, null);
        if (fingerprint.equals(pinned)) {
            handler.proceed();
            return;
        }

        // Several resources can fail at once; ask only once and cancel the rest.
        if (certDialog != null && certDialog.isShowing()) {
            handler.cancel();
            return;
        }

        String message = (pinned == null
            ? "This server uses its own certificate. Check that this fingerprint matches the one on the server before trusting it:\n\n"
            : "WARNING: the server's certificate has CHANGED since you last trusted it. "
                + "Only continue if you regenerated it yourself. New fingerprint:\n\n")
            + fingerprint;

        certDialog = new AlertDialog.Builder(this)
            .setTitle(pinned == null ? "Trust this server?" : "Certificate changed")
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton("Trust", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    prefs.edit().putString(pinKey, fingerprint).apply();
                    handler.proceed();
                    // Other resources were cancelled while the dialog was up.
                    webView.reload();
                }
            })
            .setNegativeButton("Cancel", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface d, int which) {
                    handler.cancel();
                }
            })
            .create();
        certDialog.show();
    }

    /** SHA-256 of the DER certificate, as AA:BB:CC… */
    private static String fingerprint(SslCertificate cert) {
        if (cert == null) return null;
        // saveState is the one way to reach the raw certificate on every API level.
        byte[] der = SslCertificate.saveState(cert).getByteArray("x509-certificate");
        if (der == null) return null;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(der);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format("%02X", digest[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    // ---------- camera / microphone ----------

    private boolean hasMediaPermissions() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private void grantMedia(PermissionRequest request) {
        boolean camera = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        List<String> granted = new ArrayList<String>();
        for (String r : request.getResources()) {
            if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && camera) granted.add(r);
            if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && mic) granted.add(r);
        }
        if (granted.isEmpty()) request.deny();
        else request.grant(granted.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_MEDIA || pendingRequest == null) return;
        PermissionRequest request = pendingRequest;
        pendingRequest = null;
        grantMedia(request);
        if (!hasMediaPermissions()) {
            Toast.makeText(this, "Calls need camera and microphone access", Toast.LENGTH_LONG).show();
        }
    }

    // ---------- menu / lifecycle ----------

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, "Reload");
        menu.add(0, 2, 0, "Change server");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) {
            if (serverUrl() != null) loadResidentPage();
            return true;
        }
        if (item.getItemId() == 2) {
            askForServer(true);
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (certDialog != null) certDialog.dismiss();
        webView.destroy();
        super.onDestroy();
    }
}
