plugins {
    id("com.android.application")
}

// CI से: -PversionCode=<run number> -PversionName=1.0.<run number>  (हर build ऊँचा versionCode → update install होती है)
val vCode = (project.findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
val vName = (project.findProperty("versionName") as String?) ?: "1.0.0"

// Release keystore env से (GitHub secrets); न हो तो debug key (सिर्फ पहली बार/test के लिए — update पर uninstall करना पड़ेगा)
val ksPath: String? = System.getenv("KEYSTORE_PATH")
val hasKeystore = ksPath != null && file(ksPath).exists()

android {
    namespace = "com.jhaji.loading"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.jhaji.loading"
        minSdk = 24
        targetSdk = 34
        versionCode = vCode
        versionName = vName
    }

    signingConfigs {
        if (hasKeystore) {
            create("release") {
                storeFile = file(ksPath!!)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
                enableV1Signing = true   // META-INF/*.RSA भी रहे → openssl/keytool से signature check आसान
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasKeystore) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
