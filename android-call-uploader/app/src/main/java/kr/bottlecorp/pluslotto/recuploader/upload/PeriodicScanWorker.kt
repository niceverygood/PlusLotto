package kr.bottlecorp.pluslotto.recuploader.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kr.bottlecorp.pluslotto.recuploader.auth.TokenStore
import kr.bottlecorp.pluslotto.recuploader.data.AppDatabase
import kr.bottlecorp.pluslotto.recuploader.data.ScanLogEntity
import kr.bottlecorp.pluslotto.recuploader.data.UploadedFileEntity
import kr.bottlecorp.pluslotto.recuploader.scan.FileSystemScanner
import kr.bottlecorp.pluslotto.recuploader.scan.ScanFolderRepository

/**
 * 15분 주기(WorkManager 최소 주기 — 플랫폼 하한이라 더 줄일 수 없음) 폴더 전체 스캔.
 * MediaStore 감지가 안 되는 기기가 많아(§한계), 이게 실질적인 신뢰축이다.
 */
class PeriodicScanWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!TokenStore(applicationContext).isLoggedIn) return Result.success() // 로그아웃 상태면 스캔 안 함

        val db = AppDatabase.get(applicationContext)
        val folderRepo = ScanFolderRepository(db)
        folderRepo.ensureSeeded()
        val folders = folderRepo.enabledPaths()

        val candidates = FileSystemScanner().scan(folders)
        for (c in candidates) {
            val size = c.file.length()
            val lastModified = c.file.lastModified()
            val existing = db.uploadedFileDao().find(c.file.path, size, lastModified)
            if (existing != null) {
                db.scanLogDao().insert(
                    ScanLogEntity(
                        timestamp = System.currentTimeMillis(),
                        foundPath = c.file.path,
                        parsedPhone = c.parsedPhone,
                        uploadOutcome = "SKIPPED_DUP",
                        message = "이미 처리됨(${existing.uploadState})",
                    ),
                )
                continue
            }
            if (c.parsedPhone == null) {
                db.scanLogDao().insert(
                    ScanLogEntity(timestamp = System.currentTimeMillis(), foundPath = c.file.path, parsedPhone = null, uploadOutcome = "FOUND", message = "전화번호 파싱 실패 — 파일명 규칙 확인 필요"),
                )
                continue
            }

            db.uploadedFileDao().insert(
                UploadedFileEntity(
                    path = c.file.path,
                    size = size,
                    lastModified = lastModified,
                    parsedPhone = c.parsedPhone,
                    recordedAtIso = c.recordedAtIso,
                    uploadState = "PENDING",
                    createdAt = System.currentTimeMillis(),
                ),
            )
            db.scanLogDao().insert(
                ScanLogEntity(timestamp = System.currentTimeMillis(), foundPath = c.file.path, parsedPhone = c.parsedPhone, uploadOutcome = "PARSED", message = "업로드 대기열에 추가"),
            )

            val recordedAtIso = c.recordedAtIso
                ?: java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).format(java.util.Date(lastModified))
            val input = Data.Builder()
                .putString(UploadWorker.KEY_PATH, c.file.path)
                .putString(UploadWorker.KEY_PHONE, c.parsedPhone)
                .putString(UploadWorker.KEY_RECORDED_AT, recordedAtIso)
                .putLong(UploadWorker.KEY_SIZE, size)
                .putLong(UploadWorker.KEY_LAST_MODIFIED, lastModified)
                .build()
            val req = OneTimeWorkRequestBuilder<UploadWorker>().setInputData(input).build()
            WorkManager.getInstance(applicationContext).enqueue(req)
        }
        return Result.success()
    }
}
