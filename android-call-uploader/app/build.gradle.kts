plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    // namespace(=Kotlin 패키지/R 클래스)는 88lotto 원본과 동일하게 두고 applicationId 만 분리한다 —
    // 소스 22개 파일의 package 선언을 건드리지 않으면서도 두 브랜드 앱이 한 기기에 공존 가능해진다.
    namespace = "kr.bottlecorp.pluslotto.recuploader"
    compileSdk = 35

    defaultConfig {
        // 88lotto 동반앱(kr.bottlecorp.pluslotto.recuploader)과 충돌하지 않도록 별도 id.
        // (88lotto 쪽 id 가 브랜드 rename 전 이름을 그대로 쓰고 있어 혼동스럽지만, 이미 배포된
        //  앱의 id 변경은 재설치를 강제하므로 D86 결정대로 그대로 두고 이쪽을 실도메인 기준으로 명명.)
        applicationId = "kr.bottlecorp.lottoplus.recuploader"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        // 0.1.1(현장 8/4 "자동 업로드 안됨" 수정 2건): ① 번호 파싱 실패 녹음도 업로드(미매칭함행)
        // ② 업로드 성공 전까지 매 스캔 재시도(예전엔 첫 시도 실패 후 영구 SKIPPED_DUP 로 방치).
        versionName = "0.1.1"

        // 플러스로또 라이브 Supabase 프로젝트(웹 어드민과 동일) — publishable key 는 공개 임베드 전제(RLS 로 보호).
        buildConfigField("String", "SUPABASE_URL", "\"https://xmfdbmlpvvqqkhqemfay.supabase.co\"")
        buildConfigField(
            "String",
            "SUPABASE_ANON_KEY",
            "\"sb_publishable_hl8q2cbk-1t_GiQRrkPEdg_9-G5Vopj\"",
        )
        buildConfigField("String", "API_BASE_URL", "\"https://lotto-plus.co.kr\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")

    implementation("androidx.work:work-runtime-ktx:2.10.0")

    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
