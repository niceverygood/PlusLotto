package kr.bottlecorp.pluslotto.recuploader.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** 이미 업로드 시도한 파일의 중복방지 원장. (경로+크기+수정시각) 복합 유니크 — 파일명이 같아도
 *  내용이 바뀌면(재녹음 등) 다시 시도하고, 같은 파일이 재스캔돼도 중복 업로드하지 않는다. */
@Entity(
    tableName = "uploaded_files",
    indices = [Index(value = ["path", "size", "lastModified"], unique = true)],
)
data class UploadedFileEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val path: String,
    val size: Long,
    val lastModified: Long,
    val parsedPhone: String?,
    val recordedAtIso: String?,
    val uploadState: String, // PENDING | UPLOADING | SUCCESS | FAILED
    val httpStatus: Int? = null,
    val lastAttemptAt: Long? = null,
    val createdAt: Long,
)

/** 사용자가 앱 안에서 추가/편집하는 스캔 대상 폴더. OEM 기본값은 앱 최초 실행 시 seed. */
@Entity(tableName = "scan_folders")
data class ScanFolderEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val path: String,
    val isDefault: Boolean,
    val isEnabled: Boolean,
    val addedAt: Long,
)

/** 진단화면용 최근 스캔/업로드 이벤트 로그 — 실기기 파일명 규칙 튜닝의 핵심 데이터. */
@Entity(tableName = "scan_logs")
data class ScanLogEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val timestamp: Long,
    val foundPath: String,
    val parsedPhone: String?,
    val uploadOutcome: String, // FOUND | PARSED | UPLOADING | SUCCESS | FAILED | SKIPPED_DUP
    val message: String,
)
