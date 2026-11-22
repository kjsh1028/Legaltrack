/**
 * LegalTrack → 구글 드라이브 「율촌 사건」 폴더 자동 정리
 *
 * 1) 즉시 정리: LegalTrack 앱에서 사건 상태를 바꿔 저장하면, 앱이 이 스크립트의
 *    웹 앱 주소를 불러 해당 사건 폴더를 바로 맞는 상태 폴더로 옮긴다.
 * 2) 하루 1회 점검: 매일 새벽 3시(상해 시간)에 전체 사건을 다시 대조한다
 *    (앱 밖에서 바뀐 것까지 맞춤).
 *
 * 설치 순서
 *  ① setup 실행 → 권한 허용 (하루 1회 예약 등록 + 비밀 키 생성 + 1회 전체 정리)
 *  ② 배포 → 새 배포 → 유형: 웹 앱 / 다음 사용자로 실행: 나 / 액세스 권한: 모든 사용자 → 배포
 *  ③ showAppLink 실행 → 실행 로그에 나온 주소를 앱 설정의 「드라이브 동기화 주소」에 붙여 넣기
 * 중지하려면: removeTriggers 실행 + 배포 관리에서 웹 앱 보관(삭제)
 *
 * 안전장치
 *  - 폴더 이름은 바꾸지 않고 위치만 옮긴다.
 *  - 지금 아래 5개 상태 폴더 중 한 곳에 있는 폴더만 옮긴다 (다른 곳의 폴더는 건드리지 않음).
 *  - 웹 앱은 비밀 키가 맞을 때만 동작한다.
 *  - 하루 1회 점검에서 같은 폴더에 상태가 다른 사건이 연결되어 있으면 옮기지 않고 기록만 남긴다.
 *  - 옮긴 내역은 「율촌 사건」 폴더의 '_LegalTrack 동기화 기록' 시트에 남는다.
 */

const DATA_URL = 'https://api.github.com/repos/kjsh1028/Legaltrack/contents/legaltrack-data.json?ref=main';
const ROOT_FOLDER_ID = '1R8OuQyYo2OkfWQlF7t7GnnHTjKHIR_5l'; // 율촌 사건

// LegalTrack 상태 → 드라이브 상태 폴더
const STATUS_FOLDERS = {
  prospect: '1PuOSytg87_XffOQNW-aC2OryGfOOpwdR', // 10_수임준비
  active:   '1HFCHlu3ioJy2DovuV3jIIAsISaGVYHq5', // 20_진행중
  closed:   '1v6YKg5uXef12RnX61koRvUdSqLj5U11q', // 30_클로징
  failed:   '12ZmzHfILWZBruTU-b16K9_2T5A0EGQa9', // 40_수임실패
  hold:     '1avb0Wlw_xFlLO1zsvo2GW64OB_jSJ9Rl', // 50_보류·장기중단
};
const STATUS_FOLDER_IDS = new Set(Object.values(STATUS_FOLDERS));

/* ── 설치·관리 ── */

function setup() {
  removeTriggers();
  ScriptApp.newTrigger('syncLegalTrackFolders').timeBased()
    .everyDays(1).atHour(3).inTimezone('Asia/Shanghai').create();
  getKey_();
  syncLegalTrackFolders();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncLegalTrackFolders')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** 앱 설정에 붙여 넣을 주소를 실행 로그에 출력 (웹 앱 배포 후 실행) */
function showAppLink() {
  const url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log('먼저 웹 앱으로 배포하세요 (배포 → 새 배포 → 웹 앱).'); return; }
  Logger.log('앱 설정 「드라이브 동기화 주소」에 붙여 넣을 주소:\n' + url + '?key=' + getKey_());
  if (/\/dev$/.test(url)) Logger.log('※ 주소가 /dev로 끝나면, 배포 관리 화면의 /exec 주소 뒤에 ?key=' + getKey_() + ' 를 붙여 쓰세요.');
}

function getKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('SYNC_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SYNC_KEY', key);
  }
  return key;
}

/* ── 1) 앱에서 상태를 바꾸면 즉시 호출되는 웹 앱 ──
 * GET ...?key=비밀키&items=폴더ID:상태,폴더ID:상태 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== getKey_()) return json_({ error: '키가 맞지 않습니다' });
  const moved = [], rows = [];
  String(p.items || '').split(',').filter(Boolean).forEach(it => {
    const [folderId, status] = it.split(':');
    const target = STATUS_FOLDERS[status];
    if (!folderId || !target) return;
    const r = moveIfNeeded_(folderId, target);
    if (r) { moved.push(r.folderName + ' → ' + r.destName); rows.push(['이동(앱)', '', r.folderName, '→ ' + r.destName]); }
  });
  if (rows.length) log_(rows);
  return json_({ ok: true, moved: moved });
}

/* ── 2) 하루 1회 전체 점검 ── */
function syncLegalTrackFolders() {
  const res = UrlFetchApp.fetch(DATA_URL, {
    headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'legaltrack-drive-sync' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    log_([['오류', '', '', 'GitHub 데이터 읽기 실패: HTTP ' + res.getResponseCode()]]);
    return;
  }
  const data = JSON.parse(res.getContentText('UTF-8'));

  const byFolder = {};
  (data.matters || []).forEach(m => {
    const target = STATUS_FOLDERS[m.status];
    if (!target) return; // internal 등은 제외
    const id = folderIdOf_(m.driveLink);
    if (!id) return;
    (byFolder[id] = byFolder[id] || []).push({ name: m.name, status: m.status, target: target });
  });

  const rows = [];
  Object.keys(byFolder).forEach(folderId => {
    const list = byFolder[folderId];
    const targets = [...new Set(list.map(x => x.target))];
    const names = list.map(x => x.name).join(' / ');
    if (targets.length > 1) {
      rows.push(['건너뜀', names, '', '같은 폴더에 상태가 다른 사건이 연결됨: ' + list.map(x => x.status).join(', ')]);
      return;
    }
    const r = moveIfNeeded_(folderId, targets[0]);
    if (r) rows.push(['이동(정기)', names, r.folderName, '→ ' + r.destName]);
  });
  if (rows.length) log_(rows);
}

/* ── 공통 ── */

function folderIdOf_(link) {
  const g = /folders\/([\w-]+)/.exec(link || '') || /[?&]id=([\w-]+)/.exec(link || '');
  return g ? g[1] : null;
}

/** 상태 폴더 안에 있고 위치가 다르면 옮긴다. 옮겼으면 {folderName, destName} 반환 */
function moveIfNeeded_(folderId, targetId) {
  let folder;
  try { folder = DriveApp.getFolderById(folderId); } catch (e) { return null; }
  if (folder.isTrashed()) return null;
  const parents = folder.getParents(), parentIds = [];
  while (parents.hasNext()) parentIds.push(parents.next().getId());
  if (!parentIds.some(id => STATUS_FOLDER_IDS.has(id))) return null; // 상태 폴더 밖이면 건드리지 않음
  if (parentIds.includes(targetId)) return null; // 이미 맞는 위치
  const dest = DriveApp.getFolderById(targetId);
  folder.moveTo(dest);
  return { folderName: folder.getName(), destName: dest.getName() };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function log_(rows) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('LOG_SHEET_ID');
  let ss = null;
  try { if (id) ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  if (!ss) {
    ss = SpreadsheetApp.create('_LegalTrack 동기화 기록');
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(ROOT_FOLDER_ID));
    ss.getSheets()[0].appendRow(['일시', '결과', '사건', '폴더', '내용']);
    props.setProperty('LOG_SHEET_ID', ss.getId());
  }
  const sh = ss.getSheets()[0];
  const now = Utilities.formatDate(new Date(), 'Asia/Shanghai', 'yyyy-MM-dd HH:mm');
  rows.forEach(r => sh.appendRow([now].concat(r)));
}
