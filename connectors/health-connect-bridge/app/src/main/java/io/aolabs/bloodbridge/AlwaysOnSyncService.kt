package io.aolabs.bloodbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant

class AlwaysOnSyncService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            BloodBridgeSync.setAlwaysOnEnabled(this, false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        BloodBridgeSync.setAlwaysOnEnabled(this, true)
        BloodBridgeSync.scheduleAutoSync(this)
        startForegroundUpload("Starting automatic meter upload.")
        startLoop()
        return START_STICKY
    }

    override fun onDestroy() {
        loopJob?.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startLoop() {
        if (loopJob?.isActive == true) return
        loopJob = serviceScope.launch {
            while (isActive && BloodBridgeSync.isAlwaysOnEnabled(this@AlwaysOnSyncService)) {
                runSyncOnce()
                delay(SYNC_INTERVAL_MS)
            }
            stopSelf()
        }
    }

    private suspend fun runSyncOnce() {
        if (BloodBridgeSync.token(this).isBlank()) {
            updateStatus("Automatic upload waiting for bridge token.")
            return
        }
        if (!ContourMeterSync.hasBluetoothPermission(this)) {
            updateStatus("Automatic upload waiting for Bluetooth permission.")
            return
        }

        updateStatus("Checking CONTOUR meter and Health Connect metrics.")
        try {
            val result = BloodBridgeSync.sync(this, days = 14)
            updateStatus(
                if (result.accepted > 0) {
                    "Uploaded ${result.accepted} record(s) at ${Instant.now()}."
                } else {
                    "${Instant.now()}: ${result.response}"
                }
            )
        } catch (error: Exception) {
            updateStatus("${Instant.now()}: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun updateStatus(message: String) {
        BloodBridgeSync.saveAutoSyncStatus(this, message)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification(message))
    }

    private fun startForegroundUpload(message: String) {
        val notification = notification(message)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notification(message: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setSmallIcon(R.drawable.ic_blood_upload)
            .setContentTitle("Blood Bridge automatic upload")
            .setContentText(message.take(90))
            .setStyle(Notification.BigTextStyle().bigText(message))
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Blood Bridge upload",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps CONTOUR NEXT ONE meter readings uploading to blood.aolabs.io."
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "blood-bridge-upload"
        private const val NOTIFICATION_ID = 1041
        private const val SYNC_INTERVAL_MS = 2 * 60 * 1000L
        private const val ACTION_START = "io.aolabs.bloodbridge.START_ALWAYS_ON"
        private const val ACTION_STOP = "io.aolabs.bloodbridge.STOP_ALWAYS_ON"

        fun start(context: Context) {
            val intent = Intent(context, AlwaysOnSyncService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AlwaysOnSyncService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
