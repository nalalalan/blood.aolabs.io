package io.aolabs.bloodbridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val healthConnectProviderPackage = "com.google.android.apps.healthdata"
    private val permissions = BloodBridgeSync.permissions
    private var syncAfterBluetoothPermission = false
    private var startAlwaysOnAfterBluetoothPermission = false
    private var startAlwaysOnAfterNotificationPermission = false
    private val requestPermissions = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract()
    ) { granted ->
        if (BloodBridgeSync.permissions.all { permission -> granted.contains(permission) }) {
            ensureAutoSync("Health Connect metrics permission granted. Auto sync scheduled.")
        } else {
            setStatus("Health Connect metrics permission not fully granted.")
        }
    }
    private val requestBluetoothPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { granted ->
        val ready = ContourMeterSync.bluetoothPermissions().all { permission -> granted[permission] == true }
        if (ready) {
            setStatus("Bluetooth permission granted. CONTOUR meter sync can run.")
            if (startAlwaysOnAfterBluetoothPermission) {
                startAlwaysOnAfterBluetoothPermission = false
                startAlwaysOnUpload()
            } else if (syncAfterBluetoothPermission) {
                syncAfterBluetoothPermission = false
                syncBlood(days = 90)
            }
        } else {
            syncAfterBluetoothPermission = false
            startAlwaysOnAfterBluetoothPermission = false
            setStatus("Bluetooth permission not granted. The CONTOUR meter cannot sync automatically.")
        }
    }
    private val requestNotificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        if (startAlwaysOnAfterNotificationPermission) {
            startAlwaysOnAfterNotificationPermission = false
            startAlwaysOnUpload(skipNotificationPrompt = true)
        }
    }

    private lateinit var endpointInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView
    private lateinit var tokenStateText: TextView
    private lateinit var advancedSettings: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        BloodBridgeSync.ensureDefaultSettings(this)
        setContentView(buildUi())
        loadSettings()
        checkAvailability()
        if (BloodBridgeSync.hasUploadToken(this)) {
            BloodBridgeSync.scheduleAutoSync(this)
            val lastStatus = BloodBridgeSync.prefs(this)
                .getString(BloodBridgeSync.LAST_AUTO_SYNC_STATUS_KEY, "")
                .orEmpty()
            if (BloodBridgeSync.isAlwaysOnEnabled(this) && ContourMeterSync.hasBluetoothPermission(this)) {
                startAlwaysOnUpload(skipNotificationPrompt = true)
            } else {
                setStatus(lastStatus.ifBlank {
                    "Periodic upload is scheduled. Tap Start automatic upload to keep the meter bridge running continuously."
                })
            }
        } else {
            setStatus("Current Blood Bridge APK is missing its upload token. Install the latest APK from blood.aolabs.io.")
        }
    }

    private fun buildUi(): View {
        val padding = (18 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }

        root.addView(TextView(this).apply {
            text = "Blood Bridge"
            textSize = 28f
        })

        root.addView(TextView(this).apply {
            text = "CONTOUR NEXT ONE glucose over Bluetooth plus Health Connect HR, HRV, steps, and sleep, then blood.aolabs.io. No token paste is part of setup."
            textSize = 15f
            setPadding(0, padding / 2, 0, padding)
        })

        tokenStateText = TextView(this).apply {
            textSize = 14f
            setPadding(0, 0, 0, padding / 2)
        }
        root.addView(tokenStateText)

        endpointInput = EditText(this).apply {
            hint = "endpoint"
            setSingleLine(true)
            setText(BloodBridgeSync.DEFAULT_ENDPOINT)
        }

        tokenInput = EditText(this).apply {
            hint = "upload token already loaded"
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        root.addView(Button(this).apply {
            text = "Grant Bluetooth permission"
            setOnClickListener {
                saveSettings()
                requestBluetoothPermission(queueSync = false)
            }
        })

        root.addView(Button(this).apply {
            text = "Start automatic upload"
            setOnClickListener { startAlwaysOnUpload() }
        })

        root.addView(Button(this).apply {
            text = "Stop automatic upload"
            setOnClickListener { stopAlwaysOnUpload() }
        })

        root.addView(Button(this).apply {
            text = "Run one upload check now"
            setOnClickListener { syncBlood(days = 90) }
        })

        root.addView(Button(this).apply {
            text = "Grant Health Connect metrics permission"
            setOnClickListener {
                saveSettings()
                requestPermissions.launch(permissions)
            }
        })

        root.addView(Button(this).apply {
            text = "Run automatic paths once"
            setOnClickListener { syncBlood(days = 14) }
        })

        root.addView(Button(this).apply {
            text = "Sync Health Connect metrics"
            setOnClickListener { syncHealthConnectMetrics(days = 90) }
        })

        root.addView(Button(this).apply {
            text = "Advanced settings"
            setOnClickListener {
                advancedSettings.visibility = if (advancedSettings.visibility == View.VISIBLE) {
                    View.GONE
                } else {
                    View.VISIBLE
                }
            }
        })

        advancedSettings = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(0, padding / 2, 0, 0)
        }
        advancedSettings.addView(TextView(this).apply {
            text = "Diagnostic override only. The APK normally carries the upload token."
            textSize = 13f
        })
        advancedSettings.addView(endpointInput)
        advancedSettings.addView(tokenInput)
        root.addView(advancedSettings)

        statusText = TextView(this).apply {
            text = "Waiting."
            textSize = 14f
            setPadding(0, padding, 0, 0)
        }
        root.addView(statusText)

        return ScrollView(this).apply { addView(root) }
    }

    private fun loadSettings() {
        BloodBridgeSync.ensureDefaultSettings(this)
        endpointInput.setText(BloodBridgeSync.endpoint(this))
        tokenInput.setText(BloodBridgeSync.token(this))
        updateTokenState()
    }

    private fun saveSettings() {
        BloodBridgeSync.saveSettings(
            this,
            endpointInput.text.toString().trim(),
            tokenInput.text.toString().trim()
        )
        updateTokenState()
    }

    private fun updateTokenState() {
        tokenStateText.text = if (BloodBridgeSync.hasUploadToken(this)) {
            "Upload token is already loaded in this APK."
        } else {
            "Upload token missing from this APK. Install the latest APK from blood.aolabs.io."
        }
    }

    private fun ensureAutoSync(message: String, queueImmediate: Boolean = true): Boolean {
        saveSettings()
        if (!BloodBridgeSync.hasUploadToken(this)) {
            setStatus("Current Blood Bridge APK is missing its upload token. Install the latest APK from blood.aolabs.io.")
            return false
        }
        BloodBridgeSync.scheduleAutoSync(this)
        if (queueImmediate) {
            BloodBridgeSync.queueImmediateSync(this)
        }
        setStatus(message)
        return true
    }

    private fun startAlwaysOnUpload(skipNotificationPrompt: Boolean = false) {
        saveSettings()
        val endpoint = BloodBridgeSync.endpoint(this)
        val token = BloodBridgeSync.token(this)

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Current Blood Bridge APK is missing its upload token. Install the latest APK from blood.aolabs.io.")
            return
        }
        if (!ContourMeterSync.hasBluetoothPermission(this)) {
            setStatus("Bluetooth permission required before automatic upload can run.")
            startAlwaysOnAfterBluetoothPermission = true
            requestBluetoothPermission(queueSync = false)
            return
        }
        if (!skipNotificationPrompt && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            startAlwaysOnAfterNotificationPermission = true
            requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }

        BloodBridgeSync.setAlwaysOnEnabled(this, true)
        BloodBridgeSync.scheduleAutoSync(this)
        BloodBridgeSync.queueImmediateSync(this)
        try {
            AlwaysOnSyncService.start(this)
            setStatus("Automatic upload is running. Keep the Blood Bridge notification active; new meter readings will be checked and posted in the background.")
        } catch (error: Exception) {
            setStatus("Automatic upload could not start: ${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun stopAlwaysOnUpload() {
        BloodBridgeSync.setAlwaysOnEnabled(this, false)
        BloodBridgeSync.cancelAutoSync(this)
        AlwaysOnSyncService.stop(this)
        setStatus("Automatic upload stopped.")
    }

    private fun checkAvailability() {
        val bluetoothStatus = ContourMeterSync.bluetoothStatus(this)
        val status = HealthConnectClient.getSdkStatus(this)
        when (status) {
            HealthConnectClient.SDK_AVAILABLE -> setStatus("$bluetoothStatus Health Connect metrics available.")
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                setStatus("$bluetoothStatus Health Connect update required.")
                val uri = Uri.parse("market://details?id=$healthConnectProviderPackage")
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
            else -> setStatus("$bluetoothStatus Health Connect unavailable on this phone.")
        }
    }

    private fun syncBlood(days: Int) {
        saveSettings()
        val endpoint = BloodBridgeSync.endpoint(this)
        val token = BloodBridgeSync.token(this)

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Current Blood Bridge APK is missing its upload token. Install the latest APK from blood.aolabs.io.")
            return
        }
        if (!ContourMeterSync.hasBluetoothPermission(this)) {
            setStatus("Bluetooth permission required for automatic CONTOUR meter sync.")
            requestBluetoothPermission(queueSync = true)
            return
        }

        CoroutineScope(Dispatchers.Main).launch {
            setStatus("Checking CONTOUR meter and Health Connect metrics.")
            try {
                val result = withContext(Dispatchers.IO) {
                    BloodBridgeSync.sync(this@MainActivity, days)
                }
                ensureAutoSync(
                    if (result.accepted > 0) {
                        "Automatic sync accepted ${result.accepted} record(s)."
                    } else {
                        result.response
                    },
                    queueImmediate = false
                )
            } catch (error: Exception) {
                setStatus("Automatic sync failed: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    private fun syncHealthConnectMetrics(days: Int) {
        saveSettings()
        val endpoint = BloodBridgeSync.endpoint(this)
        val token = BloodBridgeSync.token(this)

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Current Blood Bridge APK is missing its upload token. Install the latest APK from blood.aolabs.io.")
            return
        }

        CoroutineScope(Dispatchers.Main).launch {
            setStatus("Checking Health Connect metrics permission.")
            val client = HealthConnectClient.getOrCreate(this@MainActivity)
            val granted = client.permissionController.getGrantedPermissions()
            if (!BloodBridgeSync.permissions.all { permission -> granted.contains(permission) }) {
                setStatus("Health Connect metrics permission required.")
                requestPermissions.launch(permissions)
                return@launch
            }
            ensureAutoSync(
                "Auto sync scheduled. The worker uploads CONTOUR glucose plus Health Connect metrics.",
                queueImmediate = false
            )

            try {
                val payload = withContext(Dispatchers.IO) { BloodBridgeSync.readHealthMetricsPayload(client, days) }
                val accepted = payload.getJSONArray("heartRate").length() +
                    payload.getJSONArray("hrv").length() +
                    payload.getJSONArray("steps").length() +
                    payload.getJSONArray("sleepSessions").length()
                if (accepted == 0) {
                    setStatus("No Health Connect metric records found.")
                    return@launch
                }

                setStatus("Sending $accepted metric record(s).")
                val metricsEndpoint = BloodBridgeSync.healthMetricsEndpoint(endpoint)
                val response = withContext(Dispatchers.IO) { BloodBridgeSync.postPayload(metricsEndpoint, token, payload) }
                ensureAutoSync("Health Connect metrics sync accepted. Auto sync is scheduled.", queueImmediate = false)
                setStatus(response)
            } catch (error: Exception) {
                setStatus("Health Connect metrics sync failed: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    private fun requestBluetoothPermission(queueSync: Boolean) {
        syncAfterBluetoothPermission = queueSync
        requestBluetoothPermissions.launch(ContourMeterSync.bluetoothPermissions())
    }

    private fun setStatus(message: String) {
        statusText.text = message
    }
}
