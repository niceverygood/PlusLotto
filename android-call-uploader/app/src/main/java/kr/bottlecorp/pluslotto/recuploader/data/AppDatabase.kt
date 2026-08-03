package kr.bottlecorp.pluslotto.recuploader.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [UploadedFileEntity::class, ScanFolderEntity::class, ScanLogEntity::class],
    version = 1,
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun uploadedFileDao(): UploadedFileDao
    abstract fun scanFolderDao(): ScanFolderDao
    abstract fun scanLogDao(): ScanLogDao

    companion object {
        @Volatile private var instance: AppDatabase? = null

        fun get(context: Context): AppDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "call-uploader.db",
                ).build().also { instance = it }
            }
    }
}
