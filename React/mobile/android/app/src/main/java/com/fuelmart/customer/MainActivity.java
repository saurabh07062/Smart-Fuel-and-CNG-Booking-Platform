package com.fuelmart.customer;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * The FuelMart customer app.
 *
 * The screens are files inside the APK (React/frontend, `npm run
 * build:native`), so the app opens with no network at all: only the DATA --
 * stations, prices, bookings -- needs the server, and the pages themselves
 * say so when it cannot be reached.
 *
 * It used to be a WebView pointed at http://<pc-ip>:5000/app/. That made the
 * server a condition of starting: off the Wi-Fi, or with the backend down,
 * the app showed a blank page or an error before any of its own code ran.
 * The address now lives in the app's own settings (frontend
 * services/api/serverAddress.ts), where it can be changed without a rebuild
 * and without deciding whether the app opens.
 *
 * What is left here is the one thing the web layer cannot do: make the
 * hardware Back button walk back through the app's pages.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && web.canGoBack()) {
                    web.goBack();
                } else {
                    // Nothing left to go back to: leave the app, as Android expects.
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }
}
