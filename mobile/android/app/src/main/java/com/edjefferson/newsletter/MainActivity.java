package com.edjefferson.newsletter;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The app has its own text size setting, so don't also scale text by the
        // system font size (which would make the chosen size meaningless)
        getBridge().getWebView().getSettings().setTextZoom(100);

        // Draw into the camera cutout area, so that with the status bar hidden
        // (full screen) it shows the page background instead of a black band.
        // The page keeps its content clear of the cutout via safe-area insets.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
    }
}
