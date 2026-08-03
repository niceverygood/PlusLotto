package kr.bottlecorp.pluslotto.recuploader.upload

import kr.bottlecorp.pluslotto.recuploader.BuildConfig
import kr.bottlecorp.pluslotto.recuploader.auth.TokenStore
import okhttp3.Interceptor
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part

data class IngestResponse(val ok: Boolean, val matched: Boolean? = null, val member_id: String? = null, val message: String? = null)

interface IngestApi {
    @Multipart
    @POST("/api/ingest-call-recording")
    suspend fun ingest(
        @Part phone: MultipartBody.Part,
        @Part recordedAt: MultipartBody.Part,
        @Part file: MultipartBody.Part,
    ): Response<IngestResponse>
}

object IngestApiFactory {
    fun create(tokenStore: TokenStore): IngestApi {
        val authInterceptor = Interceptor { chain ->
            val token = tokenStore.accessToken
            val req = chain.request().newBuilder()
                .apply { if (token != null) addHeader("Authorization", "Bearer $token") }
                .build()
            chain.proceed(req)
        }
        val client = OkHttpClient.Builder()
            .addInterceptor(authInterceptor)
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            .build()
        return Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(IngestApi::class.java)
    }
}
