/**
 * LegalTrack → 구글 드라이브 「율촌 사건」 폴더 자동 정리
 *
 * LegalTrack 데이터(GitHub의 legaltrack-data.json)에서 사건마다
 * 상태와 드라이브 폴더 링크(driveLink)를 읽고, 폴더가 상태와 다른
 * 위치에 있으면 맞는 상태 폴더로 옮긴다.
 *
 * 처음 한 번: setup 함수를 실행 → 권한 허용
 *   (매일 새벽 3시(상해 시간)에 자동 실행되도록 등록하고 바로 한 번 동기화함)
 * 중지하려면: removeTriggers 함수 실행
 *
 * 안전장치
 *  - 폴더 이름은 바꾸지 않고 위치만 옮긴다.
 *  - 지금 아래 5개 상태 폴더 중 한 곳에 있는 폴더만 옮긴다
 *    (다른 곳에 있는 폴더는 건드리지 않음).
 *  - 같은 폴더에 상태가 서로 다른 사건이 연결되어 있으면 옮기지 않고 기록만 남긴다.
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

function setup() {
  removeTriggers();
  ScriptApp.newTrigger('syncLegalTrackFolders').timeBased()
    .everyDays(1).atHour(3).inTimezone('Asia/Shanghai').create();
  syncLegalTrackFolders();
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncLegalTrackFolders')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

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
  const statusFolderIds = new Set(Object.values(STATUS_FOLDERS));

  // 폴더별로 연결된 사건과 목표 상태 모으기
  const byFolder = {};
  (data.matters || []).forEach(m => {
    const target = STATUS_FOLDERS[m.status];
    if (!target) return; // internal 등은 제외
    const g = /folders\/([\w-]+)/.exec(m.driveLink || '') || /[?&]id=([\w-]+)/.exec(m.driveLink || '');
    if (!g) return;
    (byFolder[g[1]] = byFolder[g[1]] || []).push({ name: m.name, status: m.status, target });
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
    let folder;
    try { folder = DriveApp.getFolderById(folderId); }
    catch (e) { rows.push(['건너뜀', names, '', '폴더를 찾을 수 없음']); return; }
    if (folder.isTrashed()) return;

    const parents = folder.getParents();
    const parentIds = [];
    while (parents.hasNext()) parentIds.push(parents.next().getId());
    if (!parentIds.some(id => statusFolderIds.has(id))) return; // 상태 폴더 밖이면 건드리지 않음
    if (parentIds.includes(targets[0])) return; // 이미 맞는 위치

    const dest = DriveApp.getFolderById(targets[0]);
    folder.moveTo(dest);
    rows.push(['이동', names, folder.getName(), '→ ' + dest.getName()]);
  });

  if (rows.length) log_(rows);
}

function log_(rows) {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('LOG_SHEET_ID');
  let ss;
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
