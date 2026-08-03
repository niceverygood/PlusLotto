package kr.bottlecorp.pluslotto.recuploader.scan

import android.os.Environment
import kotlinx.coroutines.flow.Flow
import kr.bottlecorp.pluslotto.recuploader.data.AppDatabase
import kr.bottlecorp.pluslotto.recuploader.data.ScanFolderEntity

/** OEM 별 통화녹음 기본 폴더 프리셋 — 실기기 검증 전까지는 추정치. 앱 안에서 사용자가 폴더를
 *  추가/편집할 수 있어(§ScanFolderDao), 여기 없는 경로는 설치 후 수동으로 보완 가능하다. */
object DefaultScanFolders {
    private val root = Environment.getExternalStorageDirectory().path

    val PRESETS: List<String> = listOf(
        "$root/Call",
        "$root/Recordings/Call",
        "$root/Sounds/CallRecordings",
        "$root/MIUI/sound_recorder/call_rec",
        "$root/CallRecordings",
    )
}

class ScanFolderRepository(private val db: AppDatabase) {

    suspend fun ensureSeeded() {
        if (db.scanFolderDao().count() > 0) return
        val now = System.currentTimeMillis()
        for (p in DefaultScanFolders.PRESETS) {
            db.scanFolderDao().insert(ScanFolderEntity(path = p, isDefault = true, isEnabled = true, addedAt = now))
        }
    }

    suspend fun addCustom(path: String) {
        db.scanFolderDao().insert(
            ScanFolderEntity(path = path, isDefault = false, isEnabled = true, addedAt = System.currentTimeMillis()),
        )
    }

    suspend fun remove(id: Long) = db.scanFolderDao().delete(id)

    suspend fun enabledPaths(): List<String> = db.scanFolderDao().enabled().map { it.path }

    fun observeAll(): Flow<List<ScanFolderEntity>> = db.scanFolderDao().observeAll()
}
