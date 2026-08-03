package kr.bottlecorp.pluslotto.recuploader.auth

import kr.bottlecorp.pluslotto.recuploader.BuildConfig
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/** 로그인ID → "<login_id>@pluslotto.local" 이메일 규칙(웹 어드민 src/lib/auth.ts 와 동일). */
private const val AUTH_EMAIL_DOMAIN = "pluslotto.local"

sealed class AuthResult {
    data class Success(val staffAuthUserId: String) : AuthResult()
    data class Failure(val message: String) : AuthResult()
}

class AuthRepository(private val tokenStore: TokenStore) {

    private val apiKeyInterceptor = Interceptor { chain ->
        val req = chain.request().newBuilder().addHeader("apikey", BuildConfig.SUPABASE_ANON_KEY).build()
        chain.proceed(req)
    }

    private val client = OkHttpClient.Builder()
        .addInterceptor(apiKeyInterceptor)
        .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
        .build()

    private val api: SupabaseAuthApi = Retrofit.Builder()
        .baseUrl(BuildConfig.SUPABASE_URL)
        .client(client)
        .addConverterFactory(GsonConverterFactory.create())
        .build()
        .create(SupabaseAuthApi::class.java)

    suspend fun signIn(loginId: String, password: String): AuthResult {
        val email = if (loginId.contains("@")) loginId else "$loginId@$AUTH_EMAIL_DOMAIN"
        return try {
            val res = api.signInWithPassword(body = PasswordGrantRequest(email, password))
            val body = res.body()
            if (!res.isSuccessful || body?.access_token == null) {
                return AuthResult.Failure(body?.error_description ?: "로그인 실패(아이디/비밀번호 확인)")
            }
            persist(body)
            tokenStore.loginId = loginId
            AuthResult.Success(body.user?.id ?: "")
        } catch (e: Exception) {
            AuthResult.Failure("네트워크 오류: ${e.message}")
        }
    }

    /** 액세스 토큰이 만료됐거나 곧 만료되면(60초 여유) 리프레시. 성공 시 true. */
    suspend fun ensureFreshToken(): Boolean {
        val refreshToken = tokenStore.refreshToken ?: return false
        val now = System.currentTimeMillis()
        if (now < tokenStore.expiresAtMillis - 60_000) return true // 아직 유효
        return try {
            val res = api.refresh(body = RefreshGrantRequest(refreshToken))
            val body = res.body()
            if (!res.isSuccessful || body?.access_token == null) {
                tokenStore.clear()
                return false
            }
            persist(body)
            true
        } catch (e: Exception) {
            false
        }
    }

    fun signOut() = tokenStore.clear()

    private fun persist(body: TokenResponse) {
        tokenStore.accessToken = body.access_token
        tokenStore.refreshToken = body.refresh_token ?: tokenStore.refreshToken
        tokenStore.expiresAtMillis = System.currentTimeMillis() + (body.expires_in ?: 3600L) * 1000
    }
}
