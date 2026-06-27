package io.aolabs.bloodbridge

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
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
    const val DEFAULT_HEALTH_METRICS_ENDPOINT = "https://blood.aolabs.io/api/ingest/health-metrics"
    const val PREFS_NAME = "blood-bridge"
    const val AUTO_WORK_NAME = "blood-auto-sync"
    const val ALWAYS_ON_ENABLED_KEY = "alwaysOnUploadEnabled"
    const val LAST_AUTO_SYNC_STATUS_KEY = "lastAutoSyncStatus"

    val glucosePermission: String = HealthPermission.getReadPermission(BloodGlucoseRecord::class)
    val heartRatePermission: String = HealthPermission.getReadPermission(HeartRateRecord::class)
    val hrvPermission: String = HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class)
    val stepsPermission: String = HealthPermission.getReadPermission(StepsRecord::class)
    val sleepPermission: String = HealthPermission.getReadPermission(SleepSessionRecord::class)
    val backgroundPermission: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
    val permissions: Set<String> = setOf(
        glucosePermission,
        heartRatePermission,
        hrvPermission,
        stepsPermission,
        sleepPermission,
        backgroundPermission
    )

    fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun endpoint(context: Context): String =
        prefs(context).getString("endpoint", DEFAULT_ENDPOINT)?.trim().orEmpty().ifBlank { DEFAULT_ENDPOINT }

    fun healthMetricsEndpoint(context: Context): String = healthMetricsEndpoint(endpoint(context))

    fun healthMetricsEndpoint(endpoint: String): String =
        endpoint.trim()
            .replace("/api/ingest/glucose-readings", "/api/ingest/health-metrics")
            .ifBlank { DEFAULT_HEALTH_METRICS_ENDPOINT }

    fun token(context: Context): String =
        prefs(context).getString("token", "")?.trim().orEmpty()

    fun saveSettings(context: Context, endpoint: String, token: String) {
        prefs(context)
            .edit()
            .putString("endpoint", endpoint.trim().ifBlank { DEFAULT_ENDPOINT })
            .putString("token", token.trim())
            .apply()
    }

    fun isAlwaysOnEnabled(context: Context): Boolean =
        prefs(context).getBoolean(ALWAYS_ON_ENABLED_KEY, false)

    fun setAlwaysOnEnabled(context: Context, enabled: Boolean) {
        prefs(context)
            .edit()
            .putBoolean(ALWAYS_ON_ENABLED_KEY, enabled)
            .apply()
    }

    fun saveAutoSyncStatus(context: Context, message: String) {
        prefs(context)
            .edit()
            .putString(LAST_AUTO_SYNC_STATUS_KEY, message)
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

    fun cancelAutoSync(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(AUTO_WORK_NAME)
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
        val metricsEndpoint = healthMetricsEndpoint(endpoint)
        val token = token(context)
        if (endpoint.isBlank() || token.isBlank()) {
            throw IllegalStateException("Endpoint and bridge token required.")
        }

        val statuses = mutableListOf<String>()
        var acceptedTotal = 0

        if (ContourMeterSync.hasBluetoothPermission(context)) {
            try {
                val meterResult = ContourMeterSync.sync(context, endpoint, token)
                acceptedTotal += meterResult.accepted
                statuses.add("CONTOUR meter: ${meterResult.response}")
            } catch (error: Exception) {
                statuses.add("CONTOUR meter: ${error.message ?: error.javaClass.simpleName}")
            }
        } else {
            statuses.add("CONTOUR meter: ${ContourMeterSync.bluetoothStatus(context)}")
        }

        try {
            val glucoseResult = syncHealthConnectGlucose(context, endpoint, token, days)
            acceptedTotal += glucoseResult.accepted
            statuses.add("Health Connect glucose: ${glucoseResult.response}")
        } catch (error: Exception) {
            statuses.add("Health Connect glucose: ${error.message ?: error.javaClass.simpleName}")
        }

        try {
            val metricsResult = syncHealthMetrics(context, metricsEndpoint, token, days)
            acceptedTotal += metricsResult.accepted
            statuses.add("Health metrics: ${metricsResult.response}")
        } catch (error: Exception) {
            statuses.add("Health metrics: ${error.message ?: error.javaClass.simpleName}")
        }

        return if (acceptedTotal > 0) {
            SyncResult(acceptedTotal, statuses.joinToString(" "))
        } else {
            SyncResult(0, "No automatic data reached Blood. ${statuses.joinToString(" ")}")
        }
    }

    private suspend fun syncHealthConnectGlucose(
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
            throw IllegalStateException("blood glucose permission required.")
        }
        if (!granted.contains(backgroundPermission)) {
            throw IllegalStateException("background Health Connect permission required.")
        }

        val payload = readGlucosePayload(client, days)
        val accepted = payload.getJSONArray("readings").length()
        if (accepted == 0) {
            return SyncResult(0, "no records found.")
        }

        return SyncResult(accepted, postPayload(endpoint, token, payload))
    }

    suspend fun syncHealthMetrics(
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
        val missing = listOf(heartRatePermission, hrvPermission, stepsPermission, sleepPermission, backgroundPermission)
            .filter { permission -> !granted.contains(permission) }
        if (missing.isNotEmpty()) {
            throw IllegalStateException("metric permission required.")
        }

        val payload = readHealthMetricsPayload(client, days)
        val accepted = payload.getJSONArray("heartRate").length() +
            payload.getJSONArray("hrv").length() +
            payload.getJSONArray("steps").length() +
            payload.getJSONArray("sleepSessions").length()
        if (accepted == 0) {
            return SyncResult(0, "no records found.")
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

    suspend fun readHealthMetricsPayload(client: HealthConnectClient, days: Int): JSONObject {
        val end = Instant.now().plus(1, ChronoUnit.DAYS)
        val start = Instant.now().minus(days.toLong() + 1, ChronoUnit.DAYS)
        val range = TimeRangeFilter.between(start, end)

        val heartRate = JSONArray()
        val heartRateResponse = client.readRecords(
            ReadRecordsRequest(
                recordType = HeartRateRecord::class,
                timeRangeFilter = range
            )
        )
        for (record in heartRateResponse.records) {
            for (sample in record.samples) {
                heartRate.put(
                    JSONObject()
                        .put("clientRecordId", "${record.metadata.clientRecordId ?: record.metadata.id}:${sample.time}")
                        .put("sourcePackage", record.metadata.dataOrigin.packageName)
                        .put("measuredAt", sample.time.toString())
                        .put("zoneOffset", record.startZoneOffset?.id ?: "")
                        .put("valueBpm", sample.beatsPerMinute)
                )
            }
        }

        val hrv = JSONArray()
        val hrvResponse = client.readRecords(
            ReadRecordsRequest(
                recordType = HeartRateVariabilityRmssdRecord::class,
                timeRangeFilter = range
            )
        )
        for (record in hrvResponse.records) {
            hrv.put(
                JSONObject()
                    .put("clientRecordId", record.metadata.clientRecordId ?: record.metadata.id)
                    .put("sourcePackage", record.metadata.dataOrigin.packageName)
                    .put("measuredAt", record.time.toString())
                    .put("zoneOffset", record.zoneOffset?.id ?: "")
                    .put("rmssdMs", record.heartRateVariabilityMillis)
            )
        }

        val steps = JSONArray()
        val stepsResponse = client.readRecords(
            ReadRecordsRequest(
                recordType = StepsRecord::class,
                timeRangeFilter = range
            )
        )
        for (record in stepsResponse.records) {
            steps.put(
                JSONObject()
                    .put("clientRecordId", record.metadata.clientRecordId ?: record.metadata.id)
                    .put("sourcePackage", record.metadata.dataOrigin.packageName)
                    .put("startTime", record.startTime.toString())
                    .put("endTime", record.endTime.toString())
                    .put("zoneOffset", record.endZoneOffset?.id ?: record.startZoneOffset?.id ?: "")
                    .put("count", record.count)
            )
        }

        val sleepSessions = JSONArray()
        val sleepResponse = client.readRecords(
            ReadRecordsRequest(
                recordType = SleepSessionRecord::class,
                timeRangeFilter = range
            )
        )
        for (record in sleepResponse.records) {
            sleepSessions.put(sleepToJson(record))
        }

        return JSONObject()
            .put("source", "health-connect")
            .put("capturedAt", Instant.now().toString())
            .put("heartRate", heartRate)
            .put("hrv", hrv)
            .put("steps", steps)
            .put("sleepSessions", sleepSessions)
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

    private fun sleepToJson(record: SleepSessionRecord): JSONObject {
        val stages = JSONArray()
        for (stage in record.stages) {
            stages.put(
                JSONObject()
                    .put("stage", sleepStageName(stage.stage))
                    .put("startTime", stage.startTime.toString())
                    .put("endTime", stage.endTime.toString())
            )
        }
        return JSONObject()
            .put("clientRecordId", record.metadata.clientRecordId ?: record.metadata.id)
            .put("sourcePackage", record.metadata.dataOrigin.packageName)
            .put("startTime", record.startTime.toString())
            .put("endTime", record.endTime.toString())
            .put("startZoneOffset", record.startZoneOffset?.id ?: "")
            .put("endZoneOffset", record.endZoneOffset?.id ?: "")
            .put("title", record.title ?: "")
            .put("notes", record.notes ?: "")
            .put("stages", stages)
    }

    private fun sleepStageName(type: Int): String {
        return when (type) {
            SleepSessionRecord.STAGE_TYPE_AWAKE -> "awake"
            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> "awake_in_bed"
            SleepSessionRecord.STAGE_TYPE_DEEP -> "deep"
            SleepSessionRecord.STAGE_TYPE_LIGHT -> "light"
            SleepSessionRecord.STAGE_TYPE_OUT_OF_BED -> "out_of_bed"
            SleepSessionRecord.STAGE_TYPE_REM -> "rem"
            SleepSessionRecord.STAGE_TYPE_SLEEPING -> "sleeping"
            else -> "unknown"
        }
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
