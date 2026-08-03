package kr.bottlecorp.pluslotto.recuploader.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** 로그인 토큰(액세스/리프레시) + 스태프 이름 — EncryptedSharedPreferences 로 저장(자격증명이라 평문 금지). */
class TokenStore(context: Context) {
    private val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "call_uploader_secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var accessToken: String?
        get() = prefs.getString(KEY_ACCESS, null)
        set(v) = prefs.edit().putString(KEY_ACCESS, v).apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        set(v) = prefs.edit().putString(KEY_REFRESH, v).apply()

    var expiresAtMillis: Long
        get() = prefs.getLong(KEY_EXPIRES, 0L)
        set(v) = prefs.edit().putLong(KEY_EXPIRES, v).apply()

    var loginId: String?
        get() = prefs.getString(KEY_LOGIN_ID, null)
        set(v) = prefs.edit().putString(KEY_LOGIN_ID, v).apply()

    var staffName: String?
        get() = prefs.getString(KEY_STAFF_NAME, null)
        set(v) = prefs.edit().putString(KEY_STAFF_NAME, v).apply()

    val isLoggedIn: Boolean get() = !accessToken.isNullOrBlank()

    fun clear() = prefs.edit().clear().apply()

    private companion object {
        const val KEY_ACCESS = "access_token"
        const val KEY_REFRESH = "refresh_token"
        const val KEY_EXPIRES = "expires_at"
        const val KEY_LOGIN_ID = "login_id"
        const val KEY_STAFF_NAME = "staff_name"
    }
}
