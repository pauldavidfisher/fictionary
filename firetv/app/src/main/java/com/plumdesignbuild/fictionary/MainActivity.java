package com.plumdesignbuild.fictionary;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Fictionary for Fire TV: shows the game's TV screen full-screen.
 * The game itself runs on the website; players still use their phones.
 */
public class MainActivity extends Activity {

    private WebView web;
    private String gameUrl;
    private boolean showingOffline = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        gameUrl = getString(R.string.game_url);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(28, 42, 107));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);           // remembers which game this TV was showing
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " FictionaryTV/1.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false;                   // keep every page inside the app
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (url != null && url.startsWith("http")) showingOffline = false;
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showOffline();                  // called for the main page only
            }
        });

        setContentView(web);
        web.requestFocus();
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(gameUrl);
        }
    }

    private void showOffline() {
        if (showingOffline) return;
        showingOffline = true;
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width'>"
            + "<style>html{font-size:2.2vw}body{margin:0;height:100vh;display:flex;flex-direction:column;"
            + "align-items:center;justify-content:center;gap:1.5rem;background:#1c2a6b;color:#fff;"
            + "font-family:Georgia,serif;text-align:center;padding:0 8vw}h1{font-size:3.5rem;margin:0}"
            + "h1 span{color:#ffc23d}p{font-family:sans-serif;color:#a9b3e6;font-size:1.3rem;margin:0}"
            + "button{font:700 1.4rem sans-serif;background:#ffc23d;color:#2a1f00;border:0;border-radius:12px;"
            + "padding:.8em 1.6em}button:focus{outline:4px solid #fff;outline-offset:4px}</style></head><body>"
            + "<h1>Fiction<span>ary</span></h1>"
            + "<p>Can't reach the game right now. Check that this Fire TV is online, then try again.</p>"
            + "<button id='b' autofocus onclick=\"location.href='" + gameUrl + "'\">Try again</button>"
            + "<script>document.getElementById('b').focus()</script></body></html>";
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (showingOffline) {
                finish();
                return true;
            }
            if (web.canGoBack()) {
                web.goBack();
                return true;
            }
        }
        if (keyCode == KeyEvent.KEYCODE_MENU) {    // the ☰ button reloads the game
            showingOffline = false;
            web.loadUrl(gameUrl);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && Build.VERSION.SDK_INT >= 19) {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
