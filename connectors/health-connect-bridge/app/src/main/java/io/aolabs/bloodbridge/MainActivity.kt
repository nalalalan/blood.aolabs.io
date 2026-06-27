package io.aolabs.bloodbridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
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
        if (granted.contains(BloodBridgeSync.glucosePermission)) {
            if (granted.contains(BloodBridgeSync.backgroundPermission)) {
                ensureAutoSync("Blood glucose permission granted. Auto sync scheduled.")
            } else {
                setStatus("Blood glucose permission granted. Background sync permission still missing.")
            }
        } else {
            setStatus("Blood glucose permission not granted.")
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        loadSettings()
        checkAvailability()
        if (BloodBridgeSync.token(this).isNotBlank()) {
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
            text = "Automatic path: CONTOUR NEXT ONE meter over Bluetooth, then Blood API, then blood.aolabs.io. Start automatic upload once and leave the Blood Bridge notification running."
            textSize = 15f
            setPadding(0, padding / 2, 0, padding)
        })

        endpointInput = EditText(this).apply {
            hint = "endpoint"
            setSingleLine(true)
            setText(BloodBridgeSync.DEFAULT_ENDPOINT)
        }
        root.addView(endpointInput)

        tokenInput = EditText(this).apply {
            hint = "bridge token"
            setSingleLine(true)
        }
        root.addView(tokenInput)

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
            text = "Grant Health Connect backup permission"
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
            text = "Sync Health Connect backup"
            setOnClickListener { syncHealthConnectBackup(days = 90) }
        })

        statusText = TextView(this).apply {
            text = "Waiting."
            textSize = 14f
            setPadding(0, padding, 0, 0)
        }
        root.addView(statusText)

        return ScrollView(this).apply { addView(root) }
    }

    private fun loadSettings() {
        val prefs = BloodBridgeSync.prefs(this)
        endpointInput.setText(prefs.getString("endpoint", endpointInput.text.toString()))
        tokenInput.setText(prefs.getString("token", ""))
    }

    private fun saveSettings() {
        BloodBridgeSync.saveSettings(
            this,
            endpointInput.text.toString().trim(),
            tokenInput.text.toString().trim()
        )
    }

    private fun ensureAutoSync(message: String, queueImmediate: Boolean = true): Boolean {
        saveSettings()
        if (BloodBridgeSync.token(this).isBlank()) {
            setStatus("Bridge token required before auto sync can run.")
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
        val endpoint = endpointInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Endpoint and bridge token required before automatic upload can run.")
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
            HealthConnectClient.SDK_AVAILABLE -> setStatus("$bluetoothStatus Health Connect backup available.")
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                setStatus("$bluetoothStatus Health Connect backup update required.")
                val uri = Uri.parse("market://details?id=$healthConnectProviderPackage")
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
            else -> setStatus("$bluetoothStatus Health Connect backup unavailable on this phone.")
        }
    }

    private fun syncBlood(days: Int) {
        saveSettings()
        val endpoint = endpointInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Endpoint and bridge token required.")
            return
        }
        if (!ContourMeterSync.hasBluetoothPermission(this)) {
            setStatus("Bluetooth permission required for automatic CONTOUR meter sync.")
            requestBluetoothPermission(queueSync = true)
            return
        }

        CoroutineScope(Dispatchers.Main).launch {
            setStatus("Scanning for CONTOUR NEXT ONE meter.")
            try {
                val result = withContext(Dispatchers.IO) {
                    BloodBridgeSync.sync(this@MainActivity, days)
                }
                ensureAutoSync(
                    if (result.accepted > 0) {
                        "Automatic sync accepted ${result.accepted} reading(s)."
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

    private fun syncHealthConnectBackup(days: Int) {
        saveSettings()
        val endpoint = endpointInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()

        if (endpoint.isBlank() || token.isBlank()) {
            setStatus("Endpoint and bridge token required.")
            return
        }

        CoroutineScope(Dispatchers.Main).launch {
            setStatus("Checking Health Connect backup permission.")
            val client = HealthConnectClient.getOrCreate(this@MainActivity)
            val granted = client.permissionController.getGrantedPermissions()
            if (!granted.contains(BloodBridgeSync.glucosePermission)) {
                setStatus("Health Connect blood glucose permission required.")
                requestPermissions.launch(permissions)
                return@launch
            }
            if (!granted.contains(BloodBridgeSync.backgroundPermission)) {
                requestPermissions.launch(permissions)
            }
            ensureAutoSync(
                "Auto sync scheduled. The worker tries the CONTOUR meter first; Health Connect is backup.",
                queueImmediate = false
            )

            try {
                val payload = withContext(Dispatchers.IO) { BloodBridgeSync.readGlucosePayload(client, days) }
                val accepted = payload.getJSONArray("readings").length()
                if (accepted == 0) {
                    setStatus("No Health Connect glucose records found.")
                    return@launch
                }

                setStatus("Sending $accepted reading(s).")
                val response = withContext(Dispatchers.IO) { BloodBridgeSync.postPayload(endpoint, token, payload) }
                ensureAutoSync("Health Connect backup sync accepted. Auto sync is scheduled.", queueImmediate = false)
                setStatus(response)
            } catch (error: Exception) {
                setStatus("Health Connect backup sync failed: ${error.message ?: error.javaClass.simpleName}")
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
