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
            saveStatus("Auto sync waiting for bridge token.")
            return Result.success()
        }

        return try {
            val result = BloodBridgeSync.sync(applicationContext, days = 7)
            saveStatus("Auto sync ${Instant.now()}: ${result.accepted} reading(s).")
            Result.success()
        } catch (error: Exception) {
            val message = error.message ?: error.javaClass.simpleName
            saveStatus("Auto sync failed ${Instant.now()}: $message")
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

    private fun saveStatus(message: String) {
        BloodBridgeSync.prefs(applicationContext)
            .edit()
            .putString("lastAutoSyncStatus", message)
            .apply()
    }
}
