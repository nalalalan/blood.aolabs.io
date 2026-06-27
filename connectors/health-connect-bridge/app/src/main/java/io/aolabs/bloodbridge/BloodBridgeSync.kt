package io.aolabs.bloodbridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

data class SyncResult(
    val accepted: Int,
    val response: String
)

object BloodBridgeSync {
    const val DEFAULT_ENDPOINT = "https://blood.aolabs.io/api/ingest/glucose-readings"
    const val PREFS_NAME = "blood-bridge"
    const val AUTO_WORK_NAME = "blood-auto-sync"

    val glucosePermission: String = HealthPermission.getReadPermission(BloodGlucoseRecord::class)
    val backgroundPermission: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    val permissions: Set<String> = setOf(glucosePermission, backgroundPermission)

    fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun endpoint(context: Context): String =
        prefs(context).getString("endpoint", DEFAULT_ENDPOINT)?.trim().orEmpty().ifBlank { DEFAULT_ENDPOINT }

    fun token(context: Context): String =
        prefs(context).getString("token", "")?.trim().orEmpty()

    fun saveSettings(context: Context, endpoint: String, token: String) {
        prefs(context)
            .edit()
            .putString("endpoint", endpoint.trim().ifBlank { DEFAULT_ENDPOINT })
            .putString("token", token.trim())
            .apply()
    }

    fun scheduleAutoSync(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val periodic = PeriodicWorkRequestBuilder<BloodSyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            AUTO_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            periodic
        )
    }

    fun queueImmediateSync(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val oneTime = OneTimeWorkRequestBuilder<BloodSyncWorker>()
            .setConstraints(constraints)
            .build()
        WorkManager.getInstance(context).enqueue(oneTime)
    }

    suspend fun sync(context: Context, days: Int): SyncResult {
        val endpoint = endpoint(context)
        val token = token(context)
        if (endpoint.isBlank() || token.isBlank()) {
            throw IllegalStateException("Endpoint and bridge token required.")
        }

        var meterStatus = ContourMeterSync.bluetoothStatus(context)
        if (ContourMeterSync.hasBluetoothPermission(context)) {
            try {
                val meterResult = ContourMeterSync.sync(context, endpoint, token)
                if (meterResult.accepted > 0) return meterResult
                meterStatus = meterResult.response
            } catch (error: Exception) {
                meterStatus = error.message ?: error.javaClass.simpleName
            }
        }

        return try {
            val healthResult = syncHealthConnect(context, endpoint, token, days)
            if (healthResult.accepted > 0) healthResult else SyncResult(
                0,
                "No automatic readings reached Blood. Meter path: $meterStatus Health Connect path: ${healthResult.response}"
            )
        } catch (error: Exception) {
            val healthStatus = error.message ?: error.javaClass.simpleName
            throw IllegalStateException(
                "No automatic data path is currently producing readings. Meter path: $meterStatus Health Connect path: $healthStatus"
            )
        }
    }

    private suspend fun syncHealthConnect(
        context: Context,
        endpoint: String,
        token: String,
        days: Int
    ): SyncResult {
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            throw IllegalStateException("Health Connect unavailable.")
        }

        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        if (!granted.contains(glucosePermission)) {
            throw IllegalStateException("Blood glucose permission required.")
        }
        if (!granted.contains(backgroundPermission)) {
            throw IllegalStateException("Background Health Connect permission required.")
        }

        val payload = readGlucosePayload(client, days)
        val accepted = payload.getJSONArray("readings").length()
        if (accepted == 0) {
            return SyncResult(0, "No Health Connect glucose records found.")
        }

        return SyncResult(accepted, postPayload(endpoint, token, payload))
    }

    suspend fun readGlucosePayload(client: HealthConnectClient, days: Int): JSONObject {
        val end = Instant.now().plus(1, ChronoUnit.DAYS)
        val start = Instant.now().minus(days.toLong() + 1, ChronoUnit.DAYS)
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = BloodGlucoseRecord::class,
                timeRangeFilter = TimeRangeFilter.between(start, end)
            )
        )

        val readings = JSONArray()
        for (record in response.records) {
            readings.put(recordToJson(record))
        }

        return JSONObject()
            .put("source", "health-connect")
            .put("capturedAt", Instant.now().toString())
            .put("readings", readings)
    }

    private fun recordToJson(record: BloodGlucoseRecord): JSONObject {
        return JSONObject()
            .put("clientRecordId", record.metadata.clientRecordId ?: record.metadata.id)
            .put("sourcePackage", record.metadata.dataOrigin.packageName)
            .put("measuredAt", record.time.toString())
            .put("zoneOffset", record.zoneOffset?.id ?: "")
            .put("valueMgDl", record.level.inMilligramsPerDeciliter)
            .put("mealType", mealTypeName(record.mealType))
            .put("relationToMeal", relationToMealName(record.relationToMeal))
            .put("specimenSource", specimenSourceName(record.specimenSource))
    }

    private fun mealTypeName(type: Int): String {
        return when (type) {
            MealType.MEAL_TYPE_BREAKFAST -> "breakfast"
            MealType.MEAL_TYPE_LUNCH -> "lunch"
            MealType.MEAL_TYPE_DINNER -> "dinner"
            MealType.MEAL_TYPE_SNACK -> "snack"
            else -> ""
        }
    }

    private fun relationToMealName(type: Int): String {
        return when (type) {
            BloodGlucoseRecord.RELATION_TO_MEAL_FASTING -> "fasting"
            BloodGlucoseRecord.RELATION_TO_MEAL_BEFORE_MEAL -> "before_meal"
            BloodGlucoseRecord.RELATION_TO_MEAL_AFTER_MEAL -> "after_meal"
            BloodGlucoseRecord.RELATION_TO_MEAL_GENERAL -> "general"
            else -> ""
        }
    }

    private fun specimenSourceName(type: Int): String {
        return when (type) {
            BloodGlucoseRecord.SPECIMEN_SOURCE_CAPILLARY_BLOOD -> "capillary_blood"
            BloodGlucoseRecord.SPECIMEN_SOURCE_PLASMA -> "plasma"
            BloodGlucoseRecord.SPECIMEN_SOURCE_SERUM -> "serum"
            BloodGlucoseRecord.SPECIMEN_SOURCE_TEARS -> "tears"
            BloodGlucoseRecord.SPECIMEN_SOURCE_WHOLE_BLOOD -> "whole_blood"
            BloodGlucoseRecord.SPECIMEN_SOURCE_INTERSTITIAL_FLUID -> "interstitial_fluid"
            else -> ""
        }
    }

    fun postPayload(endpoint: String, token: String, payload: JSONObject): String {
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
        }

        connection.outputStream.use { stream ->
            stream.write(payload.toString().toByteArray(Charsets.UTF_8))
        }

        val code = connection.responseCode
        val body = (if (code in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()
            ?.use { it.readText() }
            .orEmpty()

        if (code !in 200..299) {
            throw IllegalStateException("API $code $body")
        }

        return "Sync accepted by Blood API. $body"
    }
}
