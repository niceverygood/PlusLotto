package kr.bottlecorp.pluslotto.recuploader.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.os.Build
import android.os.IBinder
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kr.bottlecorp.pluslotto.recuploader.R
import kr.bottlecorp.pluslotto.recuploader.upload.PeriodicScanWorker
import java.util.concurrent.TimeUnit

/**
 * 지속 알림 + MediaStore 변경 감지(되는 기기에서만 근실시간 보완). 실질적 신뢰축은
 * PeriodicScanWorker(15분 주기, WorkManager 플랫폼 최소값)이고 이 서비스는 그걸 보조한다.
 * Android14+ dataSync FGS 는 장시간 실행 제약이 있을 수 있어(§한계), WorkManager 가 서비스
 * 종료와 무관하게 계속 도는 게 진짜 안전망이다.
 */
class WatcherForegroundService : Service() {

    private var observer: ContentObserver? = null

    override fun onCreate() {
        super.onCreate()
        ServiceCompat.startForeground(this, NOTIF_ID, buildNotification(), foregroundServiceType())
        schedulePeriodicScan()
        registerMediaStoreObserver()
        // 서비스 기동 즉시 1회 스캔(다음 15분 주기를 기다리지 않도록).
        WorkManager.getInstance(applicationContext).enqueue(OneTimeWorkRequestBuilder<PeriodicScanWorker>().build())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        observer?.let { contentResolver.unregisterContentObserver(it) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun schedulePeriodicScan() {
        val req = PeriodicWorkRequestBuilder<PeriodicScanWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(applicationContext)
            .enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    private fun registerMediaStoreObserver() {
        val obs = object : ContentObserver(null) {
            override fun onChange(selfChange: Boolean) {
                WorkManager.getInstance(applicationContext).enqueue(OneTimeWorkRequestBuilder<PeriodicScanWorker>().build())
            }
        }
        observer = obs
        contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, obs)
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel_name), NotificationManager.IMPORTANCE_LOW)
            nm.createNotificationChannel(channel)
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_running))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "watcher"
        private const val NOTIF_ID = 1001
        private const val WORK_NAME = "periodic-scan"

        fun foregroundServiceType(): Int =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    }
}
