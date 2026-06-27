package io.aolabs.bloodbridge

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.time.Instant

class BloodSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        if (BloodBridgeSync.token(applicationContext).isBlank()) {
            BloodBridgeSync.saveAutoSyncStatus(
                applicationContext,
                "Current Blood Bridge APK is missing its upload token. Install the latest APK from blood.aolabs.io."
            )
            return Result.success()
        }

        return try {
            val result = BloodBridgeSync.sync(applicationContext, days = 7)
            BloodBridgeSync.saveAutoSyncStatus(applicationContext, "Auto sync ${Instant.now()}: ${result.accepted} record(s).")
            Result.success()
        } catch (error: Exception) {
            val message = error.message ?: error.javaClass.simpleName
            BloodBridgeSync.saveAutoSyncStatus(applicationContext, "Auto sync failed ${Instant.now()}: $message")
            if (message.contains("permission", ignoreCase = true) ||
                message.contains("token", ignoreCase = true) ||
                message.contains("unavailable", ignoreCase = true)
            ) {
                Result.success()
            } else {
                Result.retry()
            }
        }
    }
}
