package io.aolabs.bloodbridge

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import java.time.Instant

class BloodSyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        if (BloodBridgeSync.token(applicationContext).isBlank()) {
            BloodBridgeSync.saveAutoSyncStatus(
                applicationContext,
                "This APK cannot upload. Download Blood Bridge again from blood.aolabs.io."
            )
            return Result.success()
        }
        if (!BloodBridgeSync.markAutoSyncStarted(applicationContext)) {
            BloodBridgeSync.queueRollingSync(applicationContext)
            return Result.success()
        }

        return try {
            val result = BloodBridgeSync.sync(applicationContext, days = BloodBridgeSync.AUTO_SYNC_LOOKBACK_DAYS)
            BloodBridgeSync.saveAutoSyncStatus(applicationContext, "Auto sync ${Instant.now()}: ${result.accepted} record(s).")
            BloodBridgeSync.postBridgeCheckIn(applicationContext, "synced", result.accepted, result.response)
            BloodBridgeSync.queueRollingSync(applicationContext)
            Result.success()
        } catch (error: CancellationException) {
            BloodBridgeSync.saveAutoSyncStatus(applicationContext, "Auto sync was interrupted ${Instant.now()}. The next scheduled run stays queued.")
            BloodBridgeSync.queueRollingSync(applicationContext)
            throw error
        } catch (error: Exception) {
            val message = BloodBridgeSync.userFacingError(error)
            BloodBridgeSync.saveAutoSyncStatus(applicationContext, "Auto sync failed ${Instant.now()}: $message")
            BloodBridgeSync.postBridgeCheckIn(applicationContext, "blocked", 0, message)
            BloodBridgeSync.queueRollingSync(applicationContext)
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
