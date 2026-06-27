package io.aolabs.bloodbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return

        if (BloodBridgeSync.token(context).isBlank()) return
        BloodBridgeSync.scheduleAutoSync(context)

        if (BloodBridgeSync.isAlwaysOnEnabled(context) && ContourMeterSync.hasBluetoothPermission(context)) {
            try {
                AlwaysOnSyncService.start(context)
            } catch (error: Exception) {
                BloodBridgeSync.saveAutoSyncStatus(
                    context,
                    "Automatic upload will resume after opening Blood Bridge: ${error.message ?: error.javaClass.simpleName}"
                )
            }
        }
    }
}
