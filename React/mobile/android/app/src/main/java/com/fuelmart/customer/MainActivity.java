package com.fuelmart.customer;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;

/**
 * The FuelMart customer app: a WebView on the backend's /app pages.
 *
 * The server address is a setting, not something built into the APK. The
 * PC running the backend gets a new IP whenever it joins another Wi-Fi or
 * hotspot; the saved address is used first (falling back to the one in
 * capacitor.config.json), and when the page cannot be loaded the app offers
 * "Retry" or "Change server" instead of the WebView's bare error page.
 *
 * The address is handed to Capacitor as its server URL before the bridge
 * starts, so the native plugins (GPS) work on those pages as before.
 */
public class MainActivity extends BridgeActivity {

    private static final String PREFS = "fuelmart";
    private static final String KEY_SERVER = "server";
    private static final String APP_PATH = "/app/";
    private static final int DEFAULT_PORT = 5000;

    private AlertDialog errorDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        config = new CapConfig.Builder(this).setServerUrl(serverBase() + APP_PATH).create();
        super.onCreate(savedInstanceState);

        Bridge b = getBridge();
        if (b != null) b.setWebViewClient(new PageErrorClient(b));

        // Back goes back through the app's pages; only on the first page does it leave.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && web.canGoBack()) {
                    web.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }

    /** "http://host:port" -- the saved server, else the one the APK was built with. */
    private String serverBase() {
        String saved = prefs().getString(KEY_SERVER, null);
        if (saved != null) return saved;
        String built = CapConfig.loadDefault(this).getServerUrl();
        String normal = built != null ? normalise(built) : null;
        return normal != null ? normal : "http://10.0.2.2:" + DEFAULT_PORT;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /**
     * What a person types -> "http://host:port", or null if it is not an address.
     * "10.1.2.3" -> http://10.1.2.3:5000, "10.1.2.3:8080" -> http://10.1.2.3:8080,
     * "https://fuel.example.com" -> https://fuel.example.com (a path is dropped).
     */
    static String normalise(String input) {
        if (input == null) return null;
        String text = input.trim();
        if (text.isEmpty()) return null;
        if (!text.matches("(?i)^https?://.*")) text = "http://" + text;
        java.net.URI uri;
        try {
            uri = new java.net.URI(text);
        } catch (java.net.URISyntaxException e) {
            return null;
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        String scheme = uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        int port = uri.getPort();
        // Plain http without a port means the backend's own port; https keeps its default.
        if (port == -1 && scheme.equals("http")) port = DEFAULT_PORT;
        return scheme + "://" + host + (port == -1 ? "" : ":" + port);
    }

    /** Only a failure to load the page itself counts; a missing image or map tile does not. */
    private class PageErrorClient extends BridgeWebViewClient {
        PageErrorClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) showServerError();
        }
    }

    private void showServerError() {
        if (isFinishing() || (errorDialog != null && errorDialog.isShowing())) return;
        errorDialog = new AlertDialog.Builder(this)
            .setTitle("Can't reach FuelMart")
            .setMessage(
                "The app could not connect to " + serverBase() + ".\n\n" +
                "Check that the phone and the FuelMart server are on the same Wi-Fi and the server is running."
            )
            .setCancelable(false)
            .setPositiveButton("Retry", (d, w) -> reloadApp())
            .setNeutralButton("Change server", (d, w) -> askForServer())
            .show();
    }

    private void askForServer() {
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("e.g. 192.168.1.20 or 192.168.1.20:5000");
        field.setText(serverBase().replaceFirst("^http://", ""));
        field.setSelectAllOnFocus(true);
        FrameLayout box = new FrameLayout(this);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(field);

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("FuelMart server address")
            .setMessage("The IP address of the PC running the FuelMart backend (run ipconfig on that PC).")
            .setView(box)
            .setCancelable(false)
            .setPositiveButton("Connect", null)
            .setNegativeButton("Back", (d, w) -> showServerError())
            .create();
        dialog.setOnShowListener(d ->
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String base = normalise(field.getText().toString());
                if (base == null) {
                    field.setError("Enter an address like 192.168.1.20");
                    return;
                }
                prefs().edit().putString(KEY_SERVER, base).apply();
                dialog.dismiss();
                // The server URL is fixed when the bridge starts: restart the screen with the new one.
                recreate();
            })
        );
        dialog.show();
    }

    private void reloadApp() {
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web != null) web.loadUrl(serverBase() + APP_PATH);
    }
}
