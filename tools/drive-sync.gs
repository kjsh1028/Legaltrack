/**
 * LegalTrack → 구글 드라이브 「율촌 사건」 폴더 자동 정리
 *
 * 1) 즉시 정리: LegalTrack 앱에서 사건 상태를 바꿔 저장하면, 앱이 이 스크립트의
 *    웹 앱 주소를 불러 해당 사건 폴더를 바로 맞는 상태 폴더로 옮긴다.
 * 2) 하루 1회 점검: 매일 새벽 3시(상해 시간)에 전체 사건을 다시 대조한다
 *    (앱 밖에서 바뀐 것까지 맞춤).
 * 3) 드라이브 정리 작업함: 매일 새벽 3시 40분(상해 시간)에 GitHub의 tools/drive-ops.json을 읽어,
 *    아직 안 한 작업(폴더 만들기·옮기기·이름 바꾸기·휴지통)을 실행한다. 바로 반영하려면 runDriveOps를 직접 실행.
 *    휴지통은 30일 안에 되살릴 수 있고, 영구 삭제는 하지 않는다. (2)의 '이름은 바꾸지 않음' 원칙은 자동 정리에만 해당)
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

const DATA_URL = 'https://raw.githubusercontent.com/kjsh1028/Legaltrack/main/legaltrack-data.json';
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
  ScriptApp.newTrigger('runDriveOps').timeBased()
    .everyDays(1).atHour(3).nearMinute(40).inTimezone('Asia/Shanghai').create();
  getKey_();
  syncLegalTrackFolders();
  runDriveOps();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncLegalTrackFolders' || t.getHandlerFunction() === 'runDriveOps')
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
  const res = UrlFetchApp.fetch(DATA_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
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


/* ── 3) 드라이브 정리 작업함 (tools/drive-ops.json) ──
 * 형식: {"ops":[
 *   {"id":"고유번호", "op":"mkdir",  "parent":"폴더ID", "name":"새 폴더 이름"},
 *   {"id":"고유번호", "op":"move",   "target":"파일/폴더ID", "to":"폴더ID", "name":"(선택) 새 이름"},
 *   {"id":"고유번호", "op":"rename", "target":"파일/폴더ID", "name":"새 이름"},
 *   {"id":"고유번호", "op":"trash",  "target":"파일/폴더ID"} ]}
 * 한 번 실행한 id는 다시 실행하지 않는다. 결과는 '_LegalTrack 동기화 기록' 시트에 남는다.
 * 안전장치: 본인 소유 항목만 다루고, 지우기는 휴지통 보내기만 한다.
 */
const OPS_URL = 'https://raw.githubusercontent.com/kjsh1028/Legaltrack/main/tools/drive-ops.json';

function runDriveOps() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const res = UrlFetchApp.fetch(OPS_URL + '?t=' + Date.now(), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { log_([['오류', '', 'drive-ops.json', 'HTTP ' + res.getResponseCode()]]); return; }
    const ops = (JSON.parse(res.getContentText('UTF-8')).ops) || [];
    const props = PropertiesService.getScriptProperties();
    const done = JSON.parse(props.getProperty('DONE_OPS') || '[]');
    const me = Session.getEffectiveUser().getEmail();
    const rows = [];
    ops.forEach(o => {
      if (!o || !o.id || done.indexOf(o.id) >= 0) return;
      try {
        rows.push(doOp_(o, me));
      } catch (e) {
        rows.push(['오류', o.id + ' ' + o.op, e.message]);
      }
      done.push(o.id);
    });
    if (rows.length) {
      props.setProperty('DONE_OPS', JSON.stringify(done.slice(-500)));
      rows.forEach(r => Logger.log(r.join(' | ')));
      // 기록 시트 열: 결과 | 사건 | 폴더 | 내용  (작업함은 사건 칸을 비운다)
      log_(rows.map(r => [r[0], '', r[1], r[2]]));
    } else {
      Logger.log('새 작업 없음');
    }
  } finally {
    lock.releaseLock();
  }
}

function item_(id) {
  try { return DriveApp.getFolderById(id); } catch (e) { return DriveApp.getFileById(id); }
}

function doOp_(o, me) {
  if (o.op === 'mkdir') {
    const parent = DriveApp.getFolderById(o.parent);
    const it = parent.getFoldersByName(o.name);
    if (it.hasNext()) return ['건너뜀', o.id + ' ' + o.name, '이미 있음 (' + it.next().getId() + ')'];
    const f = parent.createFolder(o.name);
    return ['폴더 만듦', o.id + ' ' + o.name, parent.getName() + ' 안 (' + f.getId() + ')'];
  }
  const t = item_(o.target);
  const owner = t.getOwner();
  if (owner && owner.getEmail() !== me) return ['건너뜀', o.id + ' ' + t.getName(), '본인 소유가 아님'];
  const before = t.getName();
  if (o.op === 'move') {
    const dest = DriveApp.getFolderById(o.to);
    t.moveTo(dest);
    if (o.name && o.name !== before) t.setName(o.name);
    return ['이동', o.id + ' ' + before, '→ ' + dest.getName() + (o.name && o.name !== before ? ' / 이름: ' + o.name : '')];
  }
  if (o.op === 'rename') {
    t.setName(o.name);
    return ['이름 변경', o.id + ' ' + before, '→ ' + o.name];
  }
  if (o.op === 'trash') {
    t.setTrashed(true);
    return ['휴지통', o.id + ' ' + before, '30일 안에 되살릴 수 있음'];
  }
  return ['건너뜀', o.id, '알 수 없는 작업: ' + o.op];
}
