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
            // 전화번호 파싱 실패여도 업로드는 한다(현장 8/4 "자동 업로드 안됨" 원인 수정) —
            // 삼성 등은 상대가 연락처에 저장돼 있으면 파일명이 이름("통화 녹음 홍길동_…")이라
            // 번호가 안 뽑히는데, 예전엔 그 파일을 여기서 통째로 건너뛰어 업로드가 0건이 됐다.
            // 이제 빈 번호로 올리면 서버가 미매칭 보관함에 넣고 전산에서 수동 연결한다.
            val phoneForUpload = c.parsedPhone ?: ""

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
                ScanLogEntity(
                    timestamp = System.currentTimeMillis(),
                    foundPath = c.file.path,
                    parsedPhone = c.parsedPhone,
                    uploadOutcome = "PARSED",
                    message = if (c.parsedPhone == null) "번호 파싱 실패 — 미매칭함으로 업로드" else "업로드 대기열에 추가",
                ),
            )

            val recordedAtIso = c.recordedAtIso
                ?: java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).format(java.util.Date(lastModified))
            val input = Data.Builder()
                .putString(UploadWorker.KEY_PATH, c.file.path)
                .putString(UploadWorker.KEY_PHONE, phoneForUpload)
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
