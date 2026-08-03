package kr.bottlecorp.pluslotto.recuploader.auth

import retrofit2.http.Body
import retrofit2.http.Headers
import retrofit2.http.POST
import retrofit2.http.Query

data class PasswordGrantRequest(val email: String, val password: String)
data class RefreshGrantRequest(val refresh_token: String)

data class TokenResponse(
    val access_token: String?,
    val refresh_token: String?,
    val expires_in: Long?,
    val user: SupabaseUser?,
    val error: String? = null,
    val error_description: String? = null,
)
data class SupabaseUser(val id: String?)

interface SupabaseAuthApi {
    @Headers("Content-Type: application/json")
    @POST("/auth/v1/token")
    suspend fun signInWithPassword(
        @Query("grant_type") grantType: String = "password",
        @Body body: PasswordGrantRequest,
    ): retrofit2.Response<TokenResponse>

    @Headers("Content-Type: application/json")
    @POST("/auth/v1/token")
    suspend fun refresh(
        @Query("grant_type") grantType: String = "refresh_token",
        @Body body: RefreshGrantRequest,
    ): retrofit2.Response<TokenResponse>
}
