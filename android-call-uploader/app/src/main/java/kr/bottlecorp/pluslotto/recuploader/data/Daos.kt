package kr.bottlecorp.pluslotto.recuploader.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface UploadedFileDao {
    @Query("SELECT * FROM uploaded_files WHERE path = :path AND size = :size AND lastModified = :lastModified LIMIT 1")
    suspend fun find(path: String, size: Long, lastModified: Long): UploadedFileEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: UploadedFileEntity): Long

    @Update
    suspend fun update(entity: UploadedFileEntity)

    @Query("SELECT COUNT(*) FROM uploaded_files WHERE uploadState = 'SUCCESS'")
    suspend fun successCount(): Int
}

@Dao
interface ScanFolderDao {
    @Query("SELECT * FROM scan_folders ORDER BY isDefault DESC, path ASC")
    fun observeAll(): Flow<List<ScanFolderEntity>>

    @Query("SELECT * FROM scan_folders WHERE isEnabled = 1")
    suspend fun enabled(): List<ScanFolderEntity>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: ScanFolderEntity)

    @Query("DELETE FROM scan_folders WHERE id = :id")
    suspend fun delete(id: Long)

    @Query("SELECT COUNT(*) FROM scan_folders")
    suspend fun count(): Int
}

@Dao
interface ScanLogDao {
    @Query("SELECT * FROM scan_logs ORDER BY timestamp DESC LIMIT 200")
    fun observeRecent(): Flow<List<ScanLogEntity>>

    @Insert
    suspend fun insert(entity: ScanLogEntity)
}
