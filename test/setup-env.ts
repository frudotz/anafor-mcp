import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Testler kullanıcının gerçek ~/.anafor dizinine (limitler, iş kiraları) dokunmaz ve
// paralel test dosyaları birbirinin runner kiralarını görmez.
if (!process.env.ANAFOR_TEST_KEEP_HOME) {
  process.env.ANAFOR_HOME = mkdtempSync(join(tmpdir(), 'anafor-test-home-'));
}
