package io.aolabs.bloodbridge

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private val healthConnectProviderPackage = "com.google.android.apps.healthdata"
    private val permissions = BloodBridgeSync.permissions
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

    private lateinit var endpointInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        loadSettings()
        checkAvailability()
        if (BloodBridgeSync.token(this).isNotBlank()) {
            ensureAutoSync("Auto sync scheduled from saved bridge token.")
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
            text = "Reads Health Connect blood glucose records only. If Contour is not listed in Health Connect, this bridge has nothing to upload; use the Contour CSV import on blood.aolabs.io."
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
            text = "Grant blood glucose permission"
            setOnClickListener {
                saveSettings()
                requestPermissions.launch(permissions)
            }
        })

        root.addView(Button(this).apply {
            text = "Sync last 14 days"
            setOnClickListener { syncBlood(days = 14) }
        })

        root.addView(Button(this).apply {
            text = "Sync last 90 days"
            setOnClickListener { syncBlood(days = 90) }
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

    private fun checkAvailability() {
        val status = HealthConnectClient.getSdkStatus(this)
        when (status) {
            HealthConnectClient.SDK_AVAILABLE -> setStatus("Health Connect available.")
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                setStatus("Health Connect update required.")
                val uri = Uri.parse("market://details?id=$healthConnectProviderPackage")
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
            else -> setStatus("Health Connect unavailable on this phone.")
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

        CoroutineScope(Dispatchers.Main).launch {
            setStatus("Checking Health Connect permission.")
            val client = HealthConnectClient.getOrCreate(this@MainActivity)
            val granted = client.permissionController.getGrantedPermissions()
            if (!granted.contains(BloodBridgeSync.glucosePermission)) {
                setStatus("Blood glucose permission required.")
                requestPermissions.launch(permissions)
                return@launch
            }
            if (!granted.contains(BloodBridgeSync.backgroundPermission)) {
                requestPermissions.launch(permissions)
            }
            ensureAutoSync(
                "Auto sync scheduled. Android will check periodically after glucose records reach Health Connect.",
                queueImmediate = false
            )

            try {
                val payload = withContext(Dispatchers.IO) { BloodBridgeSync.readGlucosePayload(client, days) }
                val accepted = payload.getJSONArray("readings").length()
                if (accepted == 0) {
                    setStatus("No Health Connect glucose records found. If Contour is not listed in Health Connect, use the Contour CSV import on blood.aolabs.io.")
                    return@launch
                }

                setStatus("Sending $accepted reading(s).")
                val response = withContext(Dispatchers.IO) { BloodBridgeSync.postPayload(endpoint, token, payload) }
                ensureAutoSync("Manual sync accepted. Auto sync is scheduled for future readings.", queueImmediate = false)
                setStatus(response)
            } catch (error: Exception) {
                setStatus("Sync failed: ${error.message ?: error.javaClass.simpleName}")
            }
        }
    }

    private fun setStatus(message: String) {
        statusText.text = message
    }
}
