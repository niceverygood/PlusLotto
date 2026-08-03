package kr.bottlecorp.pluslotto.recuploader.ui

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import kr.bottlecorp.pluslotto.recuploader.auth.AuthRepository
import kr.bottlecorp.pluslotto.recuploader.auth.AuthResult
import kr.bottlecorp.pluslotto.recuploader.auth.TokenStore
import kr.bottlecorp.pluslotto.recuploader.data.AppDatabase
import kr.bottlecorp.pluslotto.recuploader.data.ScanFolderEntity
import kr.bottlecorp.pluslotto.recuploader.data.ScanLogEntity
import kr.bottlecorp.pluslotto.recuploader.scan.ScanFolderRepository
import kr.bottlecorp.pluslotto.recuploader.service.WatcherForegroundService
import kr.bottlecorp.pluslotto.recuploader.util.PermissionHelper

class MainActivity : ComponentActivity() {

    private lateinit var tokenStore: TokenStore
    private lateinit var authRepo: AuthRepository
    private lateinit var db: AppDatabase
    private lateinit var folderRepo: ScanFolderRepository

    private val notifPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tokenStore = TokenStore(this)
        authRepo = AuthRepository(tokenStore)
        db = AppDatabase.get(this)
        folderRepo = ScanFolderRepository(db)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            MaterialTheme {
                var loggedIn by remember { mutableStateOf(tokenStore.isLoggedIn) }
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    if (loggedIn) {
                        StatusScreen(
                            staffName = tokenStore.staffName ?: tokenStore.loginId ?: "",
                            folderRepo = folderRepo,
                            db = db,
                            onStartService = ::startWatcher,
                            onLogout = {
                                stopService(Intent(this, WatcherForegroundService::class.java))
                                authRepo.signOut()
                                loggedIn = false
                            },
                        )
                    } else {
                        LoginScreen(
                            onLogin = { loginId, pw, onResult ->
                                lifecycleScope.launch {
                                    when (val r = authRepo.signIn(loginId, pw)) {
                                        is AuthResult.Success -> {
                                            tokenStore.staffName = loginId
                                            startWatcher()
                                            loggedIn = true
                                            onResult(null)
                                        }
                                        is AuthResult.Failure -> onResult(r.message)
                                    }
                                }
                            },
                        )
                    }
                }
            }
        }
    }

    private fun startWatcher() {
        val intent = Intent(this, WatcherForegroundService::class.java)
        ContextCompat.startForegroundService(this, intent)
    }
}

@Composable
private fun LoginScreen(onLogin: (String, String, (String?) -> Unit) -> Unit) {
    var loginId by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("플러스로또 통화녹음 업로더", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = loginId,
            onValueChange = { loginId = it },
            label = { Text("로그인 ID (전산과 동일)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("비밀번호") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        Spacer(Modifier.height(16.dp))
        if (error != null) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
            Spacer(Modifier.height(8.dp))
        }
        Button(
            onClick = {
                loading = true
                onLogin(loginId.trim(), password) { err ->
                    loading = false
                    error = err
                }
            },
            enabled = !loading && loginId.isNotBlank() && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (loading) "로그인 중…" else "로그인")
        }
    }
}

@Composable
private fun StatusScreen(
    staffName: String,
    folderRepo: ScanFolderRepository,
    db: AppDatabase,
    onStartService: () -> Unit,
    onLogout: () -> Unit,
) {
    val activity = LocalContext.current as? Activity
    var allFilesOk by remember { mutableStateOf(PermissionHelper.hasAllFilesAccess()) }
    var batteryOk by remember { mutableStateOf(activity?.let { PermissionHelper.isIgnoringBatteryOptimizations(it) } ?: false) }
    val folders by folderRepo.observeAll().collectAsState(initial = emptyList())
    val logs by db.scanLogDao().observeRecent().collectAsState(initial = emptyList())
    var newFolder by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) { folderRepo.ensureSeeded() }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("접속: $staffName", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))

        if (!allFilesOk) {
            PermissionRow("전체 파일 접근 권한이 필요합니다(통화녹음 폴더 스캔).") {
                activity?.let { PermissionHelper.requestAllFilesAccess(it) }
            }
        }
        if (!batteryOk) {
            PermissionRow("배터리 최적화 제외를 허용해야 백그라운드 업로드가 끊기지 않습니다.") {
                activity?.let { PermissionHelper.requestIgnoreBatteryOptimizations(it) }
            }
        }
        Button(onClick = onStartService, modifier = Modifier.fillMaxWidth()) { Text("감시 서비스 시작/재시작") }

        Spacer(Modifier.height(16.dp))
        Text("스캔 폴더", style = MaterialTheme.typography.titleSmall)
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = newFolder,
                onValueChange = { newFolder = it },
                label = { Text("/storage/emulated/0/...") },
                modifier = Modifier.weight(1f),
                singleLine = true,
            )
            TextButton(onClick = {
                if (newFolder.isNotBlank()) {
                    scope.launch { folderRepo.addCustom(newFolder.trim()) }
                    newFolder = ""
                }
            }) { Text("추가") }
        }
        LazyColumn(modifier = Modifier.weight(1f, fill = false).heightIn(max = 140.dp)) {
            items(folders) { f: ScanFolderEntity ->
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(f.path, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    if (!f.isDefault) {
                        TextButton(onClick = { scope.launch { folderRepo.remove(f.id) } }) { Text("삭제") }
                    }
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        Text("최근 스캔/업로드 로그", style = MaterialTheme.typography.titleSmall)
        LazyColumn(modifier = Modifier.weight(1f)) {
            items(logs) { l: ScanLogEntity ->
                Column(modifier = Modifier.padding(vertical = 4.dp)) {
                    Text("[${l.uploadOutcome}] ${l.parsedPhone ?: "?"} — ${l.message}", style = MaterialTheme.typography.bodySmall)
                    Text(l.foundPath, style = MaterialTheme.typography.labelSmall)
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) { Text("로그아웃") }
    }
}

@Composable
private fun PermissionRow(message: String, onClick: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text(message, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(6.dp))
            Button(onClick = onClick) { Text("권한 설정으로 이동") }
        }
    }
}
