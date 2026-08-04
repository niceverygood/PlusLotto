package kr.bottlecorp.pluslotto.recuploader.upload

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
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
            // 업로드 성공한 파일만 건너뛴다(현장 8/4 로그 제보 — SKIPPED_DUP 만 반복되고 서버 수신 0건).
            // 예전엔 상태와 무관하게 원장에 행이 있으면 영구히 건너뛰어서, 첫 시도가 한 번이라도
            // 실패하거나(PENDING 상태로 남거나) WorkManager 작업이 유실되면 그 녹음은 영영 안 올라갔다.
            // 이제 PENDING/FAILED 는 스캔할 때마다 다시 큐에 넣어 자동 복구된다.
            if (existing != null && existing.uploadState == "SUCCESS") {
                db.scanLogDao().insert(
                    ScanLogEntity(
                        timestamp = System.currentTimeMillis(),
                        foundPath = c.file.path,
                        parsedPhone = c.parsedPhone,
                        uploadOutcome = "SKIPPED_DUP",
                        message = "이미 업로드 완료",
                    ),
                )
                continue
            }
            // 전화번호 파싱 실패여도 업로드는 한다(현장 8/4 "자동 업로드 안됨" 원인 수정) —
            // 삼성 등은 상대가 연락처에 저장돼 있으면 파일명이 이름("통화 녹음 홍길동_…")이라
            // 번호가 안 뽑히는데, 예전엔 그 파일을 여기서 통째로 건너뛰어 업로드가 0건이 됐다.
            // 이제 빈 번호로 올리면 서버가 미매칭 보관함에 넣고 전산에서 수동 연결한다.
            val phoneForUpload = c.parsedPhone ?: ""

            // 원장에 없으면 신규 등록(있으면 IGNORE — 재시도이므로 기존 행을 그대로 둔다).
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
            val logMessage: String = if (existing != null) {
                val http = if (existing.httpStatus != null) " HTTP " + existing.httpStatus else ""
                "재시도(이전 " + existing.uploadState + http + ")"
            } else if (c.parsedPhone == null) {
                "번호 파싱 실패 — 미매칭함으로 업로드"
            } else {
                "업로드 대기열에 추가"
            }
            db.scanLogDao().insert(
                ScanLogEntity(
                    timestamp = System.currentTimeMillis(),
                    foundPath = c.file.path,
                    parsedPhone = c.parsedPhone,
                    uploadOutcome = "PARSED",
                    message = logMessage,
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
            // 파일 단위 고유 작업(KEEP) — 15분마다 재시도를 걸어도 진행 중인 업로드가 있으면
            // 중복 큐잉되지 않고, 이전 작업이 이미 끝나버린(=유실된) 경우에만 새로 시작한다.
            val req = OneTimeWorkRequestBuilder<UploadWorker>().setInputData(input).build()
            WorkManager.getInstance(applicationContext)
                .enqueueUniqueWork("upload-${c.file.path}-$size-$lastModified", ExistingWorkPolicy.KEEP, req)
        }
        return Result.success()
    }
}
