package io.aolabs.bloodbridge

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.UUID
import kotlin.math.roundToInt

object ContourMeterSync {
    private val glucoseServiceUuid: UUID = UUID.fromString("00001808-0000-1000-8000-00805f9b34fb")
    private val glucoseMeasurementUuid: UUID = UUID.fromString("00002a18-0000-1000-8000-00805f9b34fb")
    private val recordAccessControlPointUuid: UUID = UUID.fromString("00002a52-0000-1000-8000-00805f9b34fb")
    private val clientCharacteristicConfigUuid: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    private const val REPORT_STORED_RECORDS: Byte = 0x01
    private const val OPERATOR_ALL_RECORDS: Byte = 0x01
    private const val RACP_RESPONSE_CODE = 0x06
    private const val RACP_SUCCESS = 0x01
    private const val RACP_NO_RECORDS_FOUND = 0x06

    fun bluetoothPermissions(): Array<String> {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT
            )
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
    }

    fun hasBluetoothPermission(context: Context): Boolean {
        return bluetoothPermissions().all { permission ->
            context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun bluetoothStatus(context: Context): String {
        val adapter = bluetoothAdapter(context)
        return when {
            adapter == null -> "Bluetooth unavailable on this phone."
            !adapter.isEnabled -> "Bluetooth is off."
            !hasBluetoothPermission(context) -> "Bluetooth permission required."
            else -> "Bluetooth ready."
        }
    }

    suspend fun sync(context: Context, endpoint: String, token: String): SyncResult {
        val payload = readGlucosePayload(context)
        val accepted = payload.getJSONArray("readings").length()
        if (accepted == 0) {
            return SyncResult(0, "No glucose records returned by a nearby CONTOUR meter.")
        }
        return SyncResult(accepted, BloodBridgeSync.postPayload(endpoint, token, payload))
    }

    suspend fun readGlucosePayload(context: Context): JSONObject {
        if (!hasBluetoothPermission(context)) {
            throw IllegalStateException("Bluetooth permission required.")
        }
        val adapter = bluetoothAdapter(context) ?: throw IllegalStateException("Bluetooth unavailable.")
        if (!adapter.isEnabled) {
            throw IllegalStateException("Bluetooth is off.")
        }

        val device = scanForContourMeter(context, adapter)
        val readings = readStoredRecords(context, device)
        val readingsArray = JSONArray()
        readings.forEach { readingsArray.put(it) }
        return JSONObject()
            .put("source", "contour-meter-ble")
            .put("capturedAt", Instant.now().toString())
            .put("readings", readingsArray)
    }

    private fun bluetoothAdapter(context: Context): BluetoothAdapter? {
        val manager = context.getSystemService(BluetoothManager::class.java)
        return manager?.adapter
    }

    @SuppressLint("MissingPermission")
    private suspend fun scanForContourMeter(
        context: Context,
        adapter: BluetoothAdapter
    ): BluetoothDevice = withTimeout(30_000) {
        val scanner = adapter.bluetoothLeScanner ?: throw IllegalStateException("Bluetooth LE scanner unavailable.")
        val deferred = CompletableDeferred<BluetoothDevice>()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                if (matchesContourMeter(result) && !deferred.isCompleted) {
                    deferred.complete(result.device)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                if (!deferred.isCompleted) {
                    deferred.completeExceptionally(IllegalStateException("Bluetooth scan failed: $errorCode"))
                }
            }
        }

        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        scanner.startScan(null, settings, callback)
        try {
            deferred.await()
        } finally {
            scanner.stopScan(callback)
        }
    }

    @SuppressLint("MissingPermission")
    private fun matchesContourMeter(result: ScanResult): Boolean {
        val advertisesGlucoseService = result.scanRecord
            ?.serviceUuids
            ?.any { parcelUuid -> parcelUuid.uuid == glucoseServiceUuid } == true
        val names = listOfNotNull(
            result.scanRecord?.deviceName,
            result.device.name
        ).joinToString(" ").uppercase()

        return advertisesGlucoseService ||
            names.contains("CONTOUR") ||
            (names.contains("NEXT") && names.contains("ONE"))
    }

    @SuppressLint("MissingPermission")
    private suspend fun readStoredRecords(
        context: Context,
        device: BluetoothDevice
    ): List<JSONObject> = withTimeout(45_000) {
        val deferred = CompletableDeferred<List<JSONObject>>()
        val readings = linkedMapOf<String, JSONObject>()
        var gattRef: BluetoothGatt? = null
        var measurement: BluetoothGattCharacteristic? = null
        var racp: BluetoothGattCharacteristic? = null

        fun fail(message: String) {
            if (!deferred.isCompleted) {
                deferred.completeExceptionally(IllegalStateException(message))
            }
        }

        fun finish() {
            if (!deferred.isCompleted) {
                deferred.complete(readings.values.toList())
            }
        }

        fun handleMeasurement(value: ByteArray) {
            try {
                val reading = parseGlucoseMeasurement(value) ?: return
                val id = reading.getString("clientRecordId")
                readings[id] = reading
            } catch (error: Exception) {
                fail("Meter glucose record could not be parsed: ${error.message ?: error.javaClass.simpleName}")
            }
        }

        fun handleRacp(value: ByteArray) {
            if (value.size >= 3 && (value[0].toInt() and 0xff) == RACP_RESPONSE_CODE) {
                val responseCode = value[2].toInt() and 0xff
                if (responseCode == RACP_SUCCESS || responseCode == RACP_NO_RECORDS_FOUND) {
                    finish()
                } else {
                    fail("Meter record request failed: response $responseCode")
                }
            }
        }

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail("Meter connection failed: $status")
                    return
                }
                when (newState) {
                    BluetoothProfile.STATE_CONNECTED -> {
                        if (!gatt.discoverServices()) {
                            fail("Meter service discovery did not start.")
                        }
                    }
                    BluetoothProfile.STATE_DISCONNECTED -> {
                        if (!deferred.isCompleted) fail("Meter disconnected before records finished.")
                    }
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail("Meter service discovery failed: $status")
                    return
                }
                val service = gatt.getService(glucoseServiceUuid)
                if (service == null) {
                    fail("Nearby meter did not expose the standard Glucose service.")
                    return
                }
                measurement = service.getCharacteristic(glucoseMeasurementUuid)
                racp = service.getCharacteristic(recordAccessControlPointUuid)
                if (measurement == null || racp == null) {
                    fail("Meter Glucose Measurement or record-control characteristic missing.")
                    return
                }
                if (!writeClientConfig(gatt, measurement!!, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    fail("Could not subscribe to meter glucose measurements.")
                }
            }

            override fun onDescriptorWrite(
                gatt: BluetoothGatt,
                descriptor: BluetoothGattDescriptor,
                status: Int
            ) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail("Meter subscription failed: $status")
                    return
                }
                when (descriptor.characteristic.uuid) {
                    glucoseMeasurementUuid -> {
                        val racpCharacteristic = racp
                        if (racpCharacteristic == null ||
                            !writeClientConfig(gatt, racpCharacteristic, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE)
                        ) {
                            fail("Could not subscribe to meter record-control responses.")
                        }
                    }
                    recordAccessControlPointUuid -> {
                        val racpCharacteristic = racp
                        if (racpCharacteristic == null || !writeReportAllRecords(gatt, racpCharacteristic)) {
                            fail("Could not request stored meter records.")
                        }
                    }
                }
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic
            ) {
                handleCharacteristic(characteristic.uuid, characteristic.value ?: byteArrayOf())
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray
            ) {
                handleCharacteristic(characteristic.uuid, value)
            }

            private fun handleCharacteristic(uuid: UUID, value: ByteArray) {
                when (uuid) {
                    glucoseMeasurementUuid -> handleMeasurement(value)
                    recordAccessControlPointUuid -> handleRacp(value)
                }
            }
        }

        gattRef = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        try {
            deferred.await()
        } finally {
            runCatching { gattRef?.disconnect() }
            runCatching { gattRef?.close() }
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun writeClientConfig(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray
    ): Boolean {
        val descriptor = characteristic.getDescriptor(clientCharacteristicConfigUuid) ?: return false
        if (!gatt.setCharacteristicNotification(characteristic, true)) return false
        descriptor.value = value
        return gatt.writeDescriptor(descriptor)
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun writeReportAllRecords(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic
    ): Boolean {
        characteristic.value = byteArrayOf(REPORT_STORED_RECORDS, OPERATOR_ALL_RECORDS)
        return gatt.writeCharacteristic(characteristic)
    }

    private fun parseGlucoseMeasurement(value: ByteArray): JSONObject? {
        if (value.size < 10) throw IllegalArgumentException("record too short")

        val flags = value[0].toInt() and 0xff
        var index = 1
        val sequence = uint16(value, index)
        index += 2

        val year = uint16(value, index)
        val month = uint8(value, index + 2)
        val day = uint8(value, index + 3)
        val hour = uint8(value, index + 4)
        val minute = uint8(value, index + 5)
        val second = uint8(value, index + 6)
        index += 7

        val timeOffsetMinutes = if ((flags and 0x01) != 0) {
            val offset = int16(value, index)
            index += 2
            offset
        } else {
            0
        }

        if ((flags and 0x02) == 0) {
            return null
        }
        if (value.size < index + 3) throw IllegalArgumentException("record missing glucose value")

        val concentration = decodeSFloat(uint16(value, index))
        index += 2
        val typeAndLocation = uint8(value, index)
        val specimenType = typeAndLocation and 0x0f
        val usesMolPerLiter = (flags and 0x04) != 0
        val valueMgDl = if (usesMolPerLiter) {
            concentration * 18_018.2
        } else {
            concentration * 100_000.0
        }

        val measuredAt = LocalDateTime
            .of(year, month, day, hour, minute, second)
            .plusMinutes(timeOffsetMinutes.toLong())
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toString()

        return JSONObject()
            .put("clientRecordId", "contour-next-one-$sequence-$measuredAt")
            .put("sourcePackage", "contour-next-one-ble")
            .put("measuredAt", measuredAt)
            .put("valueMgDl", valueMgDl.roundToInt())
            .put("specimenSource", specimenSourceName(specimenType))
            .put("notes", "CONTOUR NEXT ONE Bluetooth sequence $sequence")
    }

    private fun uint8(value: ByteArray, index: Int): Int = value[index].toInt() and 0xff

    private fun uint16(value: ByteArray, index: Int): Int {
        return uint8(value, index) or (uint8(value, index + 1) shl 8)
    }

    private fun int16(value: ByteArray, index: Int): Int {
        val raw = uint16(value, index)
        return if ((raw and 0x8000) != 0) raw - 0x10000 else raw
    }

    private fun decodeSFloat(raw: Int): Double {
        if (raw in setOf(0x07ff, 0x0800, 0x07fe, 0x0802, 0x0801)) {
            throw IllegalArgumentException("special SFLOAT value")
        }
        var mantissa = raw and 0x0fff
        if ((mantissa and 0x0800) != 0) mantissa -= 0x1000
        var exponent = (raw shr 12) and 0x0f
        if ((exponent and 0x08) != 0) exponent -= 0x10
        return mantissa * Math.pow(10.0, exponent.toDouble())
    }

    private fun specimenSourceName(type: Int): String {
        return when (type) {
            1, 2 -> "capillary_blood"
            3, 4 -> "whole_blood"
            5, 6 -> "plasma"
            7, 8 -> "interstitial_fluid"
            else -> ""
        }
    }
}
