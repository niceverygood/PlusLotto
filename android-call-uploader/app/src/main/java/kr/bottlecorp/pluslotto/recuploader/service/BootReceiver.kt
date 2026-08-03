package kr.bottlecorp.pluslotto.recuploader.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import kr.bottlecorp.pluslotto.recuploader.auth.TokenStore

/** 재부팅 후 로그인 상태면 감시 서비스 재시작. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!TokenStore(context).isLoggedIn) return
        val svc = Intent(context, WatcherForegroundService::class.java)
        ContextCompat.startForegroundService(context, svc)
    }
}
