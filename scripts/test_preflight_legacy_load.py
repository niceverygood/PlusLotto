#!/usr/bin/env python3
"""실제 고객 원본/DB 없이 레거시 사전 점검 CLI의 실패 차단을 검증한다."""

import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'preflight-legacy-load.sh'
USER_PAYLOAD = b'synthetic-user-payload-for-crc-test'


class LegacyPreflightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.archive = self.directory / 'synthetic archive.zip'
        self.network_probe = self.directory / 'network-attempted'
        # 자격증명이 있어도 사전 점검은 DNS/HTTP 연결을 시도하지 않아야 한다.
        (self.directory / 'sitecustomize.py').write_text(
            'import os, socket\n'
            'from pathlib import Path\n'
            'def forbidden_network(*args, **kwargs):\n'
            '    Path(os.environ["PREFLIGHT_NETWORK_PROBE"]).write_text("attempted")\n'
            '    raise RuntimeError("preflight must not use network")\n'
            'socket.socket.connect = forbidden_network\n'
            'socket.socket.connect_ex = forbidden_network\n'
            'socket.create_connection = forbidden_network\n',
            encoding='utf-8',
        )

    def tearDown(self):
        self.temp.cleanup()

    def write_archive(self, extra_entries=(), user_name='safe/815korean_user.sql'):
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_STORED) as archive:
            archive.writestr(user_name, USER_PAYLOAD)
            archive.writestr('safe/815korean_payment.sql', b'synthetic-payment-payload')
            for name, content in extra_entries:
                archive.writestr(name, content)

    def run_preflight(self, site='lotto815'):
        env = os.environ.copy()
        env.update({
            'PYTHONPATH': str(self.directory),
            'PYTHONDONTWRITEBYTECODE': '1',
            'PREFLIGHT_NETWORK_PROBE': str(self.network_probe),
            'VITE_SUPABASE_URL': 'https://must-not-contact.invalid',
            'SUPABASE_SERVICE_ROLE_KEY': 'preflight-test-secret-should-stay-private',
        })
        result = subprocess.run(
            ['bash', str(SCRIPT), site, str(self.archive)],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertFalse(self.network_probe.exists(), '사전 점검이 네트워크를 호출했습니다')
        self.assertNotIn(env['SUPABASE_SERVICE_ROLE_KEY'], result.stdout + result.stderr)
        return result

    def test_valid_nested_archive_passes_without_database_access_or_sql_parsing(self):
        self.write_archive()
        result = self.run_preflight()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('점검 통과', result.stdout)
        self.assertIn('--dry-run', result.stdout)

    def test_crc_failure_returned_as_filename_causes_nonzero_exit(self):
        self.write_archive()
        content = bytearray(self.archive.read_bytes())
        content[content.index(USER_PAYLOAD)] ^= 1
        self.archive.write_bytes(content)
        with zipfile.ZipFile(self.archive) as archive:
            self.assertEqual(archive.testzip(), 'safe/815korean_user.sql')
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ZIP CRC 검사에 실패', result.stdout)
        self.assertNotIn('점검 통과', result.stdout)

    def test_prefix_only_filename_is_rejected(self):
        self.write_archive(user_name='safe/815korean_user.sql.backup')
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('알려진 SQL 파일이 정확히 1개', result.stdout)

    def test_duplicate_known_dump_is_rejected(self):
        self.write_archive([('other/lotto815_user.sql', b'also-known')])
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('알려진 SQL 파일이 정확히 1개', result.stdout)

    def test_unsafe_archive_path_is_rejected(self):
        self.write_archive([('../escape.txt', b'unsafe')])
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('안전하지 않은 경로', result.stdout)

    def test_unknown_site_is_rejected_before_archive_read(self):
        result = self.run_preflight('unknown')
        self.assertEqual(result.returncode, 2)
        self.assertIn('알 수 없는 사이트키', result.stdout)

    def test_missing_archive_is_rejected(self):
        result = self.run_preflight()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('파일이 없다', result.stdout)


if __name__ == '__main__':
    unittest.main()
