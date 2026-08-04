package kr.bottlecorp.pluslotto.recuploader.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kr.bottlecorp.pluslotto.recuploader.auth.AuthRepository
import kr.bottlecorp.pluslotto.recuploader.auth.TokenStore
import kr.bottlecorp.pluslotto.recuploader.data.AppDatabase
import kr.bottlecorp.pluslotto.recuploader.data.ScanLogEntity
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File

/** 파일 1건을 서버(/api/ingest-call-recording)로 업로드. WorkManager 가 실패 시 지수 백오프로 재시도. */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val path = inputData.getString(KEY_PATH) ?: return Result.failure()
        // 빈 번호 허용(현장 8/4) — 번호 파싱 실패 녹음도 올려 미매칭 보관함으로 보낸다.
        val phone = inputData.getString(KEY_PHONE) ?: ""
        val recordedAt = inputData.getString(KEY_RECORDED_AT) ?: ""
        val size = inputData.getLong(KEY_SIZE, -1)
        val lastModified = inputData.getLong(KEY_LAST_MODIFIED, -1)

        val db = AppDatabase.get(applicationContext)
        val tokenStore = TokenStore(applicationContext)
        val authRepo = AuthRepository(tokenStore)

        val file = File(path)
        if (!file.exists()) return Result.failure()

        if (!authRepo.ensureFreshToken()) {
            db.scanLogDao().insert(
                ScanLogEntity(timestamp = System.currentTimeMillis(), foundPath = path, parsedPhone = phone, uploadOutcome = "FAILED", message = "로그인 세션 만료 — 앱에서 다시 로그인 필요"),
            )
            return Result.retry()
        }

        return try {
            val api = IngestApiFactory.create(tokenStore)
            val mediaType = guessMediaType(file.extension)
            val filePart = MultipartBody.Part.createFormData("file", file.name, file.asRequestBody(mediaType))
            val phonePart = MultipartBody.Part.createFormData("phone", phone)
            val tsPart = MultipartBody.Part.createFormData("recorded_at", recordedAt)

            val res = api.ingest(phonePart, tsPart, filePart)
            val entity = db.uploadedFileDao().find(path, size, lastModified)
            if (res.isSuccessful && res.body()?.ok == true) {
                entity?.let { db.uploadedFileDao().update(it.copy(uploadState = "SUCCESS", httpStatus = res.code(), lastAttemptAt = System.currentTimeMillis())) }
                db.scanLogDao().insert(
                    ScanLogEntity(timestamp = System.currentTimeMillis(), foundPath = path, parsedPhone = phone, uploadOutcome = "SUCCESS", message = "matched=${res.body()?.matched}"),
                )
                Result.success()
            } else {
                entity?.let { db.uploadedFileDao().update(it.copy(uploadState = "FAILED", httpStatus = res.code(), lastAttemptAt = System.currentTimeMillis())) }
                db.scanLogDao().insert(
                    ScanLogEntity(timestamp = System.currentTimeMillis(), foundPath = path, parsedPhone = phone, uploadOutcome = "FAILED", message = "HTTP ${res.code()} ${res.body()?.message ?: ""}"),
                )
                Result.retry()
            }
        } catch (e: Exception) {
            db.scanLogDao().insert(
                ScanLogEntity(timestamp = System.currentTimeMillis(), foundPath = path, parsedPhone = phone, uploadOutcome = "FAILED", message = "예외: ${e.message}"),
            )
            Result.retry()
        }
    }

    private fun guessMediaType(ext: String) = when (ext.lowercase()) {
        "m4a", "aac" -> "audio/mp4"
        "amr" -> "audio/amr"
        "mp3" -> "audio/mpeg"
        "3gp" -> "audio/3gpp"
        "wav" -> "audio/wav"
        else -> "application/octet-stream"
    }.toMediaTypeOrNull()

    companion object {
        const val KEY_PATH = "path"
        const val KEY_PHONE = "phone"
        const val KEY_RECORDED_AT = "recorded_at"
        const val KEY_SIZE = "size"
        const val KEY_LAST_MODIFIED = "last_modified"
    }
}
