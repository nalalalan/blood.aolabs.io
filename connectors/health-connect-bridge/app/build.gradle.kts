plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun String.escapeForBuildConfig(): String =
    replace("\\", "\\\\").replace("\"", "\\\"")

val defaultBridgeToken = (
    providers.gradleProperty("bloodBridgeToken").orNull
        ?: providers.environmentVariable("BLOOD_BRIDGE_TOKEN").orNull
        ?: ""
).trim()

if (providers.environmentVariable("CI").orNull.equals("true", ignoreCase = true) && defaultBridgeToken.isBlank()) {
    throw GradleException("BLOOD_BRIDGE_TOKEN is required for CI Blood Bridge APK builds.")
}

android {
    namespace = "io.aolabs.bloodbridge"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.aolabs.bloodbridge"
        minSdk = 28
        targetSdk = 35
        versionCode = 5
        versionName = "0.5.0"
        buildConfigField("String", "DEFAULT_BRIDGE_TOKEN", "\"${defaultBridgeToken.escapeForBuildConfig()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.health.connect:connect-client:1.1.0-alpha11")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.1")
}
