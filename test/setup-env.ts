import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Testler kullanıcının gerçek ~/.anafor dizinine (limitler, iş kiraları) dokunmaz ve
// paralel test dosyaları birbirinin runner kiralarını görmez.
if (!process.env.ANAFOR_TEST_KEEP_HOME) {
  const base = process.env.ANAFOR_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  process.env.ANAFOR_HOME = mkdtempSync(join(base, 'anafor-test-home-'));
}
// Statusline/CLI testleri arka planda ağa çıkan sürüm denetimi başlatmasın.
process.env.ANAFOR_NO_UPDATE_CHECK = '1';
// Host Claude Code project roots must not leak into cwd-specific hook tests.
delete process.env.CLAUDE_PROJECT_DIR;
// Mesaj dili sistem diline bağlı olmasın (CI İngilizce): testler Türkçe katalogla çalışır.
process.env.ANAFOR_LANG ??= 'tr';
