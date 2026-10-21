package com.edjefferson.newsletter;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Lets the page use the volume buttons to turn pages. While enabled (pages mode,
 * setting on), MainActivity swallows volume key presses and reports them here as
 * "pageTurn" events instead of changing the volume.
 */
@CapacitorPlugin(name = "VolumeKeys")
public class VolumeKeysPlugin extends Plugin {
    static volatile boolean enabled = false;
    static VolumeKeysPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        call.resolve();
    }

    void emitPageTurn(int direction) {
        JSObject data = new JSObject();
        data.put("direction", direction);
        notifyListeners("pageTurn", data);
    }
}
